import type { FieldSharing } from './field-registry.js';

/**
 * 字段键命名规则（无状态纯函数，DESIGN.md §7.2）。
 *
 * private 字段自动加模块前缀（module.promo 提供 note → promo__note），
 * 从机制上消除两个模块的无意撞名；shared 字段原样使用。
 */
export function privatePrefix(moduleId: string): string {
  const stripped = moduleId.startsWith('module.') ? moduleId.slice('module.'.length) : moduleId;
  return stripped === 'core' ? '' : stripped;
}

/** private 字段的存储键；shared 字段原样返回 */
export function qualifyKey(moduleId: string, key: string, sharing: FieldSharing): string {
  if (sharing !== 'private') return key;
  const prefix = privatePrefix(moduleId);
  return prefix ? `${prefix}__${key}` : key;
}
