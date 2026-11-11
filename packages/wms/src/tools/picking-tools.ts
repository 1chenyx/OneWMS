import { randomUUID } from 'node:crypto';
import { evalWhenCondition, type ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { DEFAULT_BATCH_NO, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderNotFoundError,
  PickingExistsError,
  PickingIncompleteError,
  PickingLineNotFoundError,
  PickingNoOrdersError,
  PickingNotOpenError,
  PickingNotFoundError,
  PickingOrderStateError,
  PickingOverPickError,
  WorkflowNotFoundError,
} from '../errors.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { allocateCode } from '../numbering/allocate.js';
import { allocateFromBuckets } from '../state/allocation.js';
import { assertSubstitution, mergeBuckets, type PickBucket } from '../state/execution-policy.js';
import { assertOutboundBuckets } from '../state/outbound-guards.js';
import { appendSerialPlans, planPickingSerials } from '../state/serial-policy.js';
import { desiredReservationClaims, planReservationReleases, planReservationSync } from '../state/reservation.js';
import {
  assertNonNegativeQty,
  assertPositiveQty,
  codeOfLocation,
  QTY_EPS,
  quantizeQty,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import {
  assertTransition,
  canTransition,
  WORKFLOW_BY_DIRECTION,
} from '../state/order-state-machine.js';
import type { PickingLineRecord } from '../views/picking-view.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 拣货单工具（M21）——聚合多张「拣货中」出库单的行成一张拣货单，picker 逐行
 * 实拣（可改实际拣货桶），关单统一扣减：
 *  - create：逐行生成建议桶（显式批次 → 该桶；DEFAULT 虚拟批次 → 按策略
 *    从行库位的余量桶装载首个——建议桶只是建议，硬校验在 close）；
 *  - pick：记实拣事实（不落库存流水）；pickedQty 是累计实拣量（后到者胜）；
 *  - close：全部行拣满 → 拣货开着时出库单进入已拣货，否则进入已发货 →
 *    assertOutboundBuckets 以实拣桶硬校验（过期/余量/冻结）→ runAtomic 原子落
 *    orderStateChanged + 逐行 inventoryAdjusted(−, reason picking:{no})
 *    + pickingClosed。已拣货再到出库单发货，不再扣第二次；
 *  - cancel：open 才可，已拣记录保留审计；订单留在拣货中人工处理；
 *  - query（read）：单张带行 / 全部清单。
 * 生命周期词汇固定 created → closed / canceled（M17 盘点先例，不进 Profile
 * workflows）；订单侧的流程校验仍走 outbound workflow 配置（when 过滤）。
 */
export function createPickingTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const pickingCreate: ToolDefinition<{
    orderNos: string[];
    note?: string;
    pickingNo?: string;
  }> = {
    id: 'wms.picking.create',
    label: '创建拣货单',
    description:
      '聚合多张「拣货中」状态的出库单成一张拣货单（建议桶自动生成：行有显式批次用该桶，虚拟批次按 defaultAllocation 策略建议）。参数：orderNos（出库单号数组，至少一张）、note（可选）、pickingNo（可选，不传或空着按编号规则 picking 生成）。行建议桶随事件携带；实拣与扣减发生在后续 pick/close。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNos: { type: 'array', items: { type: 'string' }, description: '出库单号数组（须为「拣货中」状态）' },
        note: { type: 'string', description: '备注（可选）' },
        pickingNo: { type: 'string', description: '拣货单号（可选。不传或空着按编号规则生成）' },
      },
      required: ['orderNos'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!Array.isArray(params.orderNos) || params.orderNos.length === 0) {
        throw new PickingNoOrdersError();
      }
      const settings = readWmsSettings(ws);
      const today = new Date().toISOString().slice(0, 10);
      const pickingId = randomUUID();
      const pickingNo = allocateCode(ws, 'picking', params.pickingNo);
      if (ws.pickings.byNo(pickingNo)) throw new PickingExistsError(pickingNo);
      const lines: {
        lineId: string;
        orderId: string;
        orderNo: string;
        orderLineId: string;
        skuId: string;
        skuCode: string;
        qtyToPick: number;
        suggestedLocationId: string;
        suggestedLocationCode: string;
        suggestedBatchNo: string;
      }[] = [];
      for (const orderNo of params.orderNos) {
        const order = ws.orders.byNo(orderNo);
        if (!order) throw new OrderNotFoundError(orderNo);
        if (order.direction !== 'out' || order.state !== 'picking') {
          throw new PickingOrderStateError(orderNo, order.direction === 'out' ? order.state : `入库单（${order.state}）`);
        }
        for (const line of ws.orders.lines(order.id)) {
          // 行键四段派生（与 OrderView 投影的行 id 同构）
          const orderLineId = `${order.id}:${line.skuId}:${line.locationId}:${line.batchNo}`;
          const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
          let suggestedBatchNo = line.batchNo;
          if (line.batchNo === DEFAULT_BATCH_NO && settings.defaultAllocation !== 'strict') {
            // 虚拟批次行：按策略从行库位的余量桶建议首个（部分分配也接受——
            // 建议桶不是硬校验，close 时以实拣桶验余量）
            const { parts } = allocateFromBuckets(
              ws.inventory.batchesOf(line.skuId, line.locationId),
              line.quantity,
              settings.defaultAllocation,
              settings.blockExpiredOutbound,
              today,
            );
            if (parts.length > 0) suggestedBatchNo = parts[0]!.batchNo;
          }
          lines.push({
            lineId: `${pickingId}:${orderLineId}`,
            orderId: order.id,
            orderNo: order.orderNo,
            orderLineId,
            skuId: line.skuId,
            skuCode,
            qtyToPick: line.quantity,
            suggestedLocationId: line.locationId,
            suggestedLocationCode: codeOfLocation(ws, line.locationId),
            suggestedBatchNo,
          });
        }
      }
      if (lines.length === 0) {
        throw new PickingNoOrdersError(); // 出库单全是空行（理论上建单守卫已挡）
      }
      ctx.appendEvent(WMS_EVENT_TYPES.pickingCreated, {
        pickingId,
        pickingNo,
        lines,
        note: params.note,
      });
      ws.sync();
      return { pickingId, pickingNo, state: 'created', lineCount: lines.length };
    },
  };

  const pickingPick: ToolDefinition<{
    pickingNo: string;
    orderNo: string;
    skuCode: string;
    /** 定位行的建议批次（同单同 SKU 多桶行区分键）；缺省 DEFAULT */
    suggestedBatchNo?: string;
    /** 本行累计实拣量（后到者胜；必须 ≤ 应拣量） */
    pickedQty: number;
    /** 实拣库位（可选，缺省建议桶库位） */
    locationCode?: string;
    /** 实拣批次（可选，缺省建议桶批次） */
    pickedBatchNo?: string;
    /** 一行拆成多桶。在场时覆盖这一行的实绩，pickedQty 要等于各桶之和 */
    allocations?: { locationCode?: string; batchNo?: string; quantity: number }[];
  }> = {
    id: 'wms.picking.pick',
    label: '录入实拣',
    description:
      '为拣货单一行录入实拣（不落库存流水，扣减发生在关单）。可以传 locationCode 和 pickedBatchNo 改一桶，或传 allocations 把一行拆成多桶。锁定的批次和库位不能换；没填的不受限。序列号和退货单的批次不能换。实拣当时就校验余量，并把占用改到实拣桶，没拣的部分仍占单据上的桶。明确拣 0 会放开占用。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        pickingNo: { type: 'string' },
        orderNo: { type: 'string' },
        skuCode: { type: 'string' },
        suggestedBatchNo: { type: 'string' },
        pickedQty: { type: 'number' },
        locationCode: { type: 'string' },
        pickedBatchNo: { type: 'string' },
        allocations: {
          type: 'array',
          description: '一行拆成多桶。每项 { quantity, locationCode?, batchNo? }。在场时覆盖这一行。pickedQty 要等于各桶之和',
          items: { type: 'object' },
        },
      },
      required: ['pickingNo', 'orderNo', 'skuCode', 'pickedQty'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const picking = ws.pickings.byNo(params.pickingNo);
      if (!picking) throw new PickingNotFoundError(params.pickingNo);
      if (picking.state !== 'created') throw new PickingNotOpenError(params.pickingNo, picking.state);

      const sku = ws.skus.byCode(params.skuCode);
      const suggested = params.suggestedBatchNo ?? DEFAULT_BATCH_NO;
      const line = ws.pickings
        .lines(picking.id)
        .find((l) => l.orderNo === params.orderNo && l.skuId === sku?.id && l.suggestedBatchNo === suggested);
      const lineKey = `${params.orderNo}/${params.skuCode}@${suggested}`;
      if (!sku || !line) throw new PickingLineNotFoundError(params.pickingNo, lineKey);
      const order = ws.orders.byId(line.orderId);
      if (!order) throw new OrderNotFoundError(line.orderNo);
      const orderLine = ws.orders.lines(order.id).find((row) => orderLineKey(order.id, row) === line.orderLineId);
      if (!orderLine) throw new PickingLineNotFoundError(params.pickingNo, lineKey);

      const buckets = resolvePickAllocations(ws, line, params);
      const pickedQty = quantizeQty(buckets.reduce((sum, bucket) => sum + bucket.quantity, 0));
      if (params.pickedQty !== undefined) {
        const declared = assertNonNegativeQty(params.pickedQty, 'pickedQty');
        if (Math.abs(declared - pickedQty) > QTY_EPS) {
          throw new Error('TOOL_REJECTED: pickedQty 与各桶数量之和不一致');
        }
      }
      if (pickedQty > line.qtyToPick + QTY_EPS) {
        throw new PickingOverPickError(params.pickingNo, lineKey, line.qtyToPick, line.pickedQty, pickedQty);
      }

      const settings = readWmsSettings(ws);
      const batchConstraint = order.batchConstraint ?? settings.specifiedBatchConstraint;
      const locationConstraint = order.locationConstraint ?? settings.specifiedLocationConstraint;
      const promiseLocationCode = codeOfLocation(ws, orderLine.locationId);
      for (const bucket of buckets) {
        assertSubstitution({
          skuCode: sku.skuCode,
          serialTracked: sku.serialTracked,
          returnOrder: Boolean(order.returnOfOrderId),
          promiseLocationId: orderLine.locationId,
          promiseLocationCode,
          promiseBatchNo: orderLine.batchNo,
          actualLocationId: bucket.locationId,
          actualLocationCode: bucket.locationCode,
          actualBatchNo: bucket.batchNo,
          batchConstraint,
          locationConstraint,
        });
      }
      if (pickedQty > QTY_EPS) {
        const remainder = orderLine.quantity - pickedQty;
        const claims = mergeBuckets([
          ...buckets,
          ...(remainder > QTY_EPS
            ? [
                {
                  locationId: orderLine.locationId,
                  locationCode: promiseLocationCode,
                  batchNo: orderLine.batchNo,
                  quantity: remainder,
                },
              ]
            : []),
        ]);
        assertOutboundBuckets(
          ws,
          claims.map((claim) => ({
            skuId: orderLine.skuId,
            locationId: claim.locationId,
            batchNo: claim.batchNo,
            quantity: claim.quantity,
          })),
          [order.id],
        );
      }

      const picked = reservationMapForPick(ws, picking.id, line, buckets);
      const desired = desiredReservationClaims(
        ws.orders.lines(order.id).map((row) => ({
          lineId: orderLineKey(order.id, row),
          skuId: row.skuId,
          locationId: row.locationId,
          batchNo: row.batchNo,
          quantity: row.quantity,
        })),
        picked,
      );
      const sync = planReservationSync(ws, order, desired);
      const first = buckets[0];
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.pickingPicked, {
          pickingId: picking.id,
          pickingNo: picking.pickingNo,
          lineId: line.id,
          pickedQty,
          ...(first
            ? {
                pickedLocationId: first.locationId,
                pickedLocationCode: first.locationCode,
                pickedBatchNo: first.batchNo,
              }
            : {}),
          allocations: buckets.map((bucket) => ({
            locationId: bucket.locationId,
            locationCode: bucket.locationCode,
            batchNo: bucket.batchNo,
            quantity: bucket.quantity,
          })),
        });
        for (const release of sync.releases) {
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryReservationReleased, release);
        }
        for (const reserve of sync.reserves) {
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryReserved, reserve);
        }
      });
      ws.sync();
      return {
        pickingNo: picking.pickingNo,
        lineId: line.id,
        pickedQty,
        remainingToPick: Math.max(0, line.qtyToPick - pickedQty),
      };
    },
  };

  const pickingClose: ToolDefinition<{ pickingNo: string }> = {
    id: 'wms.picking.close',
    label: '拣货关单',
    description:
      '关单并按实拣扣减。拣货开着时出库单进入已拣货，库存按实拣扣掉；发货要再到出库单上做，不再扣第二次。拣货关着、单还停在拣货中时，关单直接发货并扣减。没开短发时每一行都要拣满。开了短发也要先录入实拣，没动过的行不能关成 0。短发按实拣数量入账，占用释放。以实拣桶做过期、余量、冻结和占用校验。原子落账。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { pickingNo: { type: 'string' } },
      required: ['pickingNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const picking = ws.pickings.byNo(params.pickingNo);
      if (!picking) throw new PickingNotFoundError(params.pickingNo);
      if (picking.state !== 'created') throw new PickingNotOpenError(params.pickingNo, picking.state);

      const lines = ws.pickings.lines(picking.id);
      const snapshot = ws.profile.getSnapshot();
      const partialOn = snapshot.modules['module.partial']?.enabled === true;
      const unfinished = lines.filter((line) => {
        if (line.pickedQty + QTY_EPS >= line.qtyToPick) return false;
        if (!partialOn) return true;
        return !line.confirmed && line.pickedQty <= QTY_EPS;
      });
      if (unfinished.length > 0) throw new PickingIncompleteError(params.pickingNo, unfinished.length);

      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION.out];
      if (!workflow) throw new WorkflowNotFoundError('out');
      const activeTransitions = workflow.transitions.filter((t) =>
        evalWhenCondition(t.when, snapshot.modules),
      );
      const ordersById = new Map<string, NonNullable<ReturnType<typeof ws.orders.byId>>>();
      const outbound: { skuId: string; locationId: string; batchNo: string; quantity: number }[] = [];
      const bucketsByLine = new Map<string, { locationId: string; batchNo: string; quantity: number }[]>();
      // 拣货开着时关单进入已拣货；边被拿掉或模块停用后，仍停在拣货中的单直接发货。
      const toState = canTransition(activeTransitions, 'picking', 'picked') ? 'picked' : 'shipped';
      for (const line of lines) {
        let order = ordersById.get(line.orderId);
        if (!order) {
          const found = ws.orders.byId(line.orderId);
          if (!found) throw new OrderNotFoundError(line.orderNo);
          order = found;
          ordersById.set(line.orderId, order);
          assertTransition(activeTransitions, 'out', order.state, toState);
        }
        const buckets = pickedBuckets(ws, line);
        bucketsByLine.set(line.id, buckets);
        for (const bucket of buckets) {
          outbound.push({
            skuId: line.skuId,
            locationId: bucket.locationId,
            batchNo: bucket.batchNo,
            quantity: bucket.quantity,
          });
        }
      }
      // 序列号先对单据上的库位批次。错桶即使没货，也要说明必须从指定桶拣出，而不是先报库存不足。
      const serialPlans = planPickingSerials(ws, lines);
      assertOutboundBuckets(ws, outbound, [...ordersById.keys()]);

      const adjustedLines: { orderNo: string; skuCode: string; locationCode: string; batchNo: string; delta: number }[] = [];
      const reason = `picking:${picking.pickingNo}`;
      ws.runAtomic(() => {
        for (const [orderId, order] of ordersById) {
          const fulfillments = lines
            .filter((line) => line.orderId === orderId && line.pickedQty + QTY_EPS < line.qtyToPick)
            .map((line) => {
              const promise = ws.orders
                .lines(orderId)
                .find((row) => orderLineKey(orderId, row) === line.orderLineId);
              if (!promise) throw new PickingLineNotFoundError(picking.pickingNo, line.orderLineId);
              return {
                skuId: promise.skuId,
                locationId: promise.locationId,
                batchNo: promise.batchNo,
                quantity: -line.pickedQty,
              };
            });
          ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
            orderId,
            orderNo: order.orderNo,
            direction: 'out',
            from: order.state,
            to: toState,
            ...(fulfillments.length > 0 ? { fulfillments } : {}),
          });
          for (const release of planReservationReleases(ws, order)) {
            ctx.appendEvent(WMS_EVENT_TYPES.inventoryReservationReleased, release);
          }
          for (const line of lines.filter((row) => row.orderId === orderId)) {
            const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
            for (const bucket of bucketsByLine.get(line.id) ?? []) {
              const locationCode = codeOfLocation(ws, bucket.locationId);
              ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
                skuId: line.skuId,
                skuCode,
                delta: -bucket.quantity,
                reason,
                locationId: bucket.locationId,
                locationCode,
                batchNo: bucket.batchNo,
                orderId,
                orderNo: line.orderNo,
              });
              adjustedLines.push({
                orderNo: line.orderNo,
                skuCode,
                locationCode,
                batchNo: bucket.batchNo,
                delta: -bucket.quantity,
              });
            }
          }
        }
        appendSerialPlans(ctx, serialPlans);
        ctx.appendEvent(WMS_EVENT_TYPES.pickingStateChanged, {
          pickingId: picking.id,
          pickingNo: picking.pickingNo,
          from: 'created',
          to: 'closed',
        });
      });
      ws.sync();
      return {
        pickingNo: picking.pickingNo,
        state: 'closed',
        orders: [...ordersById.values()].map((o) => ({ orderNo: o.orderNo, from: o.state, to: toState })),
        adjustedLines,
      };
    },
  };

  const pickingCancel: ToolDefinition<{ pickingNo: string }> = {
    id: 'wms.picking.cancel',
    label: '取消拣货单',
    description:
      '取消拣货单（只有「拣货中」状态可取消）。已录的实拣记录保留审计；关联出库单留在「拣货中」状态由人工处理（可再建新拣货单）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { pickingNo: { type: 'string' } },
      required: ['pickingNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const picking = ws.pickings.byNo(params.pickingNo);
      if (!picking) throw new PickingNotFoundError(params.pickingNo);
      if (picking.state !== 'created') throw new PickingNotOpenError(params.pickingNo, picking.state);
      ctx.appendEvent(WMS_EVENT_TYPES.pickingStateChanged, {
        pickingId: picking.id,
        pickingNo: picking.pickingNo,
        from: 'created',
        to: 'canceled',
      });
      ws.sync();
      return { pickingNo: picking.pickingNo, state: 'canceled' };
    },
  };

  const pickingQuery: ToolDefinition<{ pickingNo?: string }> = {
    id: 'wms.picking.query',
    label: '查询拣货单',
    description:
      '查拣货单：给 pickingNo 返回单张 + 明细行（建议桶/实拣量/实拣桶）；缺省返回全部拣货单清单（含状态）。纯读，不落事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { pickingNo: { type: 'string' } },
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (params.pickingNo) {
        const picking = ws.pickings.byNo(params.pickingNo);
        if (!picking) throw new PickingNotFoundError(params.pickingNo);
        return { picking, lines: ws.pickings.lines(picking.id) };
      }
      return { pickings: ws.pickings.list() };
    },
  };

  return [def(pickingCreate), def(pickingPick), def(pickingClose), def(pickingCancel), def(pickingQuery)];
}

