import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  SerialAlreadyInStockError,
  SerialCountError,
  SerialDisabledError,
  SerialDuplicateError,
  SerialNotFoundError,
  SerialNotTrackedError,
  SerialRequiredError,
  SerialStockError,
} from '../errors.js';
import { QTY_EPS, quantizeQty, resolveBatch, resolveLocation } from './inventory-policy.js';
import { assertLooseEnough, lpnEnabled } from './lpn-policy.js';

/** 序列号模块开着。缺模块或 enabled 不是 true 都算关。 */
export function serialEnabled(ws: WmsWorkspace): boolean {
  return ws.profile.getSnapshot().modules['module.serial']?.enabled === true;
}

export function assertSerialEnabled(ws: WmsWorkspace): void {
  if (!serialEnabled(ws)) throw new SerialDisabledError();
}

/** 模块关闭时，只要带了 serials 这个键（含空数组）就拒绝，不能当没看见。 */
export function rejectSerialKeyWhenOff(ws: WmsWorkspace, record: object | undefined): void {
  if (serialEnabled(ws) || !record) return;
  if (Object.hasOwn(record, 'serials')) throw new SerialDisabledError();
}

export function rejectSerialLinesWhenOff(ws: WmsWorkspace, lines: unknown): void {
  if (serialEnabled(ws) || !Array.isArray(lines)) return;
  for (const line of lines) {
    if (line && typeof line === 'object' && Object.hasOwn(line, 'serials')) throw new SerialDisabledError();
  }
}

/** 模块关闭时，只要带了 serialTracked 这个键就拒绝。 */
export function rejectSerialTrackedWhenOff(ws: WmsWorkspace, params: object): void {
  if (!serialEnabled(ws) && Object.hasOwn(params, 'serialTracked')) throw new SerialDisabledError();
}

export type SerialPlan =
  | {
      kind: 'receive';
      serialId: string;
      serialNo: string;
      skuId: string;
      locationId: string;
      batchNo: string;
    }
  | { kind: 'issue'; serialId: string; serialNo: string }
  | {
      kind: 'move';
      serialId: string;
      serialNo: string;
      locationId: string;
      batchNo: string;
      setLpn: boolean;
      lpnId: string | null;
    };

export function appendSerialPlans(ctx: ToolContext, plans: readonly SerialPlan[]): void {
  for (const plan of plans) {
    if (plan.kind === 'receive') {
      ctx.appendEvent(WMS_EVENT_TYPES.serialReceived, {
        serialId: plan.serialId,
        serialNo: plan.serialNo,
        skuId: plan.skuId,
        locationId: plan.locationId,
        batchNo: plan.batchNo,
      });
    } else if (plan.kind === 'issue') {
      ctx.appendEvent(WMS_EVENT_TYPES.serialIssued, {
        serialId: plan.serialId,
        serialNo: plan.serialNo,
      });
    } else {
      ctx.appendEvent(WMS_EVENT_TYPES.serialMoved, {
        serialId: plan.serialId,
        serialNo: plan.serialNo,
        locationId: plan.locationId,
        batchNo: plan.batchNo,
        ...(plan.setLpn ? { lpnId: plan.lpnId } : {}),
      });
    }
  }
}

export function parseSerials(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('TOOL_REJECTED: serials 不能为空');
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('TOOL_REJECTED: serials 每项必须是字符串');
    const serialNo = item.trim();
    if (!serialNo) throw new Error('TOOL_REJECTED: 序列号不能为空');
    if (seen.has(serialNo)) throw new SerialDuplicateError(serialNo);
    seen.add(serialNo);
    out.push(serialNo);
  }
  return out;
}

/** 有序列号时：必须是整数，且个数等于件数。 */
export function requireSerialList(skuCode: string, quantity: number, raw: unknown): string[] {
  const rough = Array.isArray(raw) ? raw.length : 0;
  const qty = quantizeQty(Math.abs(quantity));
  const whole = Math.round(qty);
  if (Math.abs(qty - whole) > QTY_EPS) throw new SerialCountError(skuCode, quantity, rough);
  const serials = parseSerials(raw);
  if (serials.length !== whole) throw new SerialCountError(skuCode, quantity, serials.length);
  return serials;
}

