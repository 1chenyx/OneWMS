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
  ManifestRecord,
  ManifestUi,
  ManifestUiPage,
  ModuleManifest,
} from './manifest-types.js';
import { DYN_RECORD_PREFIX, MODULE_CAPABILITIES, UI_PAGE_KINDS, UI_PAGE_PREFIX } from './manifest-types.js';
import type { ValidationIssue } from '../profile/validate.js';

const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;
const SHARINGS = ['shared', 'private'] as const;
/** 固定列主体 id：小写字母开头，只含小写字母、数字、下划线（不含点号——`dyn.` 命名空间靠这一点与内置天然隔离） */
const RECORD_ID_RE = /^[a-z][a-z0-9_]*$/;
/** 流程 id：小写字母开头，允许数字、下划线、连字符 */
const WORKFLOW_ID_RE = /^[a-z][a-z0-9_-]*$/;
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

  validateRecords(manifest.records, manifest.id, errors);
  validateAliases(manifest.aliases, manifest.id, errors);
  validateWorkflowAliases(manifest.workflowAliases, errors);
  validateUi(manifest.ui, manifest.id, manifest.records, errors);

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

function validateAliases(aliases: string[] | undefined, moduleId: string, errors: ValidationIssue[]): void {
  if (aliases === undefined) return;
  if (!Array.isArray(aliases) || aliases.some((name) => !isNonEmptyString(name))) {
    errors.push(err('MANIFEST_ALIAS', 'aliases 的每项须为非空字符串', '/aliases'));
    return;
  }
  const seen = new Set<string>();
  for (const name of aliases) {
    const key = name.trim().toLowerCase();
    if (key === moduleId.trim().toLowerCase()) {
      errors.push(err('MANIFEST_ALIAS', `别名「${name}」与模块 id 重复`, '/aliases'));
    }
    if (seen.has(key)) {
      errors.push(err('MANIFEST_ALIAS', `别名重复: ${name}`, '/aliases'));
    }
    seen.add(key);
  }
}

function validateWorkflowAliases(
  aliases: Record<string, string[]> | undefined,
  errors: ValidationIssue[],
): void {
  if (aliases === undefined) return;
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
    errors.push(err('MANIFEST_WORKFLOW_ALIAS', 'workflowAliases 必须是对象', '/workflowAliases'));
    return;
  }
  const seen = new Set<string>();
  for (const [id, names] of Object.entries(aliases)) {
    const at = `/workflowAliases/${id}`;
    if (!WORKFLOW_ID_RE.test(id)) {
      errors.push(err('MANIFEST_WORKFLOW_ALIAS', `流程 id 非法: "${id}"`, at));
    }
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => !isNonEmptyString(name))) {
      errors.push(err('MANIFEST_WORKFLOW_ALIAS', `流程 ${id} 的别名须为非空字符串数组`, at));
      continue;
    }
    for (const name of names) {
      const key = name.trim().toLowerCase();
      if (key === id) {
        errors.push(err('MANIFEST_WORKFLOW_ALIAS', `流程别名「${name}」与 id 重复`, at));
      }
      if (seen.has(key)) {
        errors.push(err('MANIFEST_WORKFLOW_ALIAS', `流程别名重复: ${name}`, at));
      }
      seen.add(key);
    }
  }
}

/**
 * 页面 id 的完整校验（导出供 ModuleRegistry 提案期复用）。
 * 形态 `ui.{moduleId}.{pageId}`，pageId 沿用实体 id 的词法（小写字母开头，只含小写字母/数字/_）。
 */
export function isUiPageId(id: string, moduleId: string): boolean {
  const prefix = `${UI_PAGE_PREFIX}${moduleId}.`;
  return id.startsWith(prefix) && RECORD_ID_RE.test(id.slice(prefix.length));
}

/**
 * 界面分区校验（B.6）。
 *
 * 除了通用的「id 命名空间 / label 非空 / kind 白名单 / 段内唯一」，
 * 还有一条别处没有的硬约束：`record` 必须指向**本 manifest records 里已声明**的 id。
 * 为什么这么严：页面是长在本模块导航位上的，若允许指向别人的实体，
 * 那个模块卸载后页面就成了「打得开但 404」的死链——而 404 只在运行时出现，
 * 配置期一声不吭。校验期拒掉，问题留在提交 manifest 的那一刻。
 */
function validateUi(
  ui: ManifestUi | undefined,
  moduleId: string,
  records: ManifestRecord[] | undefined,
  errors: ValidationIssue[],
): void {
  if (ui === undefined) return;
  if (typeof ui !== 'object' || ui === null) {
    errors.push(err('MANIFEST_UI', 'ui 必须是对象', '/ui'));
    return;
  }
  const pages = ui.pages;
  if (pages === undefined) return;
  if (!Array.isArray(pages)) {
    errors.push(err('MANIFEST_UI', 'ui.pages 必须是数组', '/ui/pages'));
    return;
  }
  const declared = new Set((records ?? []).map((r) => String(r?.id)));
  const seen = new Set<string>();
  for (const page of pages as ManifestUiPage[]) {
    validateUiPage(page, moduleId, declared, seen, errors);
  }
}