function orderLineKey(
  orderId: string,
  line: { skuId: string; locationId: string; batchNo: string },
): string {
  return `${orderId}:${line.skuId}:${line.locationId}:${line.batchNo}`;
}

function resolvePickAllocations(
  ws: WmsWorkspace,
  line: PickingLineRecord,
  params: {
    pickedQty?: number;
    locationCode?: string;
    pickedBatchNo?: string;
    allocations?: { locationCode?: string; batchNo?: string; quantity: number }[];
  },
): PickBucket[] {
  if (params.allocations !== undefined) {
    if (!Array.isArray(params.allocations)) throw new Error('TOOL_REJECTED: allocations 必须是数组');
    const rows: PickBucket[] = [];
    for (const [i, item] of params.allocations.entries()) {
      const quantity = assertPositiveQty(item?.quantity, `第 ${i + 1} 桶数量`);
      const location =
        item.locationCode !== undefined
          ? resolveLocation(ws, item.locationCode)
          : suggestedLocation(ws, line);
      const batchNo =
        item.batchNo !== undefined && item.batchNo !== ''
          ? resolveBatch(item.batchNo, undefined).batchNo
          : line.suggestedBatchNo;
      rows.push({
        locationId: location.locationId,
        locationCode: location.locationCode,
        batchNo,
        quantity,
      });
    }
    return mergeBuckets(rows);
  }
  const pickedQty = assertNonNegativeQty(params.pickedQty, 'pickedQty');
  if (pickedQty <= QTY_EPS) return [];
  const location =
    params.locationCode !== undefined ? resolveLocation(ws, params.locationCode) : suggestedLocation(ws, line);
  const batchNo = params.pickedBatchNo ?? line.suggestedBatchNo;
  return [
    {
      locationId: location.locationId,
      locationCode: location.locationCode,
      batchNo,
      quantity: pickedQty,
    },
  ];
}

