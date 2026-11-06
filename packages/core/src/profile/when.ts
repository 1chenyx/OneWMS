/**
 * WorkflowTransition.when 条件的运行时求值器（§5.3 表达式口子的运行时半边）。
 *
 * 语法域由 validate.ts 在 patch 时静态证明（v1 只认
 * `module.{id}.enabled` / `!module.{id}.enabled`）；本函数消费已入库的
 * when 字符串，按当前 modules 配置求值——条件不满足的转移视为不存在。
 *
 * 消费方：领域包的流程校验（如 wms 的 order.transition）、前端流程图渲染。
 * 无法识别的模式保守返回 false（配置脏数据不放大为「放行」）。
 */

import type { ModuleConfig } from './profile-types.js';

/** when 表达式的解析形态：`{moduleId}.enabled`（可带 `!` 前缀；moduleId 含 module. 前缀本身） */
interface WhenPattern {
  readonly negated: boolean;
  readonly moduleId: string;
}

/** 与 validate.ts 的 WHEN_RE 同域：捕获组 = 完整模块 id（如 module.putaway） */
const PATTERN_RE = /^(!?)(module\.[A-Za-z0-9][A-Za-z0-9._-]*)\.enabled$/;

function parseWhen(when: string): WhenPattern | undefined {
  const m = PATTERN_RE.exec(when.trim());
  if (!m) return undefined;
  return { negated: m[1] === '!', moduleId: m[2] };
}

/**
 * 求值单个 when 条件（moduleId 为完整模块 id，如 module.putaway）：
 *  - when 为 undefined / 空串 → 无条件成立（true）
 *  - `{moduleId}.enabled` → 已安装且启用
 *  - `!{moduleId}.enabled` → 未安装或停用
 *  - 语法无法识别 → false（保守：脏配置不放行）
 */
export function evalWhenCondition(
  when: string | undefined,
  modules: Record<string, ModuleConfig>,
): boolean {
  if (when === undefined || when.trim() === '') return true;
  const pattern = parseWhen(when);
  if (!pattern) return false;
  const enabled = modules[pattern.moduleId]?.enabled === true;
  return pattern.negated ? !enabled : enabled;
}