export function assertCanTrack(ws: WmsWorkspace, skuId: string, skuCode: string, next: boolean): void {
  if (next) {
    if (ws.inventory.totalOf(skuId) > QTY_EPS) {
      throw new SerialStockError(`SKU ${skuCode} 已经有库存，不能再改成按序列号管理`);
    }
    return;
  }
  if (ws.serials.list({ skuId, status: 'in' }).length > 0) {
    throw new SerialStockError(`SKU ${skuCode} 还有在库序列号，不能取消按序列号管理`);
  }
}

interface BucketSerial {
  serialNo: string;
  skuId: string;
  locationId: string;
  batchNo: string;
  exceptOrderId?: string;
  allowPacked?: boolean;
  requireLpnId?: string;
}

function claimedSerials(ws: WmsWorkspace, exceptOrderId?: string): Set<string> {
  const claimed = new Set<string>();
  for (const order of ws.orders.list()) {
    if (order.id === exceptOrderId) continue;
    const openIn = order.direction === 'in' && (order.state === 'created' || order.state === 'announced');
    const openOut = order.direction === 'out' && (order.state === 'created' || order.state === 'picking');
    if (!openIn && !openOut) continue;
    for (const line of ws.orders.lines(order.id)) {
      for (const serialNo of line.serials ?? []) claimed.add(serialNo);
    }
  }
  return claimed;
}

function claimError(serialNo: string): SerialStockError {
  return new SerialStockError(`序列号已被未完成的单据占用: ${serialNo}`);
}

function onPalletError(serialNo: string): SerialStockError {
  return new SerialStockError(`序列号在托盘上，请整托移动或先卸下: ${serialNo}`);
}

function remember(seen: Set<string>, serialNo: string): void {
  if (seen.has(serialNo)) throw new SerialDuplicateError(serialNo);
  seen.add(serialNo);
}

export function planReceive(ws: WmsWorkspace, opts: BucketSerial): SerialPlan {
  const existing = ws.serials.byNo(opts.serialNo);
  if (existing?.status === 'in') throw new SerialAlreadyInStockError(opts.serialNo);
  if (claimedSerials(ws, opts.exceptOrderId).has(opts.serialNo)) throw claimError(opts.serialNo);
  return {
    kind: 'receive',
    serialId: existing?.id ?? randomUUID(),
    serialNo: opts.serialNo,
    skuId: opts.skuId,
    locationId: opts.locationId,
    batchNo: opts.batchNo,
  };
}

export function planIssue(ws: WmsWorkspace, opts: BucketSerial): SerialPlan {
  const existing = ws.serials.byNo(opts.serialNo);
  if (
    !existing ||
    existing.status !== 'in' ||
    existing.skuId !== opts.skuId ||
    existing.locationId !== opts.locationId ||
    existing.batchNo !== opts.batchNo
  ) {
    throw new SerialNotFoundError(opts.serialNo);
  }
  if (opts.requireLpnId !== undefined && existing.lpnId !== opts.requireLpnId) {
    throw new SerialStockError(`序列号不在这个托盘上: ${opts.serialNo}`);
  }
  if (lpnEnabled(ws) && existing.lpnId && !opts.allowPacked) throw onPalletError(opts.serialNo);
  if (claimedSerials(ws, opts.exceptOrderId).has(opts.serialNo)) throw claimError(opts.serialNo);
  return { kind: 'issue', serialId: existing.id, serialNo: existing.serialNo };
}