function suggestedLocation(ws: WmsWorkspace, line: PickingLineRecord): { locationId: string; locationCode: string } {
  return {
    locationId: line.suggestedLocationId,
    locationCode: codeOfLocation(ws, line.suggestedLocationId),
  };
}

/** 已经录入过的行用实绩；当前这一行用本次提交，空数组表示明确拣了 0。 */
function reservationMapForPick(
  ws: WmsWorkspace,
  pickingId: string,
  current: PickingLineRecord,
  buckets: readonly PickBucket[],
): Map<string, { locationId: string; batchNo: string; quantity: number }[]> {
  const picked = new Map<string, { locationId: string; batchNo: string; quantity: number }[]>();
  for (const line of ws.pickings.lines(pickingId)) {
    if (line.orderId !== current.orderId) continue;
    if (line.id === current.id) {
      picked.set(
        line.orderLineId,
        buckets.map((bucket) => ({
          locationId: bucket.locationId,
          batchNo: bucket.batchNo,
          quantity: bucket.quantity,
        })),
      );
      continue;
    }
    if (line.confirmed || line.pickedQty > QTY_EPS) {
      picked.set(line.orderLineId, pickedBuckets(ws, line));
    }
  }
  return picked;
}

function pickedBuckets(
  ws: WmsWorkspace,
  line: PickingLineRecord,
): { locationId: string; batchNo: string; quantity: number }[] {
  const stored = ws.pickings.allocations(line.id).filter((row) => row.quantity > QTY_EPS);
  if (stored.length > 0) return stored;
  if (line.pickedQty > QTY_EPS) {
    return [
      {
        locationId: line.pickedLocationId ?? line.suggestedLocationId,
        batchNo: line.pickedBatchNo ?? line.suggestedBatchNo,
        quantity: line.pickedQty,
      },
    ];
  }
  return [];
}
