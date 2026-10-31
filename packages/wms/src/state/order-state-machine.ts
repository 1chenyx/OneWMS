import { InvalidTransitionError } from '../errors.js';

/**
 * 单据状态机（DESIGN.md §5.3：流程 = 表驱动数据）。
 *
 * M8 行为闭环：转移校验的数据源是调用方传入的 Profile workflows（配置即权威），
 * 本文件不再持有任何行为数据——`ORDER_TRANSITIONS` 只是 core.wms 种子的誊写源
 * （defaultWorkflows 消费，一致性由 profile-seed.test.ts 验证）。
 * 状态 id 是开放词汇（string）：模块可经 manifest.workflows.contributes 贡献新状态。
 * 条件求值（when: module.xxx.enabled）属配置层生长点，本文件不涉及。
 */

export type OrderDirection = 'in' | 'out';

export type OrderState =
  | 'created'
  | 'received'
  | 'picking'
  | 'shipped'
  | 'done'
  | 'canceled';

/** 流程转移声明（Profile workflows 的 transitions 形状） */
export interface TransitionEdge {
  readonly from: string;
  readonly to: string;
}

export interface StateTransition {
  readonly from: OrderState;
  readonly to: OrderState;
}

/** 方向 → Profile workflows 的流程 key（与前端 OrdersPage 同一约定） */
export const WORKFLOW_BY_DIRECTION: Readonly<Record<OrderDirection, string>> = {
  in: 'inbound',
  out: 'outbound',
};

/**
 * 基础转移表（种子誊写源，M8 起无行为消费方）：
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

/** 查询某状态的全部合法后继（UI 提示 / AI 上下文 / 错误信息用） */
export function transitionsFrom(transitions: readonly TransitionEdge[], from: string): string[] {
  return transitions.filter((t) => t.from === from).map((t) => t.to);
}

/** 单次转移是否合法（纯函数，无副作用） */
export function canTransition(transitions: readonly TransitionEdge[], from: string, to: string): boolean {
  return transitions.some((t) => t.from === from && t.to === to);
}

/** 断言转移合法，非法即抛 InvalidTransitionError（工具 handler 的校验入口） */
export function assertTransition(
  transitions: readonly TransitionEdge[],
  direction: OrderDirection,
  from: string,
  to: string,
): void {
  if (!canTransition(transitions, from, to)) {
    throw new InvalidTransitionError(direction, from, to, transitionsFrom(transitions, from));
  }
}

/** 是否终态（终态无任何出边——从转移表推导，不再硬编码状态词汇） */
export function isTerminalState(transitions: readonly TransitionEdge[], state: string): boolean {
  return transitionsFrom(transitions, state).length === 0;
}
