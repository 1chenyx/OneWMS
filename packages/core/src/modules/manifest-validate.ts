/**
 * manifest 结构校验器（纯函数，DESIGN.md §6.1 的 v1 子集）。
 *
 * 只做「机械可判定」的结构检查（§4.5 检测机械化）：格式、词表、类型域、命名空间、
 * 段内唯一性。安装期检查（依赖在场 / slot 占位 / 状态冲突 / 字段现状 / 工具在场）
 * 不在此处——那是 ModuleRegistry 预检的职责（需要读状态，非纯函数）。
 */
import type {
  ManifestContribution,
  ManifestFieldProvide,
  ManifestFieldRequire,
  ManifestTool,
  ModuleManifest,
} from './manifest-types.js';
import { MODULE_CAPABILITIES } from './manifest-types.js';
import type { FieldSharing } from '../registry/key-naming.js';
import type { ValidationIssue } from '../profile/validate.js';

const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;
const SHARINGS = ['shared', 'private'] as const;
/** 模块 id：命名空间风格（字母开头，允许字母/数字/点/下划线/连字符；禁空格与 @——后者是 actor 后缀分隔符） */
const MODULE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function err(code: string, message: string, path?: string): ValidationIssue {
  return { code, severity: 'error', message, path };
}

/**
 * 校验一个 manifest 的结构。errors 非空 = 不合格（完整清单，不短路——便于一次修正全部问题）。
 */
