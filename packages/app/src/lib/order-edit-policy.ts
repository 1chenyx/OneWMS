/**
 * 和 packages/wms/src/state/order-edit-policy.ts 同一套规则。
 * 界面只用来禁用字段；拒绝仍以服务端 wms.order.revise 为准。
 */

export interface OrderEditPolicy {
  readonly lines: boolean;
  readonly partner: boolean;
  readonly note: boolean;
  readonly expectedAt: boolean;
  readonly reason: string;
}

const CLOSED = new Set(['done', 'canceled']);

export function orderEditPolicy(order: {
  direction: 'in' | 'out';
  state: string;
  expectedAt?: string | null;
}): OrderEditPolicy {
  if (CLOSED.has(order.state)) {
    return { lines: false, partner: false, note: false, expectedAt: false, reason: '已结束的单据不能修改' };
  }
  const beforeStock =
    (order.direction === 'in' && (order.state === 'created' || order.state === 'announced')) ||
    (order.direction === 'out' && order.state === 'created');
  if (beforeStock) {
    const forecast = order.direction === 'in' && (order.state === 'announced' || order.expectedAt != null);
    return { lines: true, partner: true, note: true, expectedAt: forecast, reason: '' };
  }
  return {
    lines: false,
    partner: false,
    note: true,
    expectedAt: false,
    reason:
      order.direction === 'in'
        ? '已经收货入账，明细、库位、批次和往来单位不能改'
        : '已经拣货占用或已经发货，明细和往来单位不能改',
  };
}
