import { randomUUID } from 'node:crypto';
import { allocateCode } from '../numbering/allocate.js';
import { orderNumberPlace } from '../numbering/pattern.js';
import { evalWhenCondition, type ToolContext, type ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { DEFAULT_BATCH_NO, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  AsnDirectionError,
  AsnDisabledError,
  AsnExpectedAtError,
  AsnWithReturnError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  LoadRequiredError,
  OrderReviseRejectedError,
  PackRequiredError,
  PickingRequiredError,
  ReviewRequiredError,
  PickingStillOpenError,
  PutawayRequiredError,
  QcRequiredError,
  WaveRequiredError,
  PartialNotOnPostError,
  PartnerKindMismatchError,
  PartnerNotFoundError,
  ReturnAllocationError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';
import { expandAllocatedLines } from '../state/batch-allocation.js';
import { resolveTransitionEffect } from '../state/inventory-effect.js';
import { assertOnHand, assertOutboundBuckets } from '../state/outbound-guards.js';
import { resolvePostingMoves, type PostingRequest } from '../state/partial-qty.js';
import { assertReturnLines, postedBucketsForReturn } from '../state/return-qty.js';
import { planReservationReleases, planReservations } from '../state/reservation.js';
import {
  assertExpiryConsistent,
  assertNonNegativeQty,
  assertPositiveQty,
  codeOfLocation,
  quantizeQty,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { orderEditPolicy } from '../state/order-edit-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
  type OrderDirection,
} from '../state/order-state-machine.js';
import { withOrderLines } from '../queries/order-queries.js';
import {
  appendSerialPlans,
  planOrderSerials,
  prepareOrderLineSerials,
  rejectSerialLinesWhenOff,
} from '../state/serial-policy.js';
import { def, type WorkspaceResolver } from './tool-def.js';

export interface OrderTransitionResult {
  orderNo: string;
  from: string;
  to: string;
  adjustedLines?: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
}

function moduleOn(snapshot: { modules: Record<string, { enabled?: boolean } | undefined> }, id: string): boolean {
  return snapshot.modules[id]?.enabled === true;
}

/**
 * 质检、波次、拣货、复核、打包、装车开着时不能跳过。
 * 拣货关单自己写出库事件，不经过这里。
 */
function assertStageRequired(
  snapshot: { modules: Record<string, { enabled?: boolean } | undefined> },
  order: { direction: string; state: string; orderNo: string },
  to: string,
): void {
  if (to === 'canceled') return;
  if (order.direction === 'in' && moduleOn(snapshot, 'module.qc') && order.state === 'received' && to !== 'inspected') {
    throw new QcRequiredError(order.orderNo);
  }
  if (
    order.direction === 'in' &&
    moduleOn(snapshot, 'module.putaway') &&
    (order.state === 'received' || order.state === 'inspected') &&
    to === 'done'
  ) {
    throw new PutawayRequiredError(order.orderNo);
  }
  if (order.direction === 'out' && moduleOn(snapshot, 'module.wave') && order.state === 'created' && to !== 'waved') {
    throw new WaveRequiredError(order.orderNo);
  }
  const pastPick =
    order.state === 'picked' ||
    order.state === 'reviewed' ||
    order.state === 'packed' ||
    order.state === 'loaded' ||
    order.state === 'shipped';
  if (order.direction === 'out' && moduleOn(snapshot, 'module.picking')) {
    const skipPick = !pastPick && to !== 'picking' && to !== 'waved';
    const skipShip = to === 'done' && order.state !== 'shipped';
    if (skipPick || skipShip || to === 'picked') throw new PickingRequiredError(order.orderNo);
  }
  const reviewFrom = !moduleOn(snapshot, 'module.review')
    ? null
    : moduleOn(snapshot, 'module.picking')
      ? 'picked'
      : moduleOn(snapshot, 'module.wave')
        ? 'waved'
        : 'created';
  if (order.direction === 'out' && reviewFrom && order.state === reviewFrom && to !== 'reviewed') {
    throw new ReviewRequiredError(order.orderNo);
  }
  const packFrom = !moduleOn(snapshot, 'module.pack')
    ? null
    : moduleOn(snapshot, 'module.review') || order.state === 'reviewed'
      ? 'reviewed'
      : moduleOn(snapshot, 'module.picking')
        ? 'picked'
        : moduleOn(snapshot, 'module.wave')
          ? 'waved'
          : 'created';
  if (order.direction === 'out' && packFrom && order.state === packFrom && to !== 'packed') {
    throw new PackRequiredError(order.orderNo);
  }
  const loadFrom = !moduleOn(snapshot, 'module.load')
    ? null
    : moduleOn(snapshot, 'module.pack')
      ? 'packed'
      : moduleOn(snapshot, 'module.review') || order.state === 'reviewed'
        ? 'reviewed'
        : moduleOn(snapshot, 'module.picking')
          ? 'picked'
          : moduleOn(snapshot, 'module.wave')
            ? 'waved'
            : 'created';
  if (order.direction === 'out' && loadFrom && order.state === loadFrom && to !== 'loaded') {
    throw new LoadRequiredError(order.orderNo);
  }
}

/**
 * 单据转移的命令实现（工具与冲突接受共用）。
 * 校验失败抛错、零事件。调用方可以包在更大的 runAtomic 里。
 */
export function applyOrderTransition(
  ws: WmsWorkspace,
  ctx: ToolContext,
  params: {
    orderNo: string;
    to: string;
    lines?: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[];
  },
): OrderTransitionResult {
  ws.sync();
  const order = ws.orders.byNo(params.orderNo);
  if (!order) throw new OrderNotFoundError(params.orderNo);
  const snapshot = ws.profile.getSnapshot();
  const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
  if (!workflow) throw new WorkflowNotFoundError(order.direction);
  const activeTransitions = workflow.transitions.filter((t) =>
    evalWhenCondition(t.when, snapshot.modules),
  );
  assertTransition(activeTransitions, order.direction, order.state, params.to);
  const edge = activeTransitions.find((t) => t.from === order.state && t.to === params.to);
  const settings = readWmsSettings(ws);
  let resolved = resolveTransitionEffect(order.direction, params.to, edge?.effect, settings);
  // 拣货关单已经扣过的，后面的发货不再扣第二次。打包、装车本身不带 effect。
  if (
    order.direction === 'out' &&
    params.to === 'shipped' &&
    ws.inventory.movementsByOrder(order.id).some((row) => row.net < 0)
  ) {
    resolved = { checkAvailability: false };
  }
  assertStageRequired(snapshot, order, params.to);
  // 拣货已关掉、但还有未关拣货单时，不能再走直接发货。
  if (order.direction === 'out' && resolved.post === 'decrease') {
    const openPickingNo = ws.pickings.openPickingNoForOrder(order.id);
    if (openPickingNo) throw new PickingStillOpenError(order.orderNo, openPickingNo);
  }
  const requests = resolvePartialRequests(ws, params.lines);
  if (!resolved.post && requests.length > 0) throw new PartialNotOnPostError();

  const lines = ws.orders.lines(order.id);
  const posted = resolved.post
    ? resolvePostingMoves({
        post: resolved.post,
        moduleEnabled: snapshot.modules['module.partial']?.enabled === true,
        lines,
        requests,
      })
    : [];
  const moving = posted.filter((line) => line.move > 0);
  if (resolved.post === 'increase') {
    for (const line of lines) {
      const hit = moving.find(
        (m) => m.skuId === line.skuId && m.locationId === line.locationId && m.batchNo === line.batchNo,
      );
      if (!hit || !line.batchExpiryDate) continue;
      assertExpiryConsistent(
        ws,
        line.skuId,
        ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
        line.batchNo,
        line.batchExpiryDate,
      );
    }
  }
  if (resolved.checkAvailability) {
    const guardLines = resolved.post
      ? moving.map((line) => ({
          skuId: line.skuId,
          locationId: line.locationId,
          batchNo: line.batchNo,
          quantity: line.move,
        }))
      : lines;
    // 出库履约（预检或扣减）走完整守卫；入库冲销只验余量和冻结。只预检时按订单数量。
    if (guardLines.length > 0) {
      // 出库把本单排除在占用之外，发货才不会被自己的拣货占用拦住。
      if (order.direction === 'out') assertOutboundBuckets(ws, guardLines, [order.id]);
      else assertOnHand(ws, guardLines, { expiry: false, hold: true });
    }
  }
  // 发货或取消释放已有占用；只预检的出库转移才新占。两者不会同时发生。
  const leavingCommitment = params.to === 'canceled' || resolved.post === 'decrease';
  const releases = leavingCommitment ? planReservationReleases(ws, order) : [];
  const reserves =
    !leavingCommitment && order.direction === 'out' && resolved.checkAvailability && !resolved.post
      ? planReservations(ws, order, lines)
      : [];
  const serialPlans = resolved.post ? planOrderSerials(ws, order.id, resolved.post, lines, posted) : [];

  const fulfillments = posted
    .filter((line) => line.nextPosted !== undefined)
    .map((line) => ({
      skuId: line.skuId,
      locationId: line.locationId,
      batchNo: line.batchNo,
      quantity: line.nextPosted!,
    }));
  const adjustedLines: OrderTransitionResult['adjustedLines'] = [];
  ws.runAtomic(() => {
    ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
      orderId: order.id,
      orderNo: order.orderNo,
      direction: order.direction,
      from: order.state,
      to: params.to,
      ...(fulfillments.length > 0 ? { fulfillments } : {}),
    });
    if (resolved.post) {
      for (const line of moving) {
        const src = lines.find(
          (row) => row.skuId === line.skuId && row.locationId === line.locationId && row.batchNo === line.batchNo,
        );
        const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
        const locationCode = codeOfLocation(ws, line.locationId);
        const delta = resolved.post === 'increase' ? line.move : -line.move;
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: line.skuId,
          skuCode,
          delta,
          reason: `order:${params.to}`,
          locationId: line.locationId,
          locationCode,
          batchNo: line.batchNo,
          batchExpiryDate: src?.batchExpiryDate ?? undefined,
          orderId: order.id,
          orderNo: order.orderNo,
        });
        adjustedLines!.push({ skuCode, locationCode, batchNo: line.batchNo, delta });
      }
      appendSerialPlans(ctx, serialPlans);
    }
    for (const release of releases) {
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryReservationReleased, release);
    }
    for (const reserve of reserves) {
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryReserved, reserve);
    }
  });
  ws.sync();
  return {
    orderNo: order.orderNo,
    from: order.state,
    to: params.to,
    adjustedLines: adjustedLines!.length > 0 ? adjustedLines : undefined,
  };
}

