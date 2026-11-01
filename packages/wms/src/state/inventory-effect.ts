import type { OrderDirection } from './order-state-machine.js';

/**
 * 单据 → 库存联动策略（M9）——纯函数，无 IO。
 *
 * 效应词表 v1 采用状态约定（received / shipped），与 ORDER_TRANSITIONS 作为
 * 种子誊写源的定位一致（配置面成熟前的约定期）；效应点配置化（模块 settings
 * 声明效应状态）是生长点，settings 值读写管道落地后迁移。自定义流程若改名
 * 效应状态，联动不生效——文档级语义，非运行时校验。
 *
 * 消费方：tools/wms-tools.ts 的 orderTransition（命令侧护栏 + 事件发射）。
 * 投影层不消费本文件——投影只笨拙照实记录，不埋业务策略。
 */

/** 库存效应方向：入库收货 +，出库发货 - */
export interface StockEffect {
  readonly kind: 'increase' | 'decrease';
}

/**
 * 进入 toState 是否触发库存效应：
 *  - in + received → increase（收货即上架，逐行落流水）
 *  - out + shipped → decrease（发货即扣减，余量硬守卫）
 *  - 其余状态（done / canceled / 自定义状态）→ 无效应
 */
export function stockEffectOf(direction: OrderDirection, toState: string): StockEffect | undefined {
  if (direction === 'in' && toState === 'received') return { kind: 'increase' };
  if (direction === 'out' && toState === 'shipped') return { kind: 'decrease' };
  return undefined;
}

/**
 * 进入 toState 前是否需要余量预检：出库进入 picking（拣货）时 fail-fast。
 * 非真实预占——picking 与 shipped 之间库存仍可被其他单据/手动调整挪用，
 * 由 shipped 的硬守卫兜底拒绝；真预占（reserved 字段 + 预占/释放事件）是生长点。
 */
export function requiresAvailabilityCheck(direction: OrderDirection, toState: string): boolean {
  return direction === 'out' && toState === 'picking';
}
