import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { OrderConflictClosedError, OrderConflictNotFoundError, OrderNotFoundError } from '../errors.js';
import { applyOrderTransition } from './order-tools.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 单据状态冲突的人工裁决。
 * 接受 = 从当前状态再走一次合法转移（会按该转移的效应动库存），然后关掉队列行。
 * 当前状态到不了目标时拒绝，库存不动，队列保持打开。
 * 驳回 = 只关队列，单据状态与库存都不变。
 */
export function createOrderConflictTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const list: ToolDefinition<Record<string, never>> = {
    id: 'wms.order.conflict.list',
    label: '未裁决的状态冲突',
    description:
      '列出尚未裁决的单据状态冲突（并发改同一张单时，后到的状态事件不会改单据，进队列）。每行含 eventId、单号、事件声明的 from/to、当时的实际状态。纯读。',
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return { conflicts: ws.orders.listConflicts('open') };
    },
  };

  const accept: ToolDefinition<{ eventId: string }> = {
    id: 'wms.order.conflict.accept',
    label: '接受状态冲突',
    description:
      '接受一条未裁决的状态冲突：按单据当前状态，再执行一次到冲突目标状态的合法转移（库存效应跟那条转移走），并关闭冲突。当前流程不允许这条转移时拒绝，不改库存。eventId 来自 wms.order.conflict.list。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string', description: '冲突事件 id' } },
      required: ['eventId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const conflict = ws.orders.conflictByEventId(params.eventId);
      if (!conflict) throw new OrderConflictNotFoundError(params.eventId);
      if (conflict.status !== 'open') throw new OrderConflictClosedError(params.eventId);
      const order = ws.orders.byId(conflict.orderId);
      if (!order) throw new OrderNotFoundError(conflict.orderNo);
      // 转移自己有事务。失败则队列保持打开。不要把它套进外层事务：
      // 里面的 sync() 会推进内存游标，外层回滚只撤 SQL，游标对不上。
      const transition =
        order.state === conflict.toState
          ? undefined
          : applyOrderTransition(ws, ctx, { orderNo: conflict.orderNo, to: conflict.toState });
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderConflictAccepted, {
          eventId: conflict.eventId,
          orderId: conflict.orderId,
          orderNo: conflict.orderNo,
        });
      });
      ws.sync();
      return { eventId: conflict.eventId, orderNo: conflict.orderNo, status: 'accepted' as const, transition };
    },
  };

  const dismiss: ToolDefinition<{ eventId: string }> = {
    id: 'wms.order.conflict.dismiss',
    label: '驳回状态冲突',
    description:
      '驳回一条未裁决的状态冲突：单据停在当前状态，不改库存，只把队列行标成已驳回。eventId 来自 wms.order.conflict.list。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string', description: '冲突事件 id' } },
      required: ['eventId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const conflict = ws.orders.conflictByEventId(params.eventId);
      if (!conflict) throw new OrderConflictNotFoundError(params.eventId);
      if (conflict.status !== 'open') throw new OrderConflictClosedError(params.eventId);
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderConflictDismissed, {
          eventId: conflict.eventId,
          orderId: conflict.orderId,
          orderNo: conflict.orderNo,
        });
      });
      ws.sync();
      return { eventId: conflict.eventId, orderNo: conflict.orderNo, status: 'dismissed' as const };
    },
  };

  return [def(list), def(accept), def(dismiss)];
}