export function validateManifest(manifest: ModuleManifest): { errors: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];

  // ── 身份段 ────────────────────────────────────────────
  if (!MODULE_ID_RE.test(manifest.id ?? '')) {
    errors.push(err('MANIFEST_ID', `模块 id 非法: "${manifest.id}"（须字母开头，仅含字母/数字/./_/-）`, '/id'));
  }
  if (!isNonEmptyString(manifest.name)) {
    errors.push(err('MANIFEST_NAME', 'name 不能为空', '/name'));
  }
  if (!isNonEmptyString(manifest.description)) {
    errors.push(err('MANIFEST_DESCRIPTION', 'description 不能为空（AI 组装匹配的一等公民，§6.3）', '/description'));
  }
  if (!SEMVER_RE.test(manifest.version ?? '')) {
    errors.push(err('MANIFEST_VERSION', `version 非法: "${manifest.version}"（须 x.y.z 语义化版本）`, '/version'));
  }
  if (manifest.minCoreVersion !== undefined && !SEMVER_RE.test(manifest.minCoreVersion)) {
    errors.push(err('MANIFEST_MIN_CORE', `minCoreVersion 非法: "${manifest.minCoreVersion}"（须 x.y.z）`, '/minCoreVersion'));
  }
  if (manifest.signature !== undefined && manifest.signature !== null) {
    errors.push(err('MANIFEST_SIGNATURE', 'signature v1 恒为 null（本地模块无签名，DESIGN §10）', '/signature'));
  }

  // ── 能力词表（§6.3 沙箱的 v1 形态）────────────────────
  if (!Array.isArray(manifest.capabilities)) {
    errors.push(err('MANIFEST_CAPABILITIES', 'capabilities 必须是数组', '/capabilities'));
  } else {
    const seen = new Set<string>();
    for (const cap of manifest.capabilities) {
      if (!(MODULE_CAPABILITIES as readonly string[]).includes(cap)) {
        errors.push(err('MANIFEST_CAPABILITY', `未知能力: "${String(cap)}"（词表：${MODULE_CAPABILITIES.join(' ')}）`, '/capabilities'));
      }
      if (seen.has(cap)) {
        errors.push(err('MANIFEST_CAPABILITY', `能力重复声明: "${String(cap)}"`, '/capabilities'));
      }
      seen.add(String(cap));
    }
  }

  // ── 槽位（§7.2 择一型）────────────────────────────────
  if (manifest.slot !== undefined) {
    if (typeof manifest.slot !== 'object' || !isNonEmptyString(manifest.slot?.name)) {
      errors.push(err('MANIFEST_SLOT', 'slot.name 不能为空', '/slot'));
    }
  }

  // ── 依赖 ──────────────────────────────────────────────
  const deps = manifest.dependencies?.modules;
  if (deps !== undefined) {
    if (!Array.isArray(deps)) {
      errors.push(err('MANIFEST_DEPENDENCIES', 'dependencies.modules 必须是数组', '/dependencies/modules'));
    } else if (deps.some((d) => typeof d !== 'string' || d === '')) {
      errors.push(err('MANIFEST_DEPENDENCIES', 'dependencies.modules 的每项须为非空字符串', '/dependencies/modules'));
    } else if (new Set(deps).size !== deps.length) {
      errors.push(err('MANIFEST_DEPENDENCIES', 'dependencies.modules 存在重复声明', '/dependencies/modules'));
    } else if (deps.includes(manifest.id)) {
      errors.push(err('MANIFEST_DEPENDENCIES', `模块 ${manifest.id} 依赖自己`, '/dependencies/modules'));
    }
  }

  // ── 字段分区（§7.1）───────────────────────────────────
  const provides = manifest.fields?.provides ?? [];
  if (!Array.isArray(provides)) {
    errors.push(err('MANIFEST_FIELDS', 'fields.provides 必须是数组', '/fields/provides'));
  } else {
    const seen = new Set<string>();
    for (const f of provides) {
      validateProvide(f, errors, seen);
    }
  }
  const requires = manifest.fields?.requires ?? [];
  if (!Array.isArray(requires)) {
    errors.push(err('MANIFEST_FIELDS', 'fields.requires 必须是数组', '/fields/requires'));
  } else {
    for (const f of requires) {
      validateRequire(f, errors);
    }
  }

  // ── 工具分区（§6 命名空间规则）─────────────────────────
  const tools = manifest.tools ?? [];
  if (!Array.isArray(tools)) {
    errors.push(err('MANIFEST_TOOLS', 'tools 必须是数组', '/tools'));
  } else {
    const seen = new Set<string>();
    for (const t of tools) {
      if (typeof t?.id !== 'string' || !t.id.includes('.')) {
        errors.push(err('MANIFEST_TOOL_ID', `工具 id 必须带命名空间: "${String(t?.id)}"`, '/tools'));
      } else if (seen.has(t.id)) {
        errors.push(err('MANIFEST_TOOL_ID', `工具 id 重复: "${t.id}"`, '/tools'));
      }
      seen.add(String(t?.id));
      if (!isNonEmptyString(t?.label)) {
        errors.push(err('MANIFEST_TOOL_META', `工具 ${String(t?.id)} 缺少 label`, '/tools'));
      }
      if (!isNonEmptyString(t?.description)) {
        errors.push(err('MANIFEST_TOOL_META', `工具 ${String(t?.id)} 缺少 description（注入 function calling，措辞必须精确）`, '/tools'));
      }
      if (t?.parameters?.type !== 'object') {
        errors.push(err('MANIFEST_TOOL_META', `工具 ${String(t?.id)} 的 parameters.schema 必须是 object 类型`, '/tools'));
      }
      if (t?.permission !== 'read' && t?.permission !== 'write') {
        errors.push(err('MANIFEST_TOOL_META', `工具 ${String(t?.id)} 的 permission 须为 read/write`, '/tools'));
      }
    }
  }

  // ── 事件分区（v1 仅声明与结构检查）─────────────────────
  for (const key of ['subscribes', 'publishes'] as const) {
    const list = manifest.events?.[key];
    if (list !== undefined) {
      if (!Array.isArray(list) || list.some((e) => typeof e !== 'string' || e === '')) {
        errors.push(err('MANIFEST_EVENTS', `events.${key} 的每项须为非空字符串`, `/events/${key}`));
      }
    }
  }

  // ── 流程分区（base / contributes）──────────────────────
  const base = manifest.workflows?.base;
  if (base !== undefined) {
    if (typeof base !== 'object' || base === null || Array.isArray(base)) {
      errors.push(err('MANIFEST_WORKFLOWS', 'workflows.base 必须是对象（workflowId → 定义）', '/workflows/base'));
    } else {
      for (const [wfId, def] of Object.entries(base)) {
        validateWorkflowDef(def, errors, `/workflows/base/${wfId}`);
      }
    }
  }
  const contributes = manifest.workflows?.contributes;
  if (contributes !== undefined) {
    if (typeof contributes !== 'object' || contributes === null || Array.isArray(contributes)) {
      errors.push(err('MANIFEST_WORKFLOWS', 'workflows.contributes 必须是对象（workflowId → 贡献）', '/workflows/contributes'));
    } else {
      for (const [wfId, c] of Object.entries(contributes)) {
        validateContribution(c, errors, `/workflows/contributes/${wfId}`);
      }
    }
  }

  // ── settings（§5.4：schema 由 manifest 自带）───────────
  const schema = manifest.settings?.schema;
  if (manifest.settings !== undefined && schema?.type !== 'object') {
    errors.push(err('MANIFEST_SETTINGS', 'settings.schema 必须是 object 类型', '/settings/schema'));
  }

  return { errors };
}

// ── 内部 ────────────────────────────────────────────────