function validateUiPage(
  page: ManifestUiPage,
  moduleId: string,
  declared: Set<string>,
  seen: Set<string>,
  errors: ValidationIssue[],
): void {
  const id = String(page?.id ?? '');
  const at = `/ui/pages/${id || '(缺 id)'}`;
  if (!isNonEmptyString(page?.id)) {
    errors.push(err('MANIFEST_UI_PAGE', '页面缺少 id', at));
  } else if (!isUiPageId(id, moduleId)) {
    errors.push(
      err(
        'MANIFEST_UI_PAGE',
        `页面 id 非法: "${id}"（须为 ${UI_PAGE_PREFIX}${moduleId}.{pageId}，` +
          `pageId 小写字母开头、仅含小写字母/数字/_）`,
        at,
      ),
    );
  } else if (seen.has(id)) {
    errors.push(err('MANIFEST_UI_PAGE', `页面 id 重复: ${id}`, at));
  }
  seen.add(id);

  if (!isNonEmptyString(page?.label)) {
    errors.push(err('MANIFEST_UI_PAGE', `页面 ${id || '(缺 id)'} 缺少 label`, at));
  }
  if (!(UI_PAGE_KINDS as readonly string[]).includes(page?.kind)) {
    errors.push(
      err(
        'MANIFEST_UI_PAGE',
        `页面 ${id} 的 kind 非法: "${String(page?.kind)}"（白名单：${UI_PAGE_KINDS.join('/')}）`,
        at,
      ),
    );
  } else if (page.kind === 'record-list') {
    // 实体白名单：只认本 manifest 声明过的 records（理由见 validateUi）
    if (!isNonEmptyString(page.record)) {
      errors.push(err('MANIFEST_UI_PAGE', `页面 ${id} 是 record-list，必须给出 record`, `${at}/record`));
    } else if (!declared.has(page.record)) {
      errors.push(
        err(
          'MANIFEST_UI_PAGE',
          `页面 ${id} 的 record "${page.record}" 未在本 manifest 的 records 里声明`,
          `${at}/record`,
        ),
      );
    }
  }
  for (const key of ['category', 'icon', 'description'] as const) {
    if (page?.[key] !== undefined && !isNonEmptyString(page[key])) {
      errors.push(err('MANIFEST_UI_PAGE', `页面 ${id} 的 ${key} 须为非空字符串`, `${at}/${key}`));
    }
  }
}

/**
 * 实体 id 是否合法（两条互不污染的规则，按前缀分流）：
 *  - `dyn.` 开头 → 声明式模块命名空间，须为 `dyn.{本模块id}.{recordId}`；
 *  - 其余 → 内置规则 RECORD_ID_RE（不含点号）。
 *
 * ⚠️ 内置 manifest 若声明了 `dyn.` 开头的 id，会因为对不上自己的模块 id 而被拒——
 * 这是有意的：`dyn.` 前缀是声明式模块的保留命名空间。
 */
function isLegalRecordId(id: string, moduleId: string): boolean {
  return id.startsWith(DYN_RECORD_PREFIX) ? isDynamicRecordId(id, moduleId) : RECORD_ID_RE.test(id);
}

/** 声明式实体 id 的完整校验（导出供 ModuleRegistry 提案期与撞名检查复用） */
export function isDynamicRecordId(id: string, moduleId: string): boolean {
  const prefix = `${DYN_RECORD_PREFIX}${moduleId}.`;
  return id.startsWith(prefix) && RECORD_ID_RE.test(id.slice(prefix.length));
}

function recordIdIssue(id: unknown, moduleId: string): ValidationIssue {
  return err(
    'MANIFEST_RECORDS',
    `固定列 id 非法: "${String(id)}"（内置模块须小写字母开头、仅含小写字母/数字/_；` +
      `声明式模块须为 ${DYN_RECORD_PREFIX}${moduleId}.{recordId}）`,
    `/records/${String(id)}`,
  );
}

