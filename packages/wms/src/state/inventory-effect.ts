import type { WorkflowEffect } from '@one/core';
import type { OrderDirection } from './order-state-machine.js';

/**
 * 单据 → 库存联动策略——纯函数，无 IO。
 *
 * 优先级：
 *  1. 转移上显式 effect（模块贡献或慢通道写入）——配置即权威；
 *  2. 否则看 core.wms settings 的效应状态名（缺省 received / shipped / picking）；
 *  3. 都未命中 → 不动库存。
 *
 * 未配置 settings = 旧行为。投影层不消费本文件。
 */

/** 库存效应方向：入库收货 +，出库发货 - */
export interface StockEffect {
  readonly kind: 'increase' | 'decrease';
}

/** 效应状态名（来自 core.wms settings，已窄化） */
export interface EffectStateSettings {
  readonly inboundIncreaseState: string;
  readonly outboundDecreaseState: string;
  readonly outboundCheckState: string;
}

export const DEFAULT_EFFECT_STATES: EffectStateSettings = {
  inboundIncreaseState: 'received',
  outboundDecreaseState: 'shipped',
  outboundCheckState: 'picking',
};

/** 一条转移最终要做的事：过账方向，以及过账前是否验可用量 */
export interface ResolvedTransitionEffect {
  readonly post?: 'increase' | 'decrease';
  readonly checkAvailability: boolean;
}

/**
 * 进入 toState 是否触发库存效应（无显式 effect 时的约定路径）。
 * settings 缺省 = received / shipped。
 */
export function stockEffectOf(
  direction: OrderDirection,
  toState: string,
  settings: EffectStateSettings = DEFAULT_EFFECT_STATES,
): StockEffect | undefined {
  if (direction === 'in' && toState === settings.inboundIncreaseState) return { kind: 'increase' };
  if (direction === 'out' && toState === settings.outboundDecreaseState) return { kind: 'decrease' };
  return undefined;
}

/**
 * 进入 toState 前是否需要余量预检。缺省 = 出库进入 picking。
 * 非真实预占——预检与扣减之间库存仍可被挪用，由扣减硬守卫兜底。
 */
export function requiresAvailabilityCheck(
  direction: OrderDirection,
  toState: string,
  settings: EffectStateSettings = DEFAULT_EFFECT_STATES,
): boolean {
  return direction === 'out' && toState === settings.outboundCheckState;
}

/** 单条转移的效应：显式 effect 优先，否则回落到状态约定 */
export function resolveTransitionEffect(
  direction: OrderDirection,
  toState: string,
  effect: WorkflowEffect | undefined,
  settings: EffectStateSettings = DEFAULT_EFFECT_STATES,
): ResolvedTransitionEffect {
  if (effect === 'none') return { checkAvailability: false };
  if (effect === 'check') return { checkAvailability: true };
  if (effect === 'increase') return { post: 'increase', checkAvailability: false };
  if (effect === 'decrease') return { post: 'decrease', checkAvailability: true };
  const posted = stockEffectOf(direction, toState, settings);
  return {
    post: posted?.kind,
    checkAvailability: posted?.kind === 'decrease' || requiresAvailabilityCheck(direction, toState, settings),
  };
}
