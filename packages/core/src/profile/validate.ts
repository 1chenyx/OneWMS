import type {
  ConfigState,
  PatchOp,
  ProfileSnapshot,
  WorkflowDef,
} from './profile-types.js';
import { PATCH_ROOTS } from './profile-types.js';
import { applyPatch, parsePointer } from './patch.js';

/**
 * 校验管线（DESIGN.md §9.1 三关的 v1 实现，纯函数）。
 *
 * ① 语法关：patch 结构合法 + 路径根白名单 + 字段操作形态约束；
 * ② 语义关：对「应用后的虚拟快照」做结构校验与流程连通性（图算法）；
 * ③ 预演关在本模块之外——impact.ts 生成影响报告（v1 为结构 diff）。
 *
 * 检测机械化（§4.5）：一切可静态判断的在此判定；语义取舍交人类（影响报告）。
 * error 阻断应用；warning 不阻断，进影响报告由人裁决。
 */

export interface ValidationIssue {
  /** 机器可读错误码（PROFILE_ 前缀族之外的场景码见各处字面量） */
  code: string;
  severity: 'error' | 'warning';
  /** 中文人话（面向确认界面 / AI 转述） */
  message: string;
  /** 相关 patch 路径（可选） */
  path?: string;
}

export interface ValidationResult {
  /** error 级问题（非空 = 拒绝提议） */
  errors: ValidationIssue[];
  /** warning 级问题（进影响报告） */
  warnings: ValidationIssue[];
  /** 应用后的虚拟快照（供影响报告 diff；有 error 时仍尽力给出） */
  candidate: ProfileSnapshot;
}

const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;
const WHEN_RE = /^!?(module\.[A-Za-z0-9][A-Za-z0-9._-]*)\.enabled$/;

/**
 * 校验一个 patch：语法 → 应用 → 语义。任何一步的 error 都会收集（不短路的完整清单，
 * 便于 AI 一次修正全部问题），应用失败时 candidate 原样返回快照。
 */
export function validatePatch(snapshot: ProfileSnapshot, patch: PatchOp[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ── ① 语法关 ──────────────────────────────────────────
  for (const op of patch) {
    const path = op.path;

    if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') {
      errors.push(issue('PATCH_OP', `不支持的操作 "${String((op as { op: string }).op)}"（只允许 add/replace/remove）`, path));
      continue;
    }
    if ((op.op === 'add' || op.op === 'replace') && op.value === undefined) {
      errors.push(issue('PATCH_VALUE', `${op.op} 操作缺少 value`, path));
    }

    const root = `/${parsePointer(path)[0] ?? ''}`;
    if (!(PATCH_ROOTS as readonly string[]).includes(root)) {
      errors.push(issue('PATCH_ROOT', `路径根不在白名单: "${path}"（只允许 ${PATCH_ROOTS.join(' ')}）`, path));
      continue;
    }

    // 字段操作形态约束（§5.2 软删除铁律 + M4 范围）
    if (root === '/schema') {
      validateSchemaOp(op, errors);
    }
    if (root === '/roles') {
      errors.push(issue('ROLES_FROZEN', 'roles 为预留空 key（v1 冻结），不允许修改', path));
    }
  }

  // ── ② 应用（语法全错时跳过，避免无意义报错淹没）──────
  // 应用前规范化（只在虚拟快照上，不改 patch 原文）：
  //  a) add extension 的 visible 缺省补 true（与注册表 provide 默认一致）；
  //  b) 向尚无扩展字段的实体 add 第一个字段时补 { extensions: [] }
  //     （新实体对注册表只是字符串键，provide 天然支持）。
  let candidate = snapshot;
  if (errors.length === 0) {
    // 只规范化 /schema/** 下的 add（字段 visible 缺省补 true）
    const isSchemaAdd = (op: PatchOp): op is { op: 'add'; path: string; value: unknown } =>
      op.op === 'add' && op.path.startsWith('/schema/');
    const needsClone = patch.some(
      (op) => isSchemaAdd(op) && (op.value as { visible?: unknown } | undefined)?.visible === undefined,
    );
    const normalized = needsClone
      ? patch.map((op) =>
          isSchemaAdd(op) && (op.value as { visible?: unknown } | undefined)?.visible === undefined
            ? { ...op, value: { ...(op.value as object), visible: true } }
            : op,
        )
      : patch;

    const missingEntities = new Set<string>();
    for (const op of normalized) {
      if (op.op !== 'add') continue;
      const seg = parsePointer(op.path);
      if (
        seg[0] === 'schema' && seg[1] === 'entities' && seg[3] === 'extensions' &&
        snapshot.schema.entities[seg[2]] === undefined
      ) {
        missingEntities.add(seg[2]);
      }
    }
    candidate = snapshot;
    if (missingEntities.size > 0) {
      candidate = structuredClone(snapshot);
      for (const e of missingEntities) candidate.schema.entities[e] = { extensions: [] };
    }
    try {
      candidate = applyPatch(candidate, normalized);
    } catch (e) {
      errors.push(issue('PATCH_APPLY', `patch 无法应用: ${(e as Error).message}`));
      candidate = snapshot;
    }
  }

  // ── ③ 语义关（对虚拟快照）────────────────────────────
  validateSemantics(candidate, errors, warnings);

  return { errors, warnings, candidate };
}

