import { randomUUID } from 'node:crypto';
import { evalWhenCondition, type ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderNotFoundError,
  PickingExistsError,
  WaveDisabledError,
  WaveExistsError,
  WaveMembersMovedError,
  WaveNoOrdersError,
  WaveNotFoundError,
  WaveNotOpenError,
  WaveOrderStateError,
  WaveOrderTakenError,
  WavePickUnavailableError,
  PickingNoOrdersError,
  WorkflowNotFoundError,
} from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { resolveTransitionEffect } from '../state/inventory-effect.js';
import { assertOutboundBuckets, type OutboundBucketLine } from '../state/outbound-guards.js';
import { planReservations } from '../state/reservation.js';
import { assertTransition, WORKFLOW_BY_DIRECTION } from '../state/order-state-machine.js';
import { getWave } from '../queries/wave-queries.js';
import { buildPickingLines } from './picking-tools.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 波次把多张已创建的出库单收成一波。
 * create：生成波次号，各单进入已组波，不动库存。
 * pick：整波转入拣货中，并生成一张拣货单。数量按库位加总后一起验库存。
 * cancel：还没拣的波次解散，已组波的单回到已创建。
 */

export function createWaveTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const waveCreate: ToolDefinition<{ orderNos: string[]; note?: string; waveNo?: string }> = {
    id: 'wms.wave.create',
    label: '组成波次',
    description:
      '把一张或多张「已创建」的出库单组成一个波次。给出波次号，各单进入已组波，库存不动。同一库位同一商品的数量在波次页按库位加总，拣货员可以走一趟拣完。参数：orderNos（出库单号数组，至少一张）、note（可选）、waveNo（可选，不传或空着按编号规则 wave 生成）。已经在别的波次里的单不能再组。波次开着时不能用 wms.order.transition 直接改成已组波。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNos: { type: 'array', items: { type: 'string' }, description: '要放进同一波的出库单号' },
        note: { type: 'string', description: '备注（可选）' },
        waveNo: { type: 'string', description: '波次号（可选。不传或空着按编号规则生成）' },
      },
      required: ['orderNos'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertWaveOn(ws);
      const orderNos = uniqueOrderNos(params.orderNos);
      const waveId = randomUUID();
      const waveNo = allocateCode(ws, 'wave', params.waveNo);
      if (ws.waves.byNo(waveNo)) throw new WaveExistsError(waveNo);
      const orders = orderNos.map((orderNo) => {
        const order = ws.orders.byNo(orderNo);
        if (!order) throw new OrderNotFoundError(orderNo);
        const taken = ws.waves.activeForOrder(order.id);
        if (taken) throw new WaveOrderTakenError(orderNo, taken.waveNo);
        if (order.direction !== 'out' || order.state !== 'created') {
          throw new WaveOrderStateError(orderNo, order.direction === 'out' ? order.state : '入库单');
        }
        return order;
      });
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.waveCreated, {
          waveId,
          waveNo,
          orders: orders.map((order) => ({ orderId: order.id, orderNo: order.orderNo })),
          note: params.note,
        });
        for (const order of orders) {
          ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
            orderId: order.id,
            orderNo: order.orderNo,
            direction: 'out',
            from: 'created',
            to: 'waved',
          });
        }
      });
      ws.sync();
      return { waveId, waveNo, state: 'open', orderNos: orders.map((order) => order.orderNo) };
    },
  };

  const wavePick: ToolDefinition<{ waveNo: string; pickingNo?: string }> = {
    id: 'wms.wave.pick',
    label: '按波次拣货',
    description:
      '把一个未拣波次里的全部出库单一起转入拣货中，并生成一张拣货单。库存按这几张单加总后预检，不够则整波不动。拣货开着才用这一步。参数：waveNo、pickingNo（可选）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        waveNo: { type: 'string' },
        pickingNo: { type: 'string', description: '拣货单号（可选。不传或空着按编号规则生成）' },
      },
      required: ['waveNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const wave = ws.waves.byNo(params.waveNo);
      if (!wave) throw new WaveNotFoundError(params.waveNo);
      if (wave.state !== 'open') throw new WaveNotOpenError(wave.waveNo, wave.state);
      if (ws.profile.getSnapshot().modules['module.picking']?.enabled !== true) {
        throw new WavePickUnavailableError(wave.waveNo);
      }
      const orders = members(ws, wave.id);
      const moved = orders.filter((order) => order.state !== 'waved');
      if (moved.length > 0) {
        throw new WaveMembersMovedError(wave.waveNo, moved.map((order) => order.orderNo).join('、'));
      }
      const snapshot = ws.profile.getSnapshot();
      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION.out];
      if (!workflow) throw new WorkflowNotFoundError('out');
      const active = workflow.transitions.filter((edge) => evalWhenCondition(edge.when, snapshot.modules));
      for (const order of orders) assertTransition(active, 'out', order.state, 'picking');
      const edge = active.find((item) => item.from === 'waved' && item.to === 'picking');
      const resolved = resolveTransitionEffect('out', 'picking', edge?.effect, readWmsSettings(ws));
      const demand: OutboundBucketLine[] = [];
      for (const order of orders) {
        for (const line of ws.orders.lines(order.id)) {
          demand.push({
            skuId: line.skuId,
            locationId: line.locationId,
            batchNo: line.batchNo,
            quantity: line.quantity,
          });
        }
      }
      if (resolved.checkAvailability) {
        assertOutboundBuckets(ws, mergeBuckets(demand), orders.map((order) => order.id));
      }
      const reserves = orders.flatMap((order) =>
        resolved.checkAvailability && !resolved.post ? planReservations(ws, order, ws.orders.lines(order.id)) : [],
      );
      const pickingId = randomUUID();
      const pickingNo = allocateCode(ws, 'picking', params.pickingNo);
      if (ws.pickings.byNo(pickingNo)) throw new PickingExistsError(pickingNo);
      const lines = buildPickingLines(
        ws,
        pickingId,
        orders.map((order) => order.orderNo),
        'waved',
      );
      if (lines.length === 0) throw new PickingNoOrdersError();
      lines.sort(
        (a, b) =>
          a.suggestedLocationCode.localeCompare(b.suggestedLocationCode) ||
          a.skuCode.localeCompare(b.skuCode) ||
          a.orderNo.localeCompare(b.orderNo),
      );
      ws.runAtomic(() => {
        for (const order of orders) {
          ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
            orderId: order.id,
            orderNo: order.orderNo,
            direction: 'out',
            from: 'waved',
            to: 'picking',
          });
        }
        for (const reserve of reserves) ctx.appendEvent(WMS_EVENT_TYPES.inventoryReserved, reserve);
        ctx.appendEvent(WMS_EVENT_TYPES.pickingCreated, { pickingId, pickingNo, lines, note: wave.note ?? undefined });
        ctx.appendEvent(WMS_EVENT_TYPES.waveStateChanged, {
          waveId: wave.id,
          waveNo: wave.waveNo,
          from: 'open',
          to: 'picking',
          pickingNo,
        });
      });
      ws.sync();
      return {
        waveNo: wave.waveNo,
        state: 'picking',
        pickingNo,
        orderNos: orders.map((order) => order.orderNo),
        lineCount: lines.length,
      };
    },
  };

  const waveCancel: ToolDefinition<{ waveNo: string }> = {
    id: 'wms.wave.cancel',
    label: '取消波次',
    description:
      '取消一个还没拣的波次。还停在已组波的出库单回到已创建，可以重新组。已经拣货、发货或离开已组波的单不能靠取消波次回退。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { waveNo: { type: 'string' } },
      required: ['waveNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const wave = ws.waves.byNo(params.waveNo);
      if (!wave) throw new WaveNotFoundError(params.waveNo);
      if (wave.state !== 'open') throw new WaveNotOpenError(wave.waveNo, wave.state);
      const orders = members(ws, wave.id);
      const stuck = orders.filter((order) => order.state !== 'waved' && order.state !== 'canceled');
      if (stuck.length > 0) {
        throw new WaveMembersMovedError(wave.waveNo, stuck.map((order) => order.orderNo).join('、'));
      }
      const back = orders.filter((order) => order.state === 'waved');
      ws.runAtomic(() => {
        for (const order of back) {
          ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
            orderId: order.id,
            orderNo: order.orderNo,
            direction: 'out',
            from: 'waved',
            to: 'created',
          });
        }
        ctx.appendEvent(WMS_EVENT_TYPES.waveStateChanged, {
          waveId: wave.id,
          waveNo: wave.waveNo,
          from: 'open',
          to: 'canceled',
        });
      });
      ws.sync();
      return { waveNo: wave.waveNo, state: 'canceled', orderNos: back.map((order) => order.orderNo) };
    },
  };

  const waveQuery: ToolDefinition<{ waveNo?: string }> = {
    id: 'wms.wave.query',
    label: '查询波次',
    description:
      '查波次。给 waveNo 返回这一波的出库单，以及按库位、商品、批次加总的拣货清单。不给则返回全部波次。纯读，不落事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { waveNo: { type: 'string' } },
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (params.waveNo) {
        const wave = getWave(ws, params.waveNo);
        if (!wave) throw new WaveNotFoundError(params.waveNo);
        return { wave };
      }
      return {
        waves: ws.waves.list().map((wave) => ({
          ...wave,
          orderNos: ws.waves.orders(wave.id).map((row) => row.orderNo),
        })),
      };
    },
  };

  return [def(waveCreate), def(wavePick), def(waveCancel), def(waveQuery)];
}

