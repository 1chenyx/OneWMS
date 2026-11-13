/**
 * 单据还能改什么。服务端修订工具是权威，界面用同一套判断提前禁用。
 *
 * 单号、方向、状态、原单、补货标记一律不改。状态只走流转。
 * 明细、库位、批次、效期、数量、往来单位：库存还没动的时候才能改。
 *   入库 = created / announced（预报没收货）
 *   出库 = created（一进拣货就会占用可用量）
 * 已经收货、上架、拣货、发货：账已经记上或已经占用，明细和往来单位冻住。
 *   备注不碰库存，这些状态仍可改。
 * 已完成、已取消：整单是结案记录，备注也不改。
 * 预计到货日只属于到货预报。
 */

export interface OrderEditTarget {
  readonly direction: 'in' | 'out';
  readonly state: string;
  /** 可缺省：前端镜像的 HTTP 契约里这一项是可选的 */
  readonly expectedAt?: string | null;
}

export interface OrderEditPolicy {
  readonly lines: boolean;
  readonly partner: boolean;
  readonly note: boolean;
  readonly expectedAt: boolean;
  /** 空字符串表示当前没有锁。有字时说明为什么不能改那些字段。 */
  readonly reason: string;
}

const CLOSED = new Set(['done', 'canceled']);

export function orderEditPolicy(order: OrderEditTarget): OrderEditPolicy {
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