function validateProvide(f: ManifestFieldProvide, errors: ValidationIssue[], seen: Set<string>): void {
  const at = `/fields/provides/${f?.entity}.${f?.key}`;
  if (!isNonEmptyString(f?.entity) || !isNonEmptyString(f?.key)) {
    errors.push(err('MANIFEST_FIELD', `字段声明缺少 entity/key`, at));
    return;
  }
  const dupKey = `${f.entity}.${f.key}`;
  if (seen.has(dupKey)) {
    errors.push(err('MANIFEST_FIELD', `字段声明重复: ${dupKey}`, at));
  }
  seen.add(dupKey);
  if (!isNonEmptyString(f?.label)) {
    errors.push(err('MANIFEST_FIELD', `字段 ${dupKey} 缺少 label`, at));
  }
  if (!(FIELD_TYPES as readonly string[]).includes(f?.type)) {
    errors.push(err('MANIFEST_FIELD', `字段 ${dupKey} 类型非法: "${String(f?.type)}"`, at));
  }
  if (f?.sharing !== undefined && !(SHARINGS as readonly string[]).includes(f.sharing)) {
    errors.push(err('MANIFEST_FIELD', `字段 ${dupKey} sharing 非法: "${String(f.sharing)}"`, at));
  }
}

function validateRequire(f: ManifestFieldRequire, errors: ValidationIssue[]): void {
  const at = `/fields/requires/${f?.entity}.${f?.key}`;
  if (!isNonEmptyString(f?.entity) || !isNonEmptyString(f?.key)) {
    errors.push(err('MANIFEST_FIELD', `依赖字段声明缺少 entity/key`, at));
    return;
  }
  if (f?.expectType !== undefined && !(FIELD_TYPES as readonly string[]).includes(f.expectType)) {
    errors.push(err('MANIFEST_FIELD', `依赖字段 ${f.entity}.${f.key} 的 expectType 非法: "${String(f.expectType)}"`, at));
  }
  if (f?.sharing !== undefined && !(SHARINGS as readonly string[]).includes(f.sharing)) {
    errors.push(err('MANIFEST_FIELD', `依赖字段 ${f.entity}.${f.key} 的 sharing 非法: "${String(f.sharing)}"`, at));
  }
}

function validateWorkflowDef(
  def: { states?: unknown; transitions?: unknown },
  errors: ValidationIssue[],
  at: string,
): void {
  if (typeof def !== 'object' || def === null || !Array.isArray((def as { states?: unknown }).states) || !Array.isArray((def as { transitions?: unknown }).transitions)) {
    errors.push(err('MANIFEST_WORKFLOW', `流程定义须含 states/transitions 数组`, at));
    return;
  }
  const d = def as { states: { id?: unknown; label?: unknown }[]; transitions: { from?: unknown; to?: unknown }[] };
  if (d.states.length === 0) {
    errors.push(err('MANIFEST_WORKFLOW', `流程至少需要一个状态（states[0] 为初始态约定）`, at));
    return;
  }
  const ids = new Set<string>();
  for (const s of d.states) {
    if (!isNonEmptyString(s?.id)) {
      errors.push(err('MANIFEST_WORKFLOW', `状态 id 不能为空`, `${at}/states`));
      continue;
    }
    if (ids.has(s.id)) {
      errors.push(err('MANIFEST_WORKFLOW', `状态 id 重复: ${s.id}`, `${at}/states`));
    }
    ids.add(s.id);
    if (!isNonEmptyString(s?.label)) {
      errors.push(err('MANIFEST_WORKFLOW', `状态 ${s.id} 缺少 label`, `${at}/states`));
    }
  }
  for (const t of d.transitions) {
    if (!isNonEmptyString(t?.from) || !isNonEmptyString(t?.to)) {
      errors.push(err('MANIFEST_WORKFLOW', `转移缺少 from/to`, `${at}/transitions`));
    }
  }
}

function validateContribution(c: ManifestContribution, errors: ValidationIssue[], at: string): void {
  if (typeof c !== 'object' || c === null || !Array.isArray(c.states) || !Array.isArray(c.transitions)) {
    errors.push(err('MANIFEST_CONTRIBUTES', `贡献须含 states/transitions 数组`, at));
    return;
  }
  const ids = new Set<string>();
  for (const s of c.states) {
    if (!isNonEmptyString(s?.id)) {
      errors.push(err('MANIFEST_CONTRIBUTES', `贡献状态 id 不能为空`, `${at}/states`));
      continue;
    }
    if (ids.has(s.id)) {
      errors.push(err('MANIFEST_CONTRIBUTES', `贡献状态 id 重复: ${s.id}`, `${at}/states`));
    }
    ids.add(s.id);
    if (!isNonEmptyString(s?.label)) {
      errors.push(err('MANIFEST_CONTRIBUTES', `贡献状态 ${s.id} 缺少 label`, `${at}/states`));
    }
  }
  for (const t of c.transitions) {
    if (!isNonEmptyString(t?.from) || !isNonEmptyString(t?.to)) {
      errors.push(err('MANIFEST_CONTRIBUTES', `贡献转移缺少 from/to`, `${at}/transitions`));
    }
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 极简 semver 比较（不引依赖）：a < b 返回 -1，相等 0，a > b 返回 1。
 * 仅支持 x.y.z 数值三元组（格式合法性由 SEMVER_RE 保证）。
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}