export function planMove(
  ws: WmsWorkspace,
  opts: BucketSerial & {
    toLocationId: string;
    toBatchNo: string;
    setLpn?: boolean;
    lpnId?: string | null;
  },
): SerialPlan {
  const existing = ws.serials.byNo(opts.serialNo);
  if (
    !existing ||
    existing.status !== 'in' ||
    existing.skuId !== opts.skuId ||
    existing.locationId !== opts.locationId ||
    existing.batchNo !== opts.batchNo
  ) {
    throw new SerialNotFoundError(opts.serialNo);
  }
  if (opts.requireLpnId !== undefined && existing.lpnId !== opts.requireLpnId) {
    throw new SerialStockError(`序列号不在这个托盘上: ${opts.serialNo}`);
  }
  if (lpnEnabled(ws) && existing.lpnId && !opts.allowPacked) throw onPalletError(opts.serialNo);
  if (claimedSerials(ws, opts.exceptOrderId).has(opts.serialNo)) throw claimError(opts.serialNo);
  return {
    kind: 'move',
    serialId: existing.id,
    serialNo: existing.serialNo,
    locationId: opts.toLocationId,
    batchNo: opts.toBatchNo,
    setLpn: opts.setLpn === true,
    lpnId: opts.lpnId ?? null,
  };
}

export function planSerialList(
  ws: WmsWorkspace,
  kind: 'receive' | 'issue' | 'move',
  serials: readonly string[],
  opts: Omit<BucketSerial, 'serialNo'> & {
    toLocationId?: string;
    toBatchNo?: string;
    setLpn?: boolean;
    lpnId?: string | null;
  },
): SerialPlan[] {
  const seen = new Set<string>();
  return serials.map((serialNo) => {
    remember(seen, serialNo);
    if (kind === 'receive') return planReceive(ws, { ...opts, serialNo });
    if (kind === 'issue') return planIssue(ws, { ...opts, serialNo });
    return planMove(ws, {
      ...opts,
      serialNo,
      toLocationId: opts.toLocationId ?? opts.locationId,
      toBatchNo: opts.toBatchNo ?? opts.batchNo,
    });
  });
}

interface OrderLineInput {
  skuCode: string;
  quantity: number;
  locationCode?: string;
  batchNo?: string;
  batchExpiryDate?: string;
  serials?: string[];
}

/**
 * 建单前把序列号整理到行上。
 * 按序列号管理的出库行不能交给 fifo/fefo 拆开，否则同一个号会被抄到每一段上。
 */
export function prepareOrderLineSerials(
  ws: WmsWorkspace,
  direction: 'in' | 'out',
  lines: OrderLineInput[],
  effective: 'strict' | 'fifo' | 'fefo',
): void {
  if (!serialEnabled(ws)) return;
  const seen = new Set<string>();
  const inboundClaims = direction === 'in' ? claimedSerials(ws) : undefined;
  const outboundClaims = direction === 'out' ? claimedSerials(ws) : undefined;
  for (const [i, line] of lines.entries()) {
    if (!line || typeof line.skuCode !== 'string' || !line.skuCode) {
      if (line && Object.hasOwn(line, 'serials')) {
        throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
      }
      continue;
    }
    const sku = ws.skus.byCode(line.skuCode);
    if (!sku) continue;
    const hasSerials = Object.hasOwn(line, 'serials');
    if (!sku.serialTracked) {
      if (hasSerials) throw new SerialNotTrackedError(sku.skuCode);
      continue;
    }
    if (!line.batchNo && effective !== 'strict') {
      throw new SerialStockError(`SKU ${sku.skuCode} 按序列号管理，不能按策略拆到多个批次。请指定批次`);
    }
    const qty = quantizeQty(Math.abs(line.quantity));
    const whole = Math.round(qty);
    if (!Number.isFinite(line.quantity) || Math.abs(qty - whole) > QTY_EPS) {
      throw new SerialCountError(sku.skuCode, line.quantity, Array.isArray(line.serials) ? line.serials.length : 0);
    }
    if (!hasSerials) throw new SerialRequiredError(sku.skuCode);
    const serials = requireSerialList(sku.skuCode, line.quantity, line.serials);
    const loc = resolveLocation(ws, line.locationCode);
    const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
    for (const serialNo of serials) {
      remember(seen, serialNo);
      if (direction === 'in') {
        const existing = ws.serials.byNo(serialNo);
        if (existing?.status === 'in') throw new SerialAlreadyInStockError(serialNo);
        if (inboundClaims?.has(serialNo)) throw claimError(serialNo);
      } else {
        const existing = ws.serials.byNo(serialNo);
        if (
          !existing ||
          existing.status !== 'in' ||
          existing.skuId !== sku.id ||
          existing.locationId !== loc.locationId ||
          existing.batchNo !== batch.batchNo
        ) {
          throw new SerialNotFoundError(serialNo);
        }
        if (lpnEnabled(ws) && existing.lpnId) throw onPalletError(serialNo);
        if (outboundClaims?.has(serialNo)) throw claimError(serialNo);
      }
    }
    line.serials = serials;
  }
}

