import { evalWhenCondition, type ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderNotFoundError,
  PutawayCapacityError,
  PutawayDuplicateTargetError,
  PutawayOrderShareError,
  QcRequiredError,
  PutawayLineNotFoundError,
  PutawayOnlyInboundError,
  PutawayQuantityError,
  PutawaySourceShortError,
  SerialStockError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { codeOfLocation, QTY_EPS, quantizeQty, resolveBatch, resolveLocation } from '../state/inventory-policy.js';
import { assertLooseEnough } from '../state/lpn-policy.js';
import { appendSerialPlans, planPutawaySerials } from '../state/serial-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
} from '../state/order-state-machine.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 上架工具（M21，module.putaway 贡献的流程步骤）。
 *
 * 收货落账行为不变（received 仍按行库位入账）。启用 module.putaway 时，
 * 已收货必须经本工具上架后才能完成：无 targets 纯确认（只有状态事件）；
 * 带 targets 把行改派到目标库位（一对 ± 流水，reason putaway:{orderNo}，
 * 批次/效期保留）。同一行可以带 quantity 拆到多个库位，没分走的数量留在收货库位。
 * 停用后 received→putaway 不可达，已收货直接完成。
 */
export function createPutawayTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const orderPutaway: ToolDefinition<{
    orderNo: string;
    targets?: {
      skuCode: string;
      fromLocationCode?: string;
      batchNo?: string;
      toLocationCode: string;
      /** 这一处放多少。同一行只去一处且不写时，整行搬走。拆开时每一处都要写 */
      quantity?: number;
    }[];
  }> = {
    id: 'wms.order.putaway',
    label: '上架确认',
    description:
      '对已收货（received）的入库单做上架确认与归位。module.putaway 启用时这一步必做，已收货不能直接完成，要在上架里做。不带 targets = 纯确认（单据流转到「已上架」，不动库存）；带 targets = 把指定行从收货库位改派到目标库位（每处生成一对移库流水，批次与效期保留，流水 reason: putaway:单号）。同一行可以拆到多个库位：每一处写 quantity，合计不能超过本行，没分走的留在收货库位。同一行只去一处且不写 quantity 时整行搬走。targets 每项：skuCode 必填；fromLocationCode 源库位（可选，缺省 DEFAULT）；batchNo 批次（可选，缺省 DEFAULT）；toLocationCode 目标库位必填；quantity 可选。同一处（skuCode+源库位+批次+目标库位）只能写一行，重复写整单拒绝；上架量也不能超过本单在该源桶收的货（收货 − 已上架），别的单据的货挪不过来。要求单据处于已收货状态且上架模块启用。停用后本工具不可用，已收货直接完成。序列号商品必须整行上架，不能拆库位。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '入库单号' },
        targets: {
          type: 'array',
          description: '归位明细（可选；缺省 = 纯确认不动库存）。每行 { skuCode, fromLocationCode?, batchNo?, toLocationCode }',
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
      if (order.direction !== 'in') throw new PutawayOnlyInboundError(params.orderNo);

      // 流程校验（配置即权威）：when 过滤后的活跃转移断言 received→putaway 可达。
      // 模块停用 → 转移不存在 → InvalidTransitionError（老流程语义原样）。
      const snapshot = ws.profile.getSnapshot();
      if (snapshot.modules['module.qc']?.enabled === true && order.state === 'received') {
        throw new QcRequiredError(order.orderNo);
      }
      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
      if (!workflow) throw new WorkflowNotFoundError(order.direction);
      const activeTransitions = workflow.transitions.filter((t) =>
        evalWhenCondition(t.when, snapshot.modules),
      );
      assertTransition(activeTransitions, order.direction, order.state, 'putaway');

      // 归位明细解析：源桶（SKU+源库位+批次）匹配入库单行。
      // 同一行可以拆到多处；不写 quantity 且只去一处时整行搬走。
      const lines = ws.orders.lines(order.id);
      const slots: {
        line: (typeof lines)[number];
        skuCode: string;
        fromLocationId: string;
        fromLocationCode: string;
        toLocationId: string;
        toLocationCode: string;
        batchNo: string;
        quantity: number | undefined;
      }[] = [];
      for (const t of params.targets ?? []) {
        const sku = ws.skus.byCode(t.skuCode);
        if (!sku) throw new SkuNotFoundError(t.skuCode);
        const from = resolveLocation(ws, t.fromLocationCode);
        const batch = resolveBatch(t.batchNo, undefined);
        const to = resolveLocation(ws, t.toLocationCode);
        const line = lines.find(
          (l) => l.skuId === sku.id && l.locationId === from.locationId && l.batchNo === batch.batchNo,
        );
        const lineKey = `${t.skuCode}@${from.locationCode}/${batch.batchNo}`;
        if (!line) throw new PutawayLineNotFoundError(params.orderNo, lineKey);
        let quantity: number | undefined;
        if (t.quantity !== undefined) {
          if (typeof t.quantity !== 'number' || !Number.isFinite(t.quantity)) {
            throw new PutawayQuantityError(`入库单 ${params.orderNo} 的 ${lineKey} 要写数量`);
          }
          quantity = quantizeQty(t.quantity);
          if (quantity <= QTY_EPS) {
            throw new PutawayQuantityError(`入库单 ${params.orderNo} 的 ${lineKey} 上架数量必须大于 0`);
          }
        }
        slots.push({
          line,
          skuCode: sku.skuCode,
          fromLocationId: from.locationId,
          fromLocationCode: from.locationCode,
          toLocationId: to.locationId,
          toLocationCode: to.locationCode,
          batchNo: batch.batchNo,
          quantity,
        });
      }
      // 完全重复的目标（SKU+源库位+批次+目标库位 四项全同）显式拒绝：
      // 重复项会被下面的分组当成「拆到多处」，各自落一对 ± 流水，等于把同一份货搬两遍。
      const seenTargets = new Map<string, number>();
      for (const slot of slots) {
        const targetKey = `${slot.line.skuId}:${slot.fromLocationId}:${slot.batchNo}:${slot.toLocationId}`;
        const times = (seenTargets.get(targetKey) ?? 0) + 1;
        seenTargets.set(targetKey, times);
        if (times > 1) {
          throw new PutawayDuplicateTargetError(
            params.orderNo,
            `${slot.skuCode}@${slot.fromLocationCode}/${slot.batchNo}`,
            slot.toLocationCode,
            times,
          );
        }
      }
      const groups = new Map<string, typeof slots>();
      for (const slot of slots) {
        const key = `${slot.line.skuId}:${slot.fromLocationId}:${slot.batchNo}`;
        const group = groups.get(key);
        if (group) group.push(slot);
        else groups.set(key, [slot]);
      }
      const moves: {
        line: (typeof lines)[number];
        skuCode: string;
        fromLocationId: string;
        toLocationId: string;
        toLocationCode: string;
        batchNo: string;
        batchExpiryDate: string | undefined;
        quantity: number;
      }[] = [];
      for (const group of groups.values()) {
        const head = group[0]!;
        const lineKey = `${head.skuCode}@${head.fromLocationCode}/${head.batchNo}`;
        const wroteQty = group.some((slot) => slot.quantity !== undefined);
        if (!wroteQty) {
          if (group.length > 1) {
            if (ws.skus.byId(head.line.skuId)?.serialTracked) {
              throw new SerialStockError('按序列号管理的行不能拆到多个库位');
            }
            throw new PutawayQuantityError(
              `入库单 ${params.orderNo} 的 ${lineKey} 要分到多个库位，每一处都要写数量`,
            );
          }
          if (head.toLocationId !== head.fromLocationId) {
            moves.push(moveOf(ws, head, head.line.quantity));
          }
          continue;
        }
        if (group.some((slot) => slot.quantity === undefined)) {
          throw new PutawayQuantityError(`入库单 ${params.orderNo} 的 ${lineKey} 分开放时，每一处都要写数量`);
        }
        const sum = quantizeQty(group.reduce((total, slot) => total + (slot.quantity ?? 0), 0));
        if (sum > head.line.quantity + QTY_EPS) {
          throw new PutawayQuantityError(
            `入库单 ${params.orderNo} 的 ${lineKey} 上架 ${sum}，超过本行 ${head.line.quantity}`,
          );
        }
        for (const slot of group) {
          if (slot.toLocationId === slot.fromLocationId) continue;
          moves.push(moveOf(ws, slot, slot.quantity ?? 0));
        }
      }
      const taken = new Map<string, { slot: (typeof slots)[number]; take: number }>();
      for (const move of moves) {
        const key = `${move.line.skuId}:${move.fromLocationId}:${move.batchNo}`;
        const prev = taken.get(key);
        if (prev) prev.take = quantizeQty(prev.take + move.quantity);
        else taken.set(key, { slot: slots.find((slot) => `${slot.line.skuId}:${slot.fromLocationId}:${slot.batchNo}` === key)!, take: move.quantity });
      }
      // 本单在源桶上的「待上架份额」= 该单名下流水净额（收货 + / 已上架 −）。
      // 共享库位（DEFAULT）里堆着多张单的货：桶余量够 ≠ 自己这份够。上一张单多扣
      // （重复上架、串账）会把差额转嫁成下一张单的 PutawaySourceShortError，
      // 报错只说余量、指不出是谁挪的——按单据份额校验才能把责任落在越界的那张单上。
      const ownMovements = ws.inventory.movementsByOrder(order.id);
      const ownShare = new Map<string, number>();
      for (const m of ownMovements) {
        ownShare.set(`${m.skuId}:${m.locationId}:${m.batchNo}`, quantizeQty(m.net));
      }
      // 老库兜底：该单一条带 orderId 的流水都没有（收货未挂单据）时无法算份额，
      // 退回只看桶余量，不误伤合法上架。
      const shareKnown = ownMovements.length > 0;
      for (const { slot, take } of taken.values()) {
        if (shareKnown) {
          const share = ownShare.get(`${slot.line.skuId}:${slot.fromLocationId}:${slot.batchNo}`) ?? 0;
          if (share + QTY_EPS < take) {
            throw new PutawayOrderShareError(
              order.orderNo,
              slot.skuCode,
              slot.fromLocationCode,
              slot.batchNo,
              take,
              share,
            );
          }
        }
        const available = ws.inventory.quantityOf(slot.line.skuId, slot.fromLocationId, slot.batchNo);
        if (available + QTY_EPS < take) {
          throw new PutawaySourceShortError(slot.skuCode, slot.fromLocationCode, slot.batchNo, take, available);
        }
        assertLooseEnough(ws, {
          skuCode: slot.skuCode,
          skuId: slot.line.skuId,
          locationId: slot.fromLocationId,
          locationCode: slot.fromLocationCode,
          batchNo: slot.batchNo,
          take,
          onHand: available,
        });
      }
      const settings = readWmsSettings(ws);
      const warnings: string[] = [];
      if (settings.putawayCapacity !== 'off') {
        const planned = new Map<string, { code: string; qty: number }>();
        for (const move of moves) {
          const prev = planned.get(move.toLocationId);
          if (prev) prev.qty += move.quantity;
          else planned.set(move.toLocationId, { code: move.toLocationCode, qty: move.quantity });
        }
        for (const [locationId, plan] of planned) {
          const capacity = ws.locations.byId(locationId)?.capacity;
          if (capacity == null || capacity <= 0) continue;
          const onHand = ws.inventory.quantityAtLocation(locationId);
          if (onHand + plan.qty <= capacity + QTY_EPS) continue;
          if (settings.putawayCapacity === 'block') {
            throw new PutawayCapacityError(plan.code, capacity, onHand, plan.qty);
          }
          warnings.push(`库位 ${plan.code} 容量 ${capacity}，现在 ${onHand}，再放 ${plan.qty} 放不下`);
        }
      }
      const serialPlans = planPutawaySerials(
        ws,
        moves.map((move) => ({
          skuId: move.line.skuId,
          skuCode: move.skuCode,
          fromLocationId: move.fromLocationId,
          toLocationId: move.toLocationId,
          batchNo: move.batchNo,
          quantity: move.quantity,
          serials: move.line.serials,
        })),
      );

      // 原子落账：状态事实 + 每个归位行一对 ± 流水同生共死（savepoint）
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
          orderId: order.id,
          orderNo: order.orderNo,
          direction: order.direction,
          from: order.state,
          to: 'putaway',
        });
        for (const m of moves) {
          const reason = `putaway:${order.orderNo}`;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: m.line.skuId,
            skuCode: m.skuCode,
            delta: -m.quantity,
            reason,
            locationId: m.fromLocationId,
            locationCode: codeOfLocation(ws, m.fromLocationId),
            batchNo: m.batchNo,
            orderId: order.id,
            orderNo: order.orderNo,
          });
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: m.line.skuId,
            skuCode: m.skuCode,
            delta: m.quantity,
            reason,
            locationId: m.toLocationId,
            locationCode: m.toLocationCode,
            batchNo: m.batchNo,
            batchExpiryDate: m.batchExpiryDate,
            orderId: order.id,
            orderNo: order.orderNo,
          });
        }
        appendSerialPlans(ctx, serialPlans);
      });
      ws.sync();
      return {
        orderNo: order.orderNo,
        from: order.state,
        to: 'putaway',
        movedLines:
          moves.length > 0
            ? moves.map((m) => ({
                skuCode: m.skuCode,
                batchNo: m.batchNo,
                fromLocationCode: codeOfLocation(ws, m.fromLocationId),
                toLocationCode: m.toLocationCode,
                quantity: m.quantity,
              }))
            : undefined,
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      };
    },
  };

  return [def(orderPutaway)];
}

function moveOf<T extends { skuId: string; batchExpiryDate?: string | null; serials?: readonly string[] }>(
  ws: WmsWorkspace,
  slot: {
    line: T;
    skuCode: string;
    fromLocationId: string;
    toLocationId: string;
    toLocationCode: string;
    batchNo: string;
  },
  quantity: number,
) {
  return {
    line: slot.line,
    skuCode: slot.skuCode,
    fromLocationId: slot.fromLocationId,
    toLocationId: slot.toLocationId,
    toLocationCode: slot.toLocationCode,
    batchNo: slot.batchNo,
    batchExpiryDate: slot.line.batchExpiryDate ?? ws.inventory.expiryOfBatch(slot.line.skuId, slot.batchNo) ?? undefined,
    quantity,
  };
}