// ── 字段操作约束 ─────────────────────────────────────────

/** /schema/** 只允许两种形态：add 整个 extension 对象、replace visible 布尔 */
function validateSchemaOp(op: PatchOp, errors: ValidationIssue[]): void {
  const segments = parsePointer(op.path);

  if (op.op === 'remove') {
    errors.push(issue('FIELD_REMOVE_FORBIDDEN', '禁止删除字段（数据永不丢失）——隐藏字段请用 replace visible:false', op.path));
    return;
  }

  // add /schema/entities/{entity}/extensions/-（value 必须是完整字段定义；段数 5）
  if (op.op === 'add') {
    if (segments.length !== 5 || segments[0] !== 'schema' || segments[1] !== 'entities' || segments[3] !== 'extensions') {
      errors.push(issue('FIELD_ADD_SHAPE', `新增字段的路径必须是 /schema/entities/{实体}/extensions/-，实际 "${op.path}"`, op.path));
      return;
    }
    const v = op.value as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(issue('FIELD_ADD_VALUE', '新增字段的 value 必须是完整的字段定义对象', op.path));
      return;
    }
    if (typeof v.key !== 'string' || !v.key) {
      errors.push(issue('FIELD_ADD_VALUE', '新增字段缺少 key（非空字符串）', op.path));
    }
    if (typeof v.label !== 'string' || !v.label) {
      errors.push(issue('FIELD_ADD_VALUE', `字段 ${String(v.key)} 缺少 label（非空字符串）`, op.path));
    }
    if (!(FIELD_TYPES as readonly string[]).includes(v.type as string)) {
      errors.push(issue('FIELD_ADD_VALUE', `字段 ${String(v.key)} 的 type 必须是 ${FIELD_TYPES.join('/')} 之一`, op.path));
    }
    if (typeof v.providedBy !== 'string' || !v.providedBy) {
      errors.push(issue('FIELD_ADD_VALUE', `字段 ${String(v.key)} 缺少 providedBy（提供者，如 'core'）`, op.path));
    }
    if (v.visible !== undefined && typeof v.visible !== 'boolean') {
      errors.push(issue('FIELD_ADD_VALUE', `字段 ${String(v.key)} 的 visible 必须是布尔值`, op.path));
    }
    return;
  }

  // replace /schema/entities/{entity}/extensions/{idx}/visible（段数 6）
  if (op.op === 'replace') {
    const ok =
      segments.length === 6 &&
      segments[0] === 'schema' &&
      segments[1] === 'entities' &&
      segments[3] === 'extensions' &&
      segments[4] !== undefined &&
      /^\d+$/.test(segments[4]) &&
      segments[5] === 'visible';
    if (!ok) {
      errors.push(issue('FIELD_REPLACE_SHAPE', `字段只允许 replace .../visible（改 label/type 属于模块系统职责），实际 "${op.path}"`, op.path));
      return;
    }
    if (typeof op.value !== 'boolean') {
      errors.push(issue('FIELD_REPLACE_VALUE', 'visible 的值必须是布尔', op.path));
    }
  }
}

// ── 语义关：结构 + 连通性 ────────────────────────────────

function validateSemantics(s: ProfileSnapshot, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  // schema：字段结构 + 同实体 key 唯一
  for (const [entity, def] of Object.entries(s.schema.entities)) {
    const seen = new Set<string>();
    for (const ext of def.extensions) {
      if (!ext.key || typeof ext.key !== 'string') {
        errors.push(issue('FIELD_KEY', `实体 ${entity} 存在无 key 的字段`));
        continue;
      }
      if (seen.has(ext.key)) {
        errors.push(issue('FIELD_DUP', `实体 ${entity} 的字段 ${ext.key} 重复`));
      }
      seen.add(ext.key);
      if (typeof ext.visible !== 'boolean') {
        errors.push(issue('FIELD_VISIBLE', `字段 ${entity}.${ext.key} 的 visible 必须是布尔`));
      }
      if (!(FIELD_TYPES as readonly string[]).includes(ext.type)) {
        errors.push(issue('FIELD_TYPE', `字段 ${entity}.${ext.key} 的类型非法: ${String(ext.type)}`));
      }
    }
  }

  // workflows：结构 + 引用完整 + when 域 + 连通性
  for (const [wfId, wf] of Object.entries(s.workflows)) {
    validateWorkflow(wfId, wf, errors, warnings);
  }

  // modules：enabled 布尔 + settings 对象
  for (const [modId, mod] of Object.entries(s.modules)) {
    if (typeof mod.enabled !== 'boolean') {
      errors.push(issue('MODULE_ENABLED', `模块 ${modId} 的 enabled 必须是布尔`));
    }
    if (mod.settings !== undefined && (typeof mod.settings !== 'object' || mod.settings === null || Array.isArray(mod.settings))) {
      errors.push(issue('MODULE_SETTINGS', `模块 ${modId} 的 settings 必须是对象`));
    }
  }

  // roles 冻结
  if (Object.keys(s.roles).length > 0) {
    errors.push(issue('ROLES_FROZEN', 'roles 为预留空 key（v1 冻结），必须保持空对象'));
  }
}