/** 把调用方的实收/实发解析成行键。空数组视为没传。 */
function resolvePartialRequests(
  ws: WmsWorkspace,
  raw: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[] | undefined,
): PostingRequest[] {
  if (!raw?.length) return [];
  return raw.map((line, i) => {
    if (typeof line?.skuCode !== 'string' || !line.skuCode) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 条实收/实发缺少 skuCode`);
    }
    const quantity = assertNonNegativeQty(line.quantity, `第 ${i + 1} 条实收/实发数量`);
    const sku = ws.skus.byCode(line.skuCode);
    if (!sku) throw new SkuNotFoundError(line.skuCode);
    const location = resolveLocation(ws, line.locationCode);
    const batchNo = !line.batchNo || line.batchNo === DEFAULT_BATCH_NO ? DEFAULT_BATCH_NO : line.batchNo;
    return { skuId: sku.id, locationId: location.locationId, batchNo, quantity };
  });
}

/** 预计到货日：真实的 YYYY-MM-DD。空串由调用方事先排除。 */
function assertExpectedAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AsnExpectedAtError(value);
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AsnExpectedAtError(value);
  }
}

export function createOrderTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const orderCreate: ToolDefinition<{
    direction: OrderDirection;
    lines: {
      skuCode: string;
      quantity: number;
      locationCode?: string;
      batchNo?: string;
      batchExpiryDate?: string;
      serials?: string[];
    }[];
    orderNo?: string;
    note?: string;
    /** 往来单位编码（M21，可选）：入库单=供应商 / 出库单=客户 */
    partnerCode?: string;
    /** 原单号（module.return）。客退指向出库单，退供指向入库单 */
    returnOf?: string;
    /** 到货预报（module.asn）。true = 入库单从已预报起步，收货前不加库存 */
    asn?: boolean;
    /** 预计到货日 YYYY-MM-DD，仅预报单 */
    expectedAt?: string;
  }> = {
    id: 'wms.order.create',
    label: '创建出入库单',
    description:
      '创建一张入库单或出库单。direction 取 in（入库）/ out（出库）；lines 是商品明细（SKU 编码 + 数量 + 可选库位编码 + 可选批次编码，数量必须是正数，支持 3 位小数——散装/称重场景，如 0.5 表示半斤）。行上的 locationCode 指定收货上架/发货扣减的库位（缺省为默认库位 DEFAULT）；batchNo 指定批次（缺省为虚拟批次 DEFAULT）：入库行声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致）。出库行写了批次就只扣该批次；没写批次的行按仓库统一的分配策略扣。出库在建单时就按落定后的每一桶校验余量、别人的拣货占用、冻结和过期拦截，不够就拒绝且不产生单据；改明细同样校验。入库建单不查库存。可选 partnerCode 关联往来单位（入库单选供应商，出库单选客户，种类不匹配会被拒绝）。批次怎么扣不在单据上指定，是 core.wms 设置 defaultAllocation（strict=严格桶不分配，没写批次只扣 DEFAULT / fifo=先进先出 / fefo=先到期先出，缺省 strict）。fifo 或 fefo 时，没写批次的行在该行库位内拆成具体批次，一行可拆多批；写了批次的行不参与拆分。要改规则用 profile.propose 改 /modules/core.wms/settings/defaultAllocation，确认后生效，不要传 allocation。退货单不按分配策略拆行。同单同 SKU 可分不同库位/批次多行，但同 SKU 同库位同批次不可重复。orderNo 不传或空着则按编号规则生成（普通入库、出库、预报、客退、退供各用各的模板），传了就用传入的。module.return 启用时可传 returnOf 原单号：入库单退已发货的出库单（客退，收货时加库存），出库单退已收货的入库单（退供，发货时扣库存）。数量按 SKU 和批次不能超过原单已入账再减去未取消的退货，批次必须是原单上的批次，不按分配策略拆行。不传 returnOf 就是普通出入库。停用后退货参数会被拒绝，已开出的退货单仍可继续流转。module.asn 启用时可传 asn=true 把入库单开成到货预报（状态已预报，可选 expectedAt 预计到货日 YYYY-MM-DD）：收货前不加库存，收到货再转入 received 才加库存，取消预报不动库存。不传 asn 就是直接入库。停用后预报参数会被拒绝，已经预报的单仍可收货或取消。预报不能同时是退货，也不能开出库单。写了批次或库位之后能不能换，也是仓库设置 specifiedBatchConstraint、specifiedLocationConstraint（prefer=可以换，lock=不能换），不要在单据上传这两个参数。没填的批次和库位不受这两项限制。退货单的批次始终锁定，序列号商品的库位和批次始终锁定。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向：in=入库，out=出库' },
        lines: {
          type: 'array',
          description: '单据明细行，每行 { skuCode, quantity, locationCode?, batchNo?, batchExpiryDate? }',
          items: { type: 'object' },
        },
        orderNo: {
          type: 'string',
          description:
            '单据号（可选。不传或空着按编号规则生成：普通入库 order.in、出库 order.out、预报 order.asn、客退 order.return.in、退供 order.return.out。传了就用这个）',
        },
        note: { type: 'string', description: '备注（可选）' },
        partnerCode: {
          type: 'string',
          description:
            '往来单位编码（可选，M21）：入库单关联供应商、出库单关联客户；种类不匹配会被拒绝',
        },
        returnOf: {
          type: 'string',
          description:
            '原单号（可选，module.return）。客退填已发货的出库单号并开入库单；退供填已收货的入库单号并开出库单。不传则是普通出入库。',
        },
        asn: {
          type: 'boolean',
          description:
            '到货预报（可选，module.asn，仅入库）。true = 货还没到，单据停在已预报，收货时才加库存。不传或 false = 直接入库。',
        },
        expectedAt: {
          type: 'string',
          description: '预计到货日（可选，YYYY-MM-DD）。只能和 asn=true 一起用。',
        },
      },
      required: ['direction', 'lines'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      rejectSerialLinesWhenOff(ws, params.lines);

      // 批次怎么扣、指定之后能不能换，都只看仓库设置。单据上带这些参数一律拒绝。
      const returnOf = typeof params.returnOf === 'string' ? params.returnOf.trim() : '';
      const expectedAt = typeof params.expectedAt === 'string' ? params.expectedAt.trim() : '';
      const wantsAsn = params.asn === true || expectedAt.length > 0;
      if (wantsAsn) {
        if (ws.profile.getSnapshot().modules['module.asn']?.enabled !== true) throw new AsnDisabledError();
        if (params.direction !== 'in') throw new AsnDirectionError();
        if (returnOf) throw new AsnWithReturnError();
        if (params.asn !== true) throw new AsnExpectedAtError(expectedAt);
        if (expectedAt) assertExpectedAt(expectedAt);
      }
      const given = params as { allocation?: unknown; batchConstraint?: unknown; locationConstraint?: unknown };
      if (given.allocation !== undefined) {
        if (returnOf) throw new ReturnAllocationError();
        throw new Error(
          'TOOL_REJECTED: 批次怎么扣是仓库统一规则，不写在出库单上。改 core.wms 设置 defaultAllocation（strict、fifo 或 fefo），用 profile.propose 提议，等确认后生效',
        );
      }
      if (given.batchConstraint !== undefined || given.locationConstraint !== undefined) {
        throw new Error(
          'TOOL_REJECTED: 指定批次或库位能不能换是仓库统一规则，不写在出库单上。改 core.wms 设置 specifiedBatchConstraint 或 specifiedLocationConstraint（prefer 或 lock），用 profile.propose 提议，等确认后生效',
        );
      }
      const settings = readWmsSettings(ws);
      const effective = returnOf || params.direction !== 'out' ? 'strict' : settings.defaultAllocation;
      prepareOrderLineSerials(ws, params.direction, params.lines, effective);
      const resolvedLines = (
        effective !== 'strict'
          ? expandAllocatedLines(ws, params.lines, effective, settings.blockExpiredOutbound)
          : params.lines
      ) as typeof params.lines;

      // 行级校验（schema 校验器不深入 object 内部，handler 手工补位）
      if (!Array.isArray(resolvedLines) || resolvedLines.length === 0) {
        throw new Error('TOOL_REJECTED: lines 不能为空');
      }
      const seenKeys = new Set<string>(); // 重复键 = SKU + 库位 + 批次（M11：行唯一约束四段）
      for (const [i, line] of resolvedLines.entries()) {
        if (typeof line?.skuCode !== 'string' || !line.skuCode) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
        }
        assertPositiveQty(line.quantity, `第 ${i + 1} 行数量`);
        const sku = ws.skus.byCode(line.skuCode);
        if (!sku) {
          throw new SkuNotFoundError(line.skuCode);
        }
        const loc = resolveLocation(ws, line.locationCode); // 库位存在性（缺省 DEFAULT）
        // 批次解析（M11）：DEFAULT 虚拟批次不携带效期；出库行不支持效期声明
        if (params.direction === 'out' && line.batchExpiryDate) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行出库行不支持批次效期（效期随入库声明）`);
        }
        const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
        // 新批次效期一致性 fail-fast（权威守卫在收货落流水时——建单到收货间可能有别的流水）
        if (batch.batchExpiryDate) {
          assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
        }
        // 行唯一约束（wms_order_line 的 order+sku+location+batch 唯一，行 id 四段派生）：
        // 命令侧必须先挡，否则事件落账后投影 INSERT 炸裂、工作区永久卡死
        const key = `${line.skuCode}@${loc.locationId}@${batch.batchNo}`;
        if (seenKeys.has(key)) {
          throw new Error(
            `TOOL_REJECTED: 第 ${i + 1} 行 SKU ${line.skuCode} 在库位 ${loc.locationCode} 批次 ${batch.batchNo} 与前行重复——同单同 SKU 同库位同批次请合并数量`,
          );
        }
        seenKeys.add(key);
      }

      const orderNo = allocateCode(
        ws,
        orderNumberPlace({
          direction: params.direction,
          asn: wantsAsn,
          returnOf: returnOf.length > 0,
        }),
        params.orderNo,
      );
      if (ws.orders.byNo(orderNo)) {
        throw new OrderAlreadyExistsError(orderNo);
      }

      // 往来单位解析（M21）：存在 + 方向匹配（in↔supplier / out↔customer）。
      // 只落 partnerId（业务 id）；编码/名称展示由查询层联查（事件禁冗余快照）。
      let partnerId: string | undefined;
      if (params.partnerCode !== undefined) {
        const partner = ws.partners.byCode(params.partnerCode);
        if (!partner) throw new PartnerNotFoundError(params.partnerCode);
        const expectedKind = params.direction === 'in' ? 'supplier' : 'customer';
        if (partner.kind !== expectedKind) {
          throw new PartnerKindMismatchError(partner.partnerCode, partner.kind, params.direction);
        }
        partnerId = partner.id;
      }

      let returnOfOrderId: string | undefined;
      if (returnOf) {
        const source = ws.orders.byNo(returnOf);
        assertReturnLines({
          moduleEnabled: ws.profile.getSnapshot().modules['module.return']?.enabled === true,
          returnOf,
          direction: params.direction,
          source,
          sourceLines: source ? ws.orders.lines(source.id) : [],
          priorReturns: source
            ? ws.orders.returnsOf(source.id).map((order) => ({
                state: order.state,
                lines: ws.orders.lines(order.id),
              }))
            : [],
          lines: resolvedLines.map((line) => ({
            skuId: ws.skus.byCode(line.skuCode)!.id,
            skuCode: line.skuCode,
            batchNo: resolveBatch(line.batchNo, line.batchExpiryDate).batchNo,
            quantity: quantizeQty(line.quantity),
          })),
          posted: source ? postedOf(ws, source) : undefined,
        });
        returnOfOrderId = source!.id;
      }

      if (params.direction === 'out') {
        assertOutboundBuckets(
          ws,
          resolvedLines.map((line) => ({
            skuId: ws.skus.byCode(line.skuCode)!.id,
            locationId: resolveLocation(ws, line.locationCode).locationId,
            batchNo: resolveBatch(line.batchNo, line.batchExpiryDate).batchNo,
            quantity: quantizeQty(line.quantity),
          })),
        );
      }

      const orderId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.orderCreated, {
        orderId,
        orderNo,
        direction: params.direction,
        partnerId,
        returnOfOrderId,
        ...(wantsAsn ? { asn: expectedAt ? { expectedAt } : {} } : {}),
        // M12：分配后行集（未启用分配时即原始行集）——事件形态与 M11 逐字节同构
        lines: resolvedLines.map((l) => {
          const batch = resolveBatch(l.batchNo, l.batchExpiryDate);
          return {
            skuId: ws.skus.byCode(l.skuCode)!.id,
            quantity: quantizeQty(l.quantity),
            locationId: resolveLocation(ws, l.locationCode).locationId,
            batchNo: batch.batchNo,
            batchExpiryDate: batch.batchExpiryDate,
            ...(l.serials && l.serials.length > 0 ? { serials: l.serials } : {}),
          };
        }),
        note: params.note,
        ...(params.direction === 'out' && returnOf ? { batchConstraint: 'lock' as const } : {}),
      });
      ws.sync();
      return { orderId, orderNo, state: wantsAsn ? ('announced' as const) : ('created' as const) };
    },
  };

  const orderTransition: ToolDefinition<{
    orderNo: string;
    to: string;
    lines?: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[];
  }> = {
    id: 'wms.order.transition',
    label: '单据状态转移',
    description:
      '推进单据状态，并按该转移的库存效应联动库存（按行的库位 + 批次）。未在转移上声明 effect 时：入库进入 received（可用 settings.inboundIncreaseState 改名）按行增加库存；出库进入 picking（outboundCheckState）只预检余量；出库进入 shipped（outboundDecreaseState）按行扣减。转移上的 effect（increase/decrease/check/none）优先于这三键。module.reversal 启用时，已收货可取消并扣回，已发货可取消并加回；停用后这两条转移不可用。module.partial 启用时，会改库存的转移可以带 lines 声明实收/实发（不大于该行订单数量，0 表示这行没到/没发）；不带 lines 按订单数量整单入账。停用 module.partial 后不能改少。已经入账的行，冲销按已入账数量，不能再改。合法目标由当前流程决定。过期批次拦截只作用于出库履约，不拦截入库冲销。拣货关单不走本工具的短发。module.reservation 启用时，出库进入只预检的状态会按行占用可用量，其他出库单不能再拿走；发货或取消时释放。停用后新的拣货不再占用，已有占用仍会在发货或取消时释放。module.picking 启用时，出库从已创建进入拣货中（只预检）。拣货单关单后进入已拣货并按实拣扣减，再到本工具从已拣货发货（这一步不再扣库存）。不能用本工具直接发货、标成已拣货或完成。停用后已创建直接发货（预检并扣减），已经在拣货中的单仍可发货或取消，已经是已拣货的单仍可发货。有未关拣货单时，直接发货会被拒绝。module.putaway 启用时，已收货的入库单不能直接完成，要先用 wms.order.putaway 上架（可归位）；停用后已收货直接完成。已经上架的单仍可完成。module.qc 启用时，已收货要先质检（wms.order.transition 到 inspected），不能直接上架或完成；停用后收货后按上架开关继续。已经质检的单仍可上架或完成。module.wave 启用时，已创建要先组波到 waved，不能直接拣货、发货或完成；停用后从已创建继续。已经组波的单仍可拣货、发货或取消。module.review 启用时，要先到 reviewed 才能打包、装车或发货。module.pack 启用时，要先到 packed 才能装车或发货。module.load 启用时，要先到 loaded 才能发货。复核、打包和装车不扣库存。拣货已经扣过的，发货不再扣。停用后新单跳过该步，已经进入该步的单仍可继续。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        // 不设 enum：状态词汇由流程配置定义（模块可贡献新状态），合法性由 handler 按配置裁决
        to: { type: 'string', description: '目标状态（合法值由当前流程配置决定）' },
        lines: {
          type: 'array',
          description:
            '实收/实发（可选，module.partial）。每项 { skuCode, quantity, locationCode?, batchNo? }。缺省行按订单数量。',
          items: { type: 'object' },
        },
      },
      required: ['orderNo', 'to'],
    },
    handler: (params, ctx) => applyOrderTransition(resolveWorkspace(ctx.workspaceId), ctx, params),
  };

  const orderQuery: ToolDefinition<{
    orderNo?: string;
    direction?: OrderDirection;
    state?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }> = {
    id: 'wms.order.query',
    label: '查询单据',
    description:
      '查询单据清单或单据详情。给 orderNo 返回该单详情（含明细行 lines：SKU 编码/数量/库位/批次，及往来单位），单据不存在会报错。' +
      '不给 orderNo 返回分页清单：direction（in=入库 / out=出库）、state（状态，如 created/received/completed——状态词汇由流程配置定义）、' +
      'from/to（创建时间 ISO 闭区间）均可选过滤。最新在前；limit 默认 20（上限 200）、offset 翻页；' +
      '返回 { total, limit, offset, hasMore, rows }，行含 orderNo / direction / state / partnerCode / lineCount / totalQuantity / createdAt。' +
      '查「最近的出入库单」「某状态的单据」「某单据的明细」用本工具；纯读操作。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号（给定时返回该单详情含明细行）' },
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向过滤（可选）' },
        state: { type: 'string', description: '状态过滤（可选，如 created / received / completed）' },
        from: { type: 'string', description: '创建起始时间（ISO，含）' },
        to: { type: 'string', description: '创建结束时间（ISO，含）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页行数（缺省 20）' },
        offset: { type: 'integer', minimum: 0, description: '跳过行数（缺省 0，翻页用）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();

      // 单号模式：单据详情含明细行（单号详情天然有限，不分页）
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        return withOrderLines(ws, order);
      }

      // 列表模式：分页壳 + 行统计（lines 逐单汇总）
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      const { rows, total } = ws.orders.listPage({
        direction: params.direction,
        state: params.state,
        from: params.from,
        to: params.to,
        limit,
        offset,
      });
      return {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
        rows: rows.map((order) => {
          const lines = ws.orders.lines(order.id);
          const partner = order.partnerId ? ws.partners.byId(order.partnerId) : undefined;
          return {
            orderNo: order.orderNo,
            direction: order.direction,
            state: order.state,
            partnerCode: partner?.partnerCode ?? null,
            partnerName: partner?.name ?? null,
            lineCount: lines.length,
            totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          };
        }),
      };
    },
  };

  const orderRevise: ToolDefinition<{
    orderNo: string;
    note?: string | null;
    partnerCode?: string | null;
    expectedAt?: string | null;
    lines?: {
      skuCode: string;
      quantity: number;
      locationCode?: string;
      batchNo?: string;
      batchExpiryDate?: string;
      serials?: string[];
    }[];
  }> = {
    id: 'wms.order.revise',
    label: '修订出入库单',
    description:
      '修改一张出入库单的备注、往来单位或明细，已入账或已结束的字段会被拒绝。' +
      '单号、方向、状态、原单号、补货标记不能改，状态只走 wms.order.transition。' +
      '入库在 created 或 announced（到货预报还没收货）、出库在 created 时，可以改明细（SKU、数量、库位、批次、入库效期）、往来单位和备注。' +
      '预计到货日只有到货预报能改。' +
      '已经收货、上架、拣货、发货之后，明细和往来单位冻住（库存或占用量已经按这些行记过账），只剩备注可改。' +
      '已完成和已取消整单不能改。有未裁决的状态冲突时先接受或驳回。' +
      '退货单改明细时仍按原单可退数量校验，不能改指向的原单。' +
      '出库明细按提交的行保存，不会重新做 fifo/fefo 拆分。' +
      '出库改明细时按落定后的每一桶校验余量、别人的拣货占用、冻结和过期拦截，不够就拒绝。' +
      '只传要改的字段；note / partnerCode / expectedAt 传 null 表示清空。lines 在场则整份替换，不能为空。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        note: { type: 'string', nullable: true, description: '备注。null 表示清空。不传表示不改' },
        partnerCode: {
          type: 'string',
          nullable: true,
          description: '往来单位编码。入库单要供应商，出库单要客户。null 表示去掉。不传表示不改',
        },
        expectedAt: { type: 'string', nullable: true, description: '预计到货日 YYYY-MM-DD，仅到货预报。null 表示清空' },
        lines: {
          type: 'array',
          description: '整份明细。在场则替换原明细。每行 { skuCode, quantity, locationCode?, batchNo?, batchExpiryDate?, serials? }',
          items: { type: 'object' },
        },
      },
      required: ['orderNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const order = ws.orders.byNo(params.orderNo);
      if (!order) throw new OrderNotFoundError(params.orderNo);
      if (ws.orders.listConflicts('open').some((conflict) => conflict.orderId === order.id)) {
        throw new OrderReviseRejectedError('这张单有未裁决的状态冲突，先接受或驳回再改内容');
      }
      const policy = orderEditPolicy(order);
      const hasNote = Object.hasOwn(params, 'note');
      const hasPartner = Object.hasOwn(params, 'partnerCode');
      const hasExpected = Object.hasOwn(params, 'expectedAt');
      const hasLines = Object.hasOwn(params, 'lines');
      if (!hasNote && !hasPartner && !hasExpected && !hasLines) {
        throw new OrderReviseRejectedError('没有要修改的内容');
      }
      if (hasLines && !policy.lines) throw new OrderReviseRejectedError(policy.reason);
      if (hasPartner && !policy.partner) throw new OrderReviseRejectedError(policy.reason);
      if (hasExpected && !policy.expectedAt) throw new OrderReviseRejectedError(policy.reason || '这张单不能改预计到货日');
      if (hasNote && !policy.note) throw new OrderReviseRejectedError(policy.reason);

      const payload: {
        orderId: string;
        orderNo: string;
        partnerId?: string | null;
        note?: string | null;
        expectedAt?: string | null;
        lines?: {
          skuId: string;
          quantity: number;
          locationId: string;
          batchNo: string;
          batchExpiryDate?: string;
          serials?: string[];
        }[];
      } = { orderId: order.id, orderNo: order.orderNo };

      if (hasNote) {
        const note = typeof params.note === 'string' ? params.note.trim() : '';
        payload.note = note || null;
      }
      if (hasPartner) {
        const code = typeof params.partnerCode === 'string' ? params.partnerCode.trim() : '';
        if (!code) {
          payload.partnerId = null;
        } else {
          const partner = ws.partners.byCode(code);
          if (!partner) throw new PartnerNotFoundError(code);
          const expectedKind = order.direction === 'in' ? 'supplier' : 'customer';
          if (partner.kind !== expectedKind) {
            throw new PartnerKindMismatchError(partner.partnerCode, partner.kind, order.direction);
          }
          payload.partnerId = partner.id;
        }
      }
      if (hasExpected) {
        const expectedAt = typeof params.expectedAt === 'string' ? params.expectedAt.trim() : '';
        if (expectedAt) assertExpectedAt(expectedAt);
        payload.expectedAt = expectedAt || null;
      }
      if (hasLines) {
        const lines = params.lines;
        if (!Array.isArray(lines) || lines.length === 0) {
          throw new OrderReviseRejectedError('明细不能为空');
        }
        rejectSerialLinesWhenOff(ws, lines);
        const existing = ws.orders.lines(order.id).map((line) => ({
          skuCode: ws.skus.byId(line.skuId)?.skuCode,
          locationCode: codeOfLocation(ws, line.locationId),
          batchNo: line.batchNo,
          serials: line.serials ? [...line.serials] : undefined,
        }));
        for (const line of lines) {
          if (!line || Object.hasOwn(line, 'serials')) continue;
          const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
          const location = resolveLocation(ws, line.locationCode);
          const hit = existing.find(
            (row) => row.skuCode === line.skuCode && row.locationCode === location.locationCode && row.batchNo === batch.batchNo,
          );
          if (hit?.serials) line.serials = hit.serials;
        }
        prepareOrderLineSerials(ws, order.direction, lines, 'strict');
        const seenKeys = new Set<string>();
        const resolved: NonNullable<typeof payload.lines> = [];
        for (const [i, line] of lines.entries()) {
          if (typeof line?.skuCode !== 'string' || !line.skuCode) {
            throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
          }
          assertPositiveQty(line.quantity, `第 ${i + 1} 行数量`);
          const sku = ws.skus.byCode(line.skuCode);
          if (!sku) throw new SkuNotFoundError(line.skuCode);
          if (order.direction === 'out' && line.batchExpiryDate) {
            throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行出库行不支持批次效期（效期随入库声明）`);
          }
          const loc = resolveLocation(ws, line.locationCode);
          const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
          if (batch.batchExpiryDate) {
            assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
          }
          const key = `${line.skuCode}@${loc.locationId}@${batch.batchNo}`;
          if (seenKeys.has(key)) {
            throw new Error(
              `TOOL_REJECTED: 第 ${i + 1} 行 SKU ${line.skuCode} 在库位 ${loc.locationCode} 批次 ${batch.batchNo} 与前行重复——同单同 SKU 同库位同批次请合并数量`,
            );
          }
          seenKeys.add(key);
          resolved.push({
            skuId: sku.id,
            quantity: quantizeQty(line.quantity),
            locationId: loc.locationId,
            batchNo: batch.batchNo,
            batchExpiryDate: batch.batchExpiryDate,
            ...(line.serials && line.serials.length > 0 ? { serials: line.serials } : {}),
          });
        }
        if (order.returnOfOrderId) {
          const source = ws.orders.byId(order.returnOfOrderId);
          assertReturnLines({
            moduleEnabled: ws.profile.getSnapshot().modules['module.return']?.enabled === true,
            returnOf: source?.orderNo ?? order.returnOfOrderId,
            direction: order.direction,
            source,
            sourceLines: source ? ws.orders.lines(source.id) : [],
            priorReturns: source
              ? ws.orders
                  .returnsOf(source.id)
                  .filter((ret) => ret.id !== order.id)
                  .map((ret) => ({ state: ret.state, lines: ws.orders.lines(ret.id) }))
              : [],
            lines: resolved.map((line) => ({
              skuId: line.skuId,
              skuCode: ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
              batchNo: line.batchNo,
              quantity: line.quantity,
            })),
            posted: source ? postedOf(ws, source) : undefined,
          });
        }
        if (order.direction === 'out') {
          assertOutboundBuckets(
            ws,
            resolved.map((line) => ({
              skuId: line.skuId,
              locationId: line.locationId,
              batchNo: line.batchNo,
              quantity: line.quantity,
            })),
            [order.id],
          );
        }
        payload.lines = resolved;
      }

      ctx.appendEvent(WMS_EVENT_TYPES.orderRevised, payload);
      ws.sync();
      return { orderNo: order.orderNo, state: order.state };
    },
  };

  return [def(orderCreate), def(orderTransition), def(orderRevise), def(orderQuery)];
}

/** 原单的实绩额度。没有流水时回退到单据行。 */
function postedOf(
  ws: WmsWorkspace,
  source: { id: string; direction: OrderDirection },
): Map<string, number> {
  return postedBucketsForReturn(source.direction, ws.orders.lines(source.id), ws.inventory.movementsByOrder(source.id));
}