export function planOrderSerials(
  ws: WmsWorkspace,
  orderId: string,
  post: 'increase' | 'decrease',
  orderLines: readonly {
    skuId: string;
    locationId: string;
    batchNo: string;
    serials?: readonly string[];
  }[],
  posted: readonly { skuId: string; locationId: string; batchNo: string; move: number }[],
): SerialPlan[] {
  if (!serialEnabled(ws)) return [];
  const plans: SerialPlan[] = [];
  const seen = new Set<string>();
  for (const line of orderLines) {
    const sku = ws.skus.byId(line.skuId);
    if (!sku?.serialTracked) continue;
    const hit = posted.find(
      (row) => row.skuId === line.skuId && row.locationId === line.locationId && row.batchNo === line.batchNo,
    );
    const move = hit?.move ?? 0;
    if (!line.serials?.length) {
      const qty = quantizeQty(Math.abs(move));
      if (Math.abs(qty - Math.round(qty)) > QTY_EPS) throw new SerialCountError(sku.skuCode, move, 0);
      throw new SerialRequiredError(sku.skuCode);
    }
    const serials = requireSerialList(sku.skuCode, move, line.serials);
    for (const serialNo of serials) {
      remember(seen, serialNo);
      const bucket = {
        serialNo,
        skuId: line.skuId,
        locationId: line.locationId,
        batchNo: line.batchNo,
        exceptOrderId: orderId,
      };
      plans.push(post === 'increase' ? planReceive(ws, bucket) : planIssue(ws, bucket));
    }
  }
  return plans;
}

export function planPutawaySerials(
  ws: WmsWorkspace,
  moves: readonly {
    skuId: string;
    skuCode: string;
    fromLocationId: string;
    toLocationId: string;
    batchNo: string;
    quantity: number;
    serials?: readonly string[];
  }[],
): SerialPlan[] {
  if (!serialEnabled(ws)) return [];
  const tracked = moves.filter((move) => ws.skus.byId(move.skuId)?.serialTracked);
  const keys = tracked.map((move) => `${move.skuId}:${move.fromLocationId}:${move.batchNo}`);
  if (new Set(keys).size !== keys.length) {
    throw new SerialStockError('按序列号管理的行不能拆到多个库位');
  }
  const plans: SerialPlan[] = [];
  const seen = new Set<string>();
  for (const move of tracked) {
    if (!move.serials?.length) throw new SerialRequiredError(move.skuCode);
    if (move.serials.length !== quantizeQty(move.quantity)) {
      throw new SerialStockError(`SKU ${move.skuCode} 按序列号管理，上架必须整行移动`);
    }
    const serials = requireSerialList(move.skuCode, move.quantity, move.serials);
    for (const serialNo of serials) {
      remember(seen, serialNo);
      plans.push(
        planMove(ws, {
          serialNo,
          skuId: move.skuId,
          locationId: move.fromLocationId,
          batchNo: move.batchNo,
          toLocationId: move.toLocationId,
          toBatchNo: move.batchNo,
        }),
      );
    }
  }
  return plans;
}

