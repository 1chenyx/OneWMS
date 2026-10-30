import { InvalidTransitionError } from '../errors.js';

/**
 * 单据状态机（DESIGN.md §5.3：流程 = 表驱动数据）。
 *
 * v1 固定两张基础流程（入库/出库）；未来模块经 manifest 的
 * workflows.contributes 向这里叠加状态与转移（里程碑 6），转移表仍是唯一真相。
 * 条件求值（when: module.xxx.enabled）属配置层，本文件不涉及。
 */

export type OrderDirection = 'in' | 'out';

export type OrderState =
  | 'created'
  | 'received'
  | 'picking'
  | 'shipped'
  | 'done'
  | 'canceled';

export interface StateTransition {
  readonly from: OrderState;
  readonly to: OrderState;
}

/**
 * 基础转移表：
 *  - 入库：created → received → done
 *  - 出库：created → picking → shipped → done
 *  - 取消：未完成收/发货前可取消（created / picking）
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderDirection, readonly StateTransition[]>> = {
  in: [
    { from: 'created', to: 'received' },
    { from: 'received', to: 'done' },
    { from: 'created', to: 'canceled' },
  ],
  out: [
    { from: 'created', to: 'picking' },
    { from: 'picking', to: 'shipped' },
    { from: 'shipped', to: 'done' },
    { from: 'created', to: 'canceled' },
    { from: 'picking', to: 'canceled' },
  ],
};

/** 查询某方向某状态的全部合法后继（UI 提示 / AI 上下文用） */
export function transitionsFrom(direction: OrderDirection, from: OrderState): OrderState[] {
  return ORDER_TRANSITIONS[direction].filter((t) => t.from === from).map((t) => t.to);
}

/** 单次转移是否合法（纯函数，无副作用） */
export function canTransition(direction: OrderDirection, from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[direction].some((t) => t.from === from && t.to === to);
}

/** 断言转移合法，非法即抛 InvalidTransitionError（工具 handler 的校验入口） */
export function assertTransition(
  direction: OrderDirection,
  from: OrderState,
  to: OrderState,
): void {
  if (!canTransition(direction, from, to)) {
    throw new InvalidTransitionError(direction, from, to, transitionsFrom(direction, from));
  }
}

/** 是否终态（终态无任何出边） */
export function isTerminalState(state: OrderState): boolean {
  return state === 'done' || state === 'canceled';
}