function validateWorkflow(wfId: string, wf: WorkflowDef, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  if (!Array.isArray(wf.states) || wf.states.length === 0) {
    errors.push(issue('WF_EMPTY', `流程 ${wfId} 的 states 不能为空`));
    return;
  }

  const ids = new Set<string>();
  for (const st of wf.states) {
    if (!st.id || typeof st.id !== 'string') {
      errors.push(issue('WF_STATE_ID', `流程 ${wfId} 存在无 id 的状态`));
    } else if (ids.has(st.id)) {
      errors.push(issue('WF_STATE_DUP', `流程 ${wfId} 的状态 ${st.id} 重复`));
    }
    ids.add(st.id);
    if (!st.label || typeof st.label !== 'string') {
      errors.push(issue('WF_STATE_LABEL', `流程 ${wfId} 的状态 ${String(st.id)} 缺少 label`));
    }
  }

  // transitions 引用完整 + when 语法域（§5.3：只认模块开关）
  const outEdges = new Map<string, { to: string; when?: string }[]>();
  for (const tr of wf.transitions) {
    for (const endpoint of [tr.from, tr.to]) {
      if (!ids.has(endpoint)) {
        errors.push(issue('WF_REF', `流程 ${wfId} 的转移 ${tr.from}→${tr.to} 引用了不存在的状态 ${endpoint}`));
      }
    }
    if (tr.when !== undefined && !WHEN_RE.test(tr.when)) {
      errors.push(issue('WF_WHEN', `流程 ${wfId} 的转移 ${tr.from}→${tr.to} 的 when 条件非法: "${tr.when}"（只允许 module.{id}.enabled 或其否定）`));
    }
    const list = outEdges.get(tr.from) ?? [];
    list.push({ to: tr.to, when: tr.when });
    outEdges.set(tr.from, list);
  }

  // 连通性：states[0] 为初始态（约定），全部状态可达
  const initial = wf.states[0].id;
  const visited = new Set<string>();
  const queue = [initial];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const e of outEdges.get(cur) ?? []) queue.push(e.to);
  }
  for (const st of wf.states) {
    if (!visited.has(st.id)) {
      errors.push(issue('WF_UNREACHABLE', `流程 ${wfId} 的状态 ${st.id} 从初始态 ${initial} 不可达（孤立状态）`));
    }
  }

  // 至少一个终态（无出边 = 终态）
  const terminals = wf.states.filter((st) => (outEdges.get(st.id) ?? []).length === 0);
  if (terminals.length === 0) {
    errors.push(issue('WF_NO_TERMINAL', `流程 ${wfId} 没有终态（每个状态都有出转移，流程无法结束）`));
  }

  // 死锁软警告：非终态的所有出转移都带条件，且不存在互补对/无条件边——
  // 条件全假时流程可能卡死在该状态（§5.3 静态可证明性的边界，交人裁决）
  for (const st of wf.states) {
    const edges = outEdges.get(st.id) ?? [];
    if (edges.length === 0) continue;
    const unconditional = edges.some((e) => e.when === undefined);
    const complementary = edges.some((e) => e.when !== undefined && edges.some((o) => o.when === negate(e.when!)));
    if (!unconditional && !complementary) {
      warnings.push(issue('WF_MAY_STUCK', `流程 ${wfId} 的状态 ${st.id} 的所有出转移都带 when 条件且不互补——某些模块开关组合下流程可能停在该状态`, undefined, 'warning'));
    }
  }
}

function negate(when: string): string {
  return when.startsWith('!') ? when.slice(1) : `!${when}`;
}

function issue(code: string, message: string, path?: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return { code, severity, message, path };
}

/** 从快照提取 config 部分（applyPatch 的操作对象，供热应用轨道 B 使用） */
export function configOf(snapshot: ProfileSnapshot): ConfigState {
  return { workflows: snapshot.workflows, modules: snapshot.modules, roles: snapshot.roles };
}