export function planPickingSerials(
  ws: WmsWorkspace,
  lines: readonly {
    orderId: string;
    orderLineId: string;
    skuId: string;
    pickedQty: number;
    pickedLocationId: string | null;
    suggestedLocationId: string;
    pickedBatchNo: string | null;
    suggestedBatchNo: string;
  }[],
): SerialPlan[] {
  if (!serialEnabled(ws)) return [];
  const plans: SerialPlan[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const sku = ws.skus.byId(line.skuId);
    if (!sku?.serialTracked) continue;
    const locationId = line.pickedLocationId ?? line.suggestedLocationId;
    const batchNo = line.pickedBatchNo ?? line.suggestedBatchNo;
    const orderLine = ws.orders.lines(line.orderId).find(
      (row) => `${line.orderId}:${row.skuId}:${row.locationId}:${row.batchNo}` === line.orderLineId,
    );
    if (!orderLine || orderLine.locationId !== locationId || orderLine.batchNo !== batchNo) {
      throw new SerialStockError(`序列号必须从单据指定的库位批次拣出: ${sku.skuCode}`);
    }
    if (!orderLine.serials?.length) throw new SerialRequiredError(sku.skuCode);
    const serials = requireSerialList(sku.skuCode, line.pickedQty, orderLine.serials);
    for (const serialNo of serials) {
      remember(seen, serialNo);
      plans.push(
        planIssue(ws, {
          serialNo,
          skuId: line.skuId,
          locationId,
          batchNo,
          exceptOrderId: line.orderId,
        }),
      );
    }
  }
  return plans;
}

export function assertStocktakeLines(
  ws: WmsWorkspace,
  diffs: readonly {
    skuId: string;
    skuCode: string;
    locationId: string;
    locationCode: string;
    batchNo: string;
    delta: number;
    bookQty: number;
  }[],
): void {
  for (const diff of diffs) {
    if (Math.abs(diff.delta) <= QTY_EPS) continue;
    if (serialEnabled(ws) && ws.skus.byId(diff.skuId)?.serialTracked) {
      throw new SerialStockError(`SKU ${diff.skuCode} 按序列号管理，不能用盘点改数量。请用库存调整并写上序列号`);
    }
    if (diff.delta < -QTY_EPS) {
      assertLooseEnough(ws, {
        skuCode: diff.skuCode,
        skuId: diff.skuId,
        locationId: diff.locationId,
        locationCode: diff.locationCode,
        batchNo: diff.batchNo,
        take: quantizeQty(-diff.delta),
        onHand: diff.bookQty,
      });
    }
  }
}

/** 调整/移库：模块开着且 SKU 按序列号管理时，整理出要写的序列号事件。 */
export function planQuantitySerials(
  ws: WmsWorkspace,
  args: {
    skuId: string;
    skuCode: string;
    serialTracked: boolean;
    hasSerials: boolean;
    serials: unknown;
    quantity: number;
    locationId: string;
    batchNo: string;
    direction: 'receive' | 'issue' | 'move';
    toLocationId?: string;
    toBatchNo?: string;
    allowPacked?: boolean;
    setLpn?: boolean;
    lpnId?: string | null;
    requireLpnId?: string;
    exceptOrderId?: string;
  },
): SerialPlan[] {
  if (!serialEnabled(ws)) return [];
  if (!args.serialTracked) {
    if (args.hasSerials) throw new SerialNotTrackedError(args.skuCode);
    return [];
  }
  const rough = Array.isArray(args.serials) ? args.serials.length : 0;
  const qty = quantizeQty(Math.abs(args.quantity));
  if (Math.abs(qty - Math.round(qty)) > QTY_EPS) throw new SerialCountError(args.skuCode, args.quantity, rough);
  if (!args.hasSerials) throw new SerialRequiredError(args.skuCode);
  const serials = requireSerialList(args.skuCode, args.quantity, args.serials);
  return planSerialList(ws, args.direction, serials, {
    skuId: args.skuId,
    locationId: args.locationId,
    batchNo: args.batchNo,
    toLocationId: args.toLocationId,
    toBatchNo: args.toBatchNo,
    allowPacked: args.allowPacked,
    setLpn: args.setLpn,
    lpnId: args.lpnId,
    requireLpnId: args.requireLpnId,
    exceptOrderId: args.exceptOrderId,
  });
}