function validateRecords(records: ManifestRecord[] | undefined, moduleId: string, errors: ValidationIssue[]): void {
  if (records === undefined) return;
  if (!Array.isArray(records)) {
    errors.push(err('MANIFEST_RECORDS', 'records 必须是数组', '/records'));
    return;
  }
  const ids = new Set<string>();
  for (const record of records) {
    if (!isNonEmptyString(record?.id) || !isLegalRecordId(record.id, moduleId)) continue;
    if (ids.has(record.id)) {
      errors.push(err('MANIFEST_RECORDS', `固定列 id 重复: ${record.id}`, `/records/${record.id}`));
    }
    ids.add(record.id);
  }
  const aliases = new Set<string>();
  for (const record of records) {
    const at = `/records/${String(record?.id)}`;
    if (!isNonEmptyString(record?.id) || !isLegalRecordId(record.id, moduleId)) {
      errors.push(recordIdIssue(record?.id, moduleId));
    }
    if (!isNonEmptyString(record?.label)) {
      errors.push(err('MANIFEST_RECORDS', `固定列 ${String(record?.id)} 缺少 label`, at));
    }
    const names = record?.aliases;
    if (names !== undefined && (!Array.isArray(names) || names.some((name) => !isNonEmptyString(name)))) {
      errors.push(err('MANIFEST_RECORDS', `固定列 ${String(record?.id)} 的 aliases 每项须为非空字符串`, `${at}/aliases`));
    } else {
      for (const name of names ?? []) {
        const key = name.trim().toLowerCase();
        if (ids.has(key)) {
          errors.push(err('MANIFEST_RECORDS', `固定列别名「${name}」与 id 重复`, `${at}/aliases`));
        }
        if (aliases.has(key)) {
          errors.push(err('MANIFEST_RECORDS', `固定列别名重复: ${name}`, `${at}/aliases`));
        }
        aliases.add(key);
      }
    }
    if (!Array.isArray(record?.fields) || record.fields.length === 0) {
      errors.push(err('MANIFEST_RECORDS', `固定列 ${String(record?.id)} 至少要有一列`, `${at}/fields`));
      continue;
    }
    const keys = new Set<string>();
    for (const field of record.fields) {
      if (!isNonEmptyString(field?.key) || !isNonEmptyString(field?.label)) {
        errors.push(err('MANIFEST_RECORDS', `固定列 ${String(record?.id)} 的列缺少 key 或 label`, `${at}/fields`));
        continue;
      }
      if (keys.has(field.key)) {
        errors.push(err('MANIFEST_RECORDS', `固定列 ${record.id}.${field.key} 重复`, `${at}/fields`));
      }
      keys.add(field.key);
      if (field.type !== undefined && !(FIELD_TYPES as readonly string[]).includes(field.type)) {
        errors.push(
          err(
            'MANIFEST_RECORDS',
            `固定列 ${record.id}.${field.key} 的类型非法: "${String(field.type)}"（白名单：${FIELD_TYPES.join('/')}）`,
            `${at}/fields`,
          ),
        );
      }
      if (field.queryable !== undefined && typeof field.queryable !== 'boolean') {
        errors.push(
          err('MANIFEST_RECORDS', `固定列 ${record.id}.${field.key} 的 queryable 必须是布尔`, `${at}/fields`),
        );
      }
    }
  }
}

/**
 * 声明式模块的 records 专属校验（B.1，提案期与安装期各跑一次）。
 *
 * validateManifest 只保证「每个 id 形态合法」，这里补两条它管不到的：
 *  1. **不许混用命名空间**——一份走人工确认装入的 manifest 若声明裸 id（如 inventory），
 *     就能顶掉内置实体的查询入口（query-tools 按 id/label/alias 解析 entity），属于逃逸；
 *  2. **列类型必填**——声明式实体没有建表语句，类型是存储、入参校验、AI 描述拼装的唯一依据，
 *     缺了就只能猜。内置模块不要求（列类型是代码事实，写在 manifest 里反而制造两份真相）。
 */
export function validateDynamicRecords(manifest: ModuleManifest): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  for (const record of manifest.records ?? []) {
    const id = String(record?.id ?? '');
    const at = `/records/${id}`;
    if (!id.startsWith(DYN_RECORD_PREFIX)) {
      errors.push(
        err(
          'DYN_RECORD_NS',
          `声明式模块的实体 id 必须落在 ${DYN_RECORD_PREFIX}{模块id}.{recordId} 命名空间内，实际 "${id}"`,
          at,
        ),
      );
      continue;
    }
    if (!isDynamicRecordId(id, manifest.id)) {
      errors.push(
        err(
          'DYN_RECORD_NS',
          `实体 id "${id}" 的命名空间与模块 id ${manifest.id} 不匹配（须为 ${DYN_RECORD_PREFIX}${manifest.id}.{recordId}）`,
          at,
        ),
      );
    }
    for (const field of record?.fields ?? []) {
      if (field?.type === undefined) {
        errors.push(
          err(
            'DYN_RECORD_FIELD_TYPE',
            `声明式实体 ${id} 的列 ${String(field?.key)} 缺少 type（白名单：${FIELD_TYPES.join('/')}）`,
            `${at}/fields`,
          ),
        );
      }
    }
  }
  return errors;
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
  const d = def as { states: { id?: unknown; label?: unknown }[]; transitions: { from?: unknown; to?: unknown; effect?: unknown }[] };
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
    assertEffect(t, errors, `${at}/transitions`);
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
    assertEffect(t, errors, `${at}/transitions`);
  }
}

const EFFECT_VALUES = new Set(['increase', 'decrease', 'check', 'none']);

function assertEffect(
  t: { effect?: unknown },
  errors: ValidationIssue[],
  at: string,
): void {
  if (t?.effect !== undefined && (typeof t.effect !== 'string' || !EFFECT_VALUES.has(t.effect))) {
    errors.push(err('MANIFEST_EFFECT', `转移 effect 非法: "${String(t?.effect)}"`, at));
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