function assertWaveOn(ws: WmsWorkspace): void {
  if (ws.profile.getSnapshot().modules['module.wave']?.enabled !== true) throw new WaveDisabledError();
}

function uniqueOrderNos(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new WaveNoOrdersError();
  const seen = new Set<string>();
  const orderNos: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) throw new WaveNoOrdersError();
    const orderNo = item.trim();
    if (seen.has(orderNo)) throw new Error(`TOOL_REJECTED: 出库单 ${orderNo} 重复了`);
    seen.add(orderNo);
    orderNos.push(orderNo);
  }
  return orderNos;
}

function members(ws: WmsWorkspace, waveId: string) {
  return ws.waves.orders(waveId).map((row) => {
    const order = ws.orders.byId(row.orderId);
    if (!order) throw new OrderNotFoundError(row.orderNo);
    return order;
  });
}

function mergeBuckets(lines: readonly OutboundBucketLine[]): OutboundBucketLine[] {
  const merged = new Map<string, OutboundBucketLine>();
  for (const line of lines) {
    const key = `${line.skuId}\u0000${line.locationId}\u0000${line.batchNo}`;
    const hit = merged.get(key);
    if (hit) {
      merged.set(key, { ...hit, quantity: hit.quantity + line.quantity });
      continue;
    }
    merged.set(key, { ...line });
  }
  return [...merged.values()];
}
