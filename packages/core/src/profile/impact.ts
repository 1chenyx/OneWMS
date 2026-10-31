import type { ValidationIssue } from './validate.js';
import type { ProfileSnapshot } from './profile-types.js';

/**
 * 影响报告生成（DESIGN.md §7.3 终极兜底，纯函数）。
 *
 * 对「应用前 / 应用后」两份快照做结构 diff，产出分条目的中文报告——
 * 检测机械化、裁决人类化（§4.5）：报告只陈述事实与风险，不做决定。
 *
 * v1 边界（§9.1 预演关的简化）：只做配置层 diff，不扫业务数据行数
 * （ext_data 行数统计需要领域表知识，跨层——见 ARCHITECTURE.md 生长点）。
 */

export type ImpactSeverity = 'info' | 'warning';

export interface ImpactItem {
  severity: ImpactSeverity;
  /** 变更类型（机器可读）：field.added / field.hidden / workflow.state.added / module.enabled … */
  kind: string;
  /** 变更对象：'sku.spec' / 'outbound' / 'module.expiry' */
  target: string;
  /** 中文人话（确认界面 / AI 转述的原文） */
  description: string;
}

export interface ImpactReport {
  /** 一句话概述（前 x 项 + 总数，供 AI 转述开场） */
  summary: string;
  items: ImpactItem[];
}

/** 生成影响报告：before/after 为应用前后快照，warnings 为校验管线的软提示 */
export function buildImpactReport(
  before: ProfileSnapshot,
  after: ProfileSnapshot,
  warnings: ValidationIssue[] = [],
): ImpactReport {
  const items: ImpactItem[] = [];

  // ── 字段层（schema.entities）─────────────────────────
  const entities = new Set([...Object.keys(before.schema.entities), ...Object.keys(after.schema.entities)]);
  for (const entity of entities) {
    const beforeFields = new Map((before.schema.entities[entity]?.extensions ?? []).map((f) => [f.key, f]));
    const afterFields = new Map((after.schema.entities[entity]?.extensions ?? []).map((f) => [f.key, f]));

    for (const [key, f] of afterFields) {
      const prev = beforeFields.get(key);
      if (!prev) {
        items.push({
          severity: 'info',
          kind: 'field.added',
          target: `${entity}.${key}`,
          description: `新增字段「${f.label}」（${entity}.${key}，类型 ${f.type}，提供者 ${f.providedBy}${f.visible ? '' : '，初始隐藏'}）`,
        });
      } else if (prev.visible !== f.visible) {
        items.push({
          severity: 'info',
          kind: f.visible ? 'field.restored' : 'field.hidden',
          target: `${entity}.${key}`,
          description: f.visible
            ? `恢复字段「${f.label}」（${entity}.${key}）的可见性`
            : `隐藏字段「${f.label}」（${entity}.${key}）——已录入的数据会保留，只是不再显示`,
        });
      }
    }
    for (const [key, f] of beforeFields) {
      if (!afterFields.has(key)) {
        // 正常不会出现（校验关拒绝 remove），防御性提示
        items.push({
          severity: 'warning',
          kind: 'field.removed',
          target: `${entity}.${key}`,
          description: `字段「${f.label}」（${entity}.${key}）被移除（不应发生——删除字段被校验拒绝）`,
        });
      }
    }
  }

  // ── 流程层（workflows）───────────────────────────────
  const workflows = new Set([...Object.keys(before.workflows), ...Object.keys(after.workflows)]);
  for (const wfId of workflows) {
    const b = before.workflows[wfId];
    const a = after.workflows[wfId];

    if (!b && a) {
      items.push({
        severity: 'info',
        kind: 'workflow.added',
        target: wfId,
        description: `新增流程「${wfId}」（${a.states.length} 个状态）`,
      });
      continue;
    }
    if (b && !a) {
      items.push({
        severity: 'warning',
        kind: 'workflow.removed',
        target: wfId,
        description: `删除流程「${wfId}」（原有 ${b.states.length} 个状态）`,
      });
      continue;
    }
    if (!b || !a) continue;

    const bStates = new Map(b.states.map((s) => [s.id, s]));
    const aStates = new Map(a.states.map((s) => [s.id, s]));
    for (const [id, s] of aStates) {
      if (!bStates.has(id)) {
        items.push({
          severity: 'info',
          kind: 'workflow.state.added',
          target: `${wfId}.${id}`,
          description: `流程「${wfId}」新增状态「${s.label}」（${id}${s.providedBy ? `，来自 ${s.providedBy}` : ''}）`,
        });
      }
    }
    for (const [id, s] of bStates) {
      if (!aStates.has(id)) {
        items.push({
          severity: 'warning',
          kind: 'workflow.state.removed',
          target: `${wfId}.${id}`,
          description: `流程「${wfId}」移除状态「${s.label}」（${id}）——已有单据若处于该状态将无法继续流转`,
        });
      }
    }

    const bTrans = new Set(b.transitions.map((t) => `${t.from}→${t.to}${t.when ? ` [${t.when}]` : ''}`));
    const aTrans = new Set(a.transitions.map((t) => `${t.from}→${t.to}${t.when ? ` [${t.when}]` : ''}`));
    for (const t of aTrans) {
      if (!bTrans.has(t)) {
        items.push({ severity: 'info', kind: 'workflow.transition.added', target: `${wfId}`, description: `流程「${wfId}」新增转移 ${t}` });
      }
    }
    for (const t of bTrans) {
      if (!aTrans.has(t)) {
        items.push({
          severity: 'warning',
          kind: 'workflow.transition.removed',
          target: `${wfId}`,
          description: `流程「${wfId}」移除转移 ${t}——依赖该路径的单据流转将不可用`,
        });
      }
    }
  }

  // ── 模块层（modules）─────────────────────────────────
  const modules = new Set([...Object.keys(before.modules), ...Object.keys(after.modules)]);
  for (const modId of modules) {
    const b = before.modules[modId];
    const a = after.modules[modId];

    if (!b && a) {
      items.push({
        severity: 'info',
        kind: 'module.added',
        target: modId,
        description: `新增模块配置「${modId}」（${a.enabled ? '启用' : '停用'}）`,
      });
      continue;
    }
    if (b && !a) {
      items.push({ severity: 'warning', kind: 'module.removed', target: modId, description: `移除模块配置「${modId}」` });
      continue;
    }
    if (!b || !a) continue;

    if (b.enabled !== a.enabled) {
      items.push({
        severity: 'info',
        kind: a.enabled ? 'module.enabled' : 'module.disabled',
        target: modId,
        description: `模块「${modId}」${a.enabled ? '启用' : '停用'}——引用其开关的流程条件将随之变化`,
      });
    }
    if (JSON.stringify(b.settings) !== JSON.stringify(a.settings)) {
      items.push({
        severity: 'info',
        kind: 'module.settings',
        target: modId,
        description: `模块「${modId}」的参数被修改`,
      });
    }
  }

  // ── 校验软提示（连通性之外的死锁风险等）──────────────
  for (const w of warnings) {
    items.push({ severity: 'warning', kind: w.code, target: '-', description: w.message });
  }

  return { summary: summarize(items), items };
}

function summarize(items: ImpactItem[]): string {
  if (items.length === 0) return '无实际变更（空 patch 或全部操作无效果）';
  const warningCount = items.filter((i) => i.severity === 'warning').length;
  const head = items.slice(0, 3).map((i) => i.description).join('；');
  const rest = items.length > 3 ? ` 等 ${items.length} 项` : '';
  return warningCount > 0
    ? `${head}${rest}。其中 ${warningCount} 项需要特别注意`
    : `${head}${rest}`;
}
