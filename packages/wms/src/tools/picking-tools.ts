import { randomUUID } from 'node:crypto';
import { evalWhenCondition, type ToolDefinition } from '@one/core';
import { DEFAULT_BATCH_NO, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  InvalidTransitionError,
  OrderNotFoundError,
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
import { allocateFromBuckets } from '../state/allocation.js';
import { assertOutboundBuckets } from '../state/outbound-guards.js';
import { planReservationReleases } from '../state/reservation.js';
import { assertNonNegativeQty, codeOfLocation, QTY_EPS, resolveLocation } from '../state/inventory-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
} from '../state/order-state-machine.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 拣货单工具（M21）——聚合多张「拣货中」出库单的行成一张拣货单，picker 逐行
 * 实拣（可改实际拣货桶），关单统一扣减：
 *  - create：逐行生成建议桶（显式批次 → 该桶；DEFAULT 虚拟批次 → 按策略
 *    从行库位的余量桶装载首个——建议桶只是建议，硬校验在 close）；
 *  - pick：记实拣事实（不落库存流水）；pickedQty 是累计实拣量（后到者胜）；
 *  - close：全部行拣满 → 逐单按 outbound 流程（when 过滤后）断言可 shipped →
 *    assertOutboundBuckets 以实拣桶硬校验（过期/余量/冻结）→ runAtomic 原子落
 *    orderStateChanged(→shipped) + 逐行 inventoryAdjusted(−, reason picking:{no})
 *    + pickingClosed；
 *  - cancel：open 才可，已拣记录保留审计；订单留在拣货中人工处理；
 *  - query（read）：单张带行 / 全部清单。
 * 生命周期词汇固定 created → closed / canceled（M17 盘点先例，不进 Profile
 * workflows）；订单侧的流程校验仍走 outbound workflow 配置（when 过滤）。
 */
export function createPickingTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const pickingCreate: ToolDefinition<{
    orderNos: string[];
    note?: string;
  }> = {
    id: 'wms.picking.create',
    label: '创建拣货单',
    description:
      '聚合多张「拣货中」状态的出库单成一张拣货单（建议桶自动生成：行有显式批次用该桶，虚拟批次按 defaultAllocation 策略建议）。参数：orderNos（出库单号数组，至少一张）、note（可选）。行建议桶随事件携带；实拣与扣减发生在后续 pick/close。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNos: { type: 'array', items: { type: 'string' }, description: '出库单号数组（须为「拣货中」状态）' },
        note: { type: 'string', description: '备注（可选）' },
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
      const pickingNo = `PK-${today.replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
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
  }> = {
    id: 'wms.picking.pick',
    label: '录入实拣',
    description:
      '为拣货单一行录入实拣（不落库存流水，扣减发生在关单）。参数：pickingNo、orderNo、skuCode、suggestedBatchNo（定位行，缺省 DEFAULT）、pickedQty（本行累计实拣量，后到者胜，支持 3 位小数；必须 ≤ 应拣量）、locationCode/pickedBatchNo（实拣桶，缺省用建议桶）。picker 可改拣其他库位/批次的货——记录事实，关单按实拣桶校验与扣减。',
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
      const pickedQty = assertNonNegativeQty(params.pickedQty, 'pickedQty');
      if (pickedQty > line.qtyToPick + QTY_EPS) {
        throw new PickingOverPickError(params.pickingNo, lineKey, line.qtyToPick, line.pickedQty, params.pickedQty);
      }

      // 实拣桶：缺省建议桶；显式给出则解析校验（记录事实，硬校验在 close）
      const pickedLocation =
        params.locationCode !== undefined
          ? resolveLocation(ws, params.locationCode)
          : { locationId: line.suggestedLocationId, locationCode: codeOfLocation(ws, line.suggestedLocationId) };
      const pickedBatchNo = params.pickedBatchNo ?? line.suggestedBatchNo;

      ctx.appendEvent(WMS_EVENT_TYPES.pickingPicked, {
        pickingId: picking.id,
        pickingNo: picking.pickingNo,
        lineId: line.id,
        pickedQty,
        pickedLocationId: pickedLocation.locationId,
        pickedLocationCode: pickedLocation.locationCode,
        pickedBatchNo,
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
      '关单并统一扣减：全部行拣满（实拣量 = 应拣量）才可关单；逐张出库单按 outbound 流程（when 过滤后）断言可流转到 shipped；以实拣桶做过期/余量/冻结/占用硬校验（本单自己的占用不算）；原子落账——每单 shipped + 释放该单拣货占用 + 逐行扣减流水（reason: picking:单号）+ 拣货单 closed，同生共死。',
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
      const unpicked = lines.filter((l) => l.pickedQty < l.qtyToPick).length;
      if (unpicked > 0) throw new PickingIncompleteError(params.pickingNo, unpicked);

      // 逐单流程断言（when 过滤后的 outbound 活跃转移）+ 以实拣桶硬校验
      const snapshot = ws.profile.getSnapshot();
      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION.out];
      if (!workflow) throw new WorkflowNotFoundError('out');
      const activeTransitions = workflow.transitions.filter((t) =>
        evalWhenCondition(t.when, snapshot.modules),
      );
      const ordersById = new Map<string, NonNullable<ReturnType<typeof ws.orders.byId>>>();
      const outbound: { skuId: string; locationId: string; batchNo: string; quantity: number }[] = [];
      for (const line of lines) {
        let order = ordersById.get(line.orderId);
        if (!order) {
          const found = ws.orders.byId(line.orderId);
          if (!found) throw new OrderNotFoundError(line.orderNo);
          order = found;
          ordersById.set(line.orderId, order);
          assertTransition(activeTransitions, 'out', order.state, 'shipped');
        }
        outbound.push({
          skuId: line.skuId,
          locationId: line.pickedLocationId ?? line.suggestedLocationId,
          batchNo: line.pickedBatchNo ?? line.suggestedBatchNo,
          quantity: line.pickedQty,
        });
      }
      assertOutboundBuckets(ws, outbound, [...ordersById.keys()]);

      // 原子落账：拣货事件先于扣减事件的全序（每单 state → 逐行流水 → 拣货单 closed）
      const adjustedLines: { orderNo: string; skuCode: string; locationCode: string; batchNo: string; delta: number }[] = [];
      const reason = `picking:${picking.pickingNo}`;
      ws.runAtomic(() => {
        for (const [orderId, order] of ordersById) {
          ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
            orderId,
            orderNo: order.orderNo,
            direction: 'out',
            from: order.state,
            to: 'shipped',
          });
          for (const release of planReservationReleases(ws, order)) {
            ctx.appendEvent(WMS_EVENT_TYPES.inventoryReservationReleased, release);
          }
          for (const line of lines.filter((l) => l.orderId === orderId)) {
            const locationId = line.pickedLocationId ?? line.suggestedLocationId;
            const batchNo = line.pickedBatchNo ?? line.suggestedBatchNo;
            const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
            ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
              skuId: line.skuId,
              skuCode,
              delta: -line.pickedQty,
              reason,
              locationId,
              locationCode: codeOfLocation(ws, locationId),
              batchNo,
              orderId,
              orderNo: line.orderNo,
            });
            adjustedLines.push({
              orderNo: line.orderNo,
              skuCode,
              locationCode: codeOfLocation(ws, locationId),
              batchNo,
              delta: -line.pickedQty,
            });
          }
        }
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
        orders: [...ordersById.values()].map((o) => ({ orderNo: o.orderNo, from: o.state, to: 'shipped' })),
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
