import { ToolValidationError } from '../errors.js';
import type { ToolDefinition } from '../bus/tool-bus.js';
import type { FieldRegistry, RegisteredField } from '../registry/field-registry.js';
import type { ModuleRegistry } from '../modules/module-registry.js';
import type { ManifestRecord, ModuleManifest } from '../modules/manifest-types.js';
import type { ProfileService } from './profile-service.js';
import type { ProfileSnapshot, WorkflowDef, WorkflowEffect } from './profile-types.js';
import { describeWhenCondition, evalWhenCondition } from './when.js';

/**
 * 项目实况查询（只读）。
 *
 * 流程、模块开关、模块设置、扩展字段都在 Profile 里，而且可以改。
 * 固定列写在已安装模块的 manifest.records 上，不能改。
 * 系统提示只放简表。用户问「现在是什么样」「还能改成什么样」时，
 * 先看 profile.overview 的 shape，再按需要下钻另外三条。四条都不落事件。
 *
 * 改配置仍只有 profile.propose：这里看得到路径和现值，不能替用户改。
 */

const EFFECT_LABEL: Record<WorkflowEffect, string> = {
  increase: '增加数量',
  decrease: '扣减数量',
  check: '只检查数量，不改账',
  none: '明确不改数量',
};

const READ_ONLY = '纯读，不修改配置。要改开关、设置、字段或流程，用 profile.propose 提议，等用户确认后才生效。';

export function createProfileQueryTools(
  profile: ProfileService,
  modules: ModuleRegistry,
  fields: FieldRegistry,
): ToolDefinition[] {
  const overview: ToolDefinition = {
    id: 'profile.overview',
    label: '查看项目概况',
    description:
      '查看系统现在是什么样，以及还能改哪些开关、流程和字段。' +
      '用户问「现在是啥样」「能搞成啥样」「有哪些功能」时先用本工具。' +
      'shape.now 是已经生效的功能和流程；shape.canChange 是可以改的范围；' +
      'shape.enabled / disabled / notInstalled 是功能的三种状态。' +
      '流程怎么走用 profile.workflow.query；某个功能的设置用 profile.module.query；某一对象有哪些列用 profile.field.query。参数可以填中文。' +
      READ_ONLY,
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const catalog = catalogOf(modules, snapshot);
      const counts = fieldCounts(fields, ctx.workspaceId);
      const fixed = fixedRecords(modules, snapshot);
      const names = workflowNames(modules, snapshot);
      const brief = (item: CatalogItem) => ({ id: item.id, name: item.name, description: item.description });
      return {
        profileVersion: snapshot.version,
        workflows: Object.entries(snapshot.workflows)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, wf]) => ({
            id,
            label: names.get(id)?.label ?? id,
            stateChain: wf.states.map((s) => s.label).join(' → '),
            stateCount: wf.states.length,
            transitionCount: wf.transitions.length,
          })),
        modules: catalog.map((item) => ({
          id: item.id,
          name: item.name,
          installed: item.installed,
          enabled: item.enabled,
          description: item.description,
        })),
        fields: counts,
        shape: {
          now: '已启用的功能、当前流程、各对象上的固定列和扩展字段。',
          canChange: {
            toggleModule: '已安装的功能可以启用或停用。用 profile.propose 把 /modules/{id}/enabled 换成 true 或 false。',
            settings: '已安装功能的设置可以改。具体键和当前值用 profile.module.query。',
            fields: '扩展字段可以隐藏、恢复，也可以新增到某个对象上。固定列不能删除。',
            workflows: '流程的状态和转移可以改。当前怎么走用 profile.workflow.query。',
            notInstalled: '代码里有、本项目还没装上的功能，对话里不能安装。',
          },
          enabled: catalog.filter((item) => item.installed && item.enabled).map(brief),
          disabled: catalog.filter((item) => item.installed && !item.enabled).map(brief),
          notInstalled: catalog.filter((item) => !item.installed).map(brief),
          objects: objectSummary(fixed, counts),
        },
        note: '先用 shape 回答「现在是什么样、还能改成什么样」，再按需要下钻另外三条查询。本工具不改配置。',
      };
    },
  };

  const workflowQuery: ToolDefinition = {
    id: 'profile.workflow.query',
    label: '查询流程',
    description:
      '查询流程现在怎么走，以及哪几步会因功能停用而关掉。' +
      '不传 workflowId 返回全部流程；传入可填 id 或中文（入库、出库、inbound）。' +
      'active 为 true 表示按当前模块开关这条转移现在走得通。' +
      '改流程用 profile.propose 改 /workflows/{id}。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: '流程 id 或中文名（可选），如 inbound、入库、出库。省略则列出全部' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const nameOf = moduleNameOf(modules);
      const names = workflowNames(modules, snapshot);
      const ids = Object.keys(snapshot.workflows).sort((a, b) => a.localeCompare(b));
      const wanted = (params as { workflowId?: string }).workflowId?.trim();
      const picked = wanted ? [resolveWorkflow(wanted, ids, names)] : ids;
      return {
        workflows: picked.map((id) =>
          presentWorkflow(id, names.get(id)?.label ?? id, snapshot.workflows[id]!, snapshot, nameOf),
        ),
      };
    },
  };

  const moduleQuery: ToolDefinition = {
    id: 'profile.module.query',
    label: '查询功能模块',
    description:
      '查询功能开没开、设置当前值，以及代码里还没装上的功能。' +
      '不传 moduleId 列出全部；传入可填 id 或中文名（到货预报、module.asn），并额外返回它贡献的流程、字段和工具名。' +
      'installed=false 表示代码里有、本项目还没装，对话里不能安装。' +
      '已安装的可以启用或停用，设置可以改，都走 profile.propose。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string', description: '模块 id 或中文名（可选），如 module.asn、到货预报。省略则列出全部' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const catalog = catalogOf(modules, snapshot);
      const wanted = (params as { moduleId?: string }).moduleId?.trim();
      const picked = wanted ? [resolveModule(wanted, catalog)] : catalog;
      return {
        modules: picked.map((item) => presentModule(item, Boolean(wanted))),
      };
    },
  };

  const fieldQuery: ToolDefinition = {
    id: 'profile.field.query',
    label: '查询可配置字段',
    description:
      '查询商品、库存、单据、库位等对象现在有哪些列、哪些列能配置。' +
      'entity 可省略，或填实体名、中文别名（商品、库存、单据、库位、批次、往来单位）。' +
      'fixed 是固定列，不能增删；fields 才是可配置扩展字段，可以隐藏、恢复或再加。' +
      'fields 为空只说明不能增删列。不传 entity 列出全部。已隐藏的扩展字段数据仍在，只是不显示。' +
      '整套系统现在什么样、能改成什么样，用 profile.overview。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: '对象名或中文别名（可选），如 sku、商品、inventory、库存、单据、库位。省略则列出全部',
        },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const rows = fields.listFields(ctx.workspaceId);
      const extensions = [...new Set(rows.map((row) => row.entity))].sort((a, b) => a.localeCompare(b));
      const fixed = fixedRecords(modules, profile.getSnapshot(ctx.workspaceId));
      const wanted = (params as { entity?: string }).entity?.trim();
      const ids = wanted ? [resolveEntity(wanted, extensions, fixed)] : allEntityIds(extensions, fixed);
      return {
        entities: ids.map((entity) => presentEntity(entity, rows, fixed.find((record) => record.id === entity))),
      };
    },
  };

  return [overview, workflowQuery, moduleQuery, fieldQuery];
}

function effectLabel(effect: WorkflowEffect | undefined): string {
  if (!effect) return '未写在转移上，由业务按目标状态的约定处理';
  return EFFECT_LABEL[effect];
}

function moduleNameOf(registry: ModuleRegistry): (id: string) => string {
  const names = new Map(registry.listManifests().map((manifest) => [manifest.id, manifest.name]));
  return (id) => names.get(id) ?? id;
}

function presentWorkflow(
  id: string,
  label: string,
  wf: WorkflowDef,
  snapshot: ProfileSnapshot,
  nameOf: (moduleId: string) => string,
) {
  const labelOf = new Map(wf.states.map((state) => [state.id, state.label]));
  return {
    id,
    label,
    initial: wf.states[0] ? { id: wf.states[0].id, label: wf.states[0].label } : null,
    states: wf.states.map((state) => ({
      id: state.id,
      label: state.label,
      providedBy: state.providedBy ?? null,
    })),
    transitions: wf.transitions.map((transition) => ({
      from: transition.from,
      fromLabel: labelOf.get(transition.from) ?? transition.from,
      to: transition.to,
      toLabel: labelOf.get(transition.to) ?? transition.to,
      when: transition.when ?? null,
      whenLabel: describeWhenCondition(transition.when, nameOf),
      active: evalWhenCondition(transition.when, snapshot.modules),
      effect: transition.effect ?? null,
      effectLabel: effectLabel(transition.effect),
      providedBy: transition.providedBy ?? null,
    })),
  };
}

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  installed: boolean;
  enabled: boolean;
  version: string;
  settings: Record<string, unknown>;
  manifest?: ModuleManifest;
}

function catalogOf(registry: ModuleRegistry, snapshot: ProfileSnapshot): CatalogItem[] {
  const byId = new Map<string, CatalogItem>();
  for (const manifest of registry.listManifests()) {
    byId.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      aliases: [...(manifest.aliases ?? [])],
      installed: false,
      enabled: false,
      version: manifest.version,
      settings: {},
      manifest,
    });
  }
  for (const [id, config] of Object.entries(snapshot.modules)) {
    const existing = byId.get(id);
    byId.set(id, {
      id,
      name: existing?.name ?? id,
      description: existing?.description ?? '',
      aliases: existing?.aliases ?? [],
      installed: true,
      enabled: config.enabled,
      version: config.version ?? existing?.version ?? '',
      settings: config.settings ?? {},
      manifest: existing?.manifest,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function settingsOf(manifest: ModuleManifest | undefined, current: Record<string, unknown>) {
  const props = manifest?.settings?.schema.properties ?? {};
  const declared = Object.entries(props).map(([key, prop]) => ({
    key,
    type: prop.type,
    enum: prop.enum ?? null,
    description: prop.description ?? '',
    default: prop.default ?? null,
    value: current[key] !== undefined ? current[key] : (prop.default ?? null),
  }));
  const extra = Object.entries(current)
    .filter(([key]) => !props[key])
    .map(([key, value]) => ({
      key,
      type: 'unknown',
      enum: null,
      description: '当前值不在模块声明的设置里',
      default: null,
      value,
    }));
  return [...declared, ...extra];
}

function presentModule(item: CatalogItem, detailed: boolean) {
  const manifest = item.manifest;
  const base = {
    id: item.id,
    name: item.name,
    description: item.description,
    installed: item.installed,
    enabled: item.enabled,
    version: item.version,
    settings: settingsOf(manifest, item.settings),
    touchesWorkflows: [
      ...Object.keys(manifest?.workflows?.base ?? {}),
      ...Object.keys(manifest?.workflows?.contributes ?? {}),
    ].filter((id, index, all) => all.indexOf(id) === index),
  };
  if (!detailed || !manifest) return base;
  const contributions = [
    ...Object.entries(manifest.workflows?.base ?? {}).map(([workflowId, def]) => ({
      workflowId,
      kind: 'base' as const,
      states: def.states,
      transitions: def.transitions,
    })),
    ...Object.entries(manifest.workflows?.contributes ?? {}).map(([workflowId, def]) => ({
      workflowId,
      kind: 'contributes' as const,
      states: def.states,
      transitions: def.transitions,
    })),
  ];
  return {
    ...base,
    dependencies: manifest.dependencies?.modules ?? [],
    fields: (manifest.fields?.provides ?? []).map((field) => ({
      entity: field.entity,
      key: field.key,
      label: field.label,
      type: field.type,
    })),
    contributions,
    tools: (manifest.tools ?? []).map((tool) => ({ id: tool.id, label: tool.label })),
  };
}

interface FixedRecord {
  id: string;
  label: string;
  aliases: string[];
  note: string;
  fields: { key: string; label: string; description: string }[];
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** 已安装模块声明的固定列。同 id 合并，列按先声明的保留。 */
function fixedRecords(registry: ModuleRegistry, snapshot: ProfileSnapshot): FixedRecord[] {
  const merged = new Map<string, FixedRecord>();
  const manifests = registry
    .listManifests()
    .filter((manifest) => snapshot.modules[manifest.id])
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const manifest of manifests) {
    for (const record of manifest.records ?? []) {
      const incoming = toFixedRecord(record);
      const existing = merged.get(incoming.id);
      if (!existing) {
        merged.set(incoming.id, incoming);
        continue;
      }
      const seen = new Set(existing.fields.map((field) => field.key));
      for (const field of incoming.fields) {
        if (seen.has(field.key)) continue;
        existing.fields.push(field);
        seen.add(field.key);
      }
      for (const alias of incoming.aliases) {
        if (!existing.aliases.some((item) => norm(item) === norm(alias))) existing.aliases.push(alias);
      }
      if (!existing.note && incoming.note) existing.note = incoming.note;
    }
  }
  return [...merged.values()];
}

function toFixedRecord(record: ManifestRecord): FixedRecord {
  return {
    id: record.id,
    label: record.label,
    aliases: [...(record.aliases ?? [])],
    note: record.note ?? '',
    fields: record.fields.map((field) => ({
      key: field.key,
      label: field.label,
      description: field.description ?? '',
    })),
  };
}

function matchRecord(records: FixedRecord[], wanted: string): FixedRecord | undefined {
  const key = norm(wanted);
  return (
    records.find((record) => norm(record.id) === key) ??
    records.find((record) => norm(record.label) === key) ??
    records.find((record) => record.aliases.some((alias) => norm(alias) === key))
  );
}

function resolveEntity(wanted: string, extensions: string[], records: FixedRecord[]): string {
  const key = norm(wanted);
  const extension = extensions.find((entity) => norm(entity) === key);
  if (extension) return extension;
  const record = matchRecord(records, wanted);
  if (record) return record.id;
  const fixed = records.map((item) => (item.label && item.label !== item.id ? `${item.id}（${item.label}）` : item.id));
  throw new ToolValidationError(
    `没有实体「${wanted}」。可配置扩展字段在：${extensions.join('、') || '（无）'}。固定列在：${fixed.join('、') || '（无）'}。整套系统现在什么样、能改成什么样，用 profile.overview。`,
  );
}

interface WorkflowName {
  label: string;
  aliases: string[];
}

function workflowNames(registry: ModuleRegistry, snapshot: ProfileSnapshot): Map<string, WorkflowName> {
  const names = new Map<string, WorkflowName>();
  const manifests = registry
    .listManifests()
    .filter((manifest) => snapshot.modules[manifest.id])
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const manifest of manifests) {
    for (const [id, aliases] of Object.entries(manifest.workflowAliases ?? {})) {
      const existing = names.get(id) ?? { label: aliases[0] ?? id, aliases: [] };
      for (const alias of aliases) {
        if (!existing.aliases.some((item) => norm(item) === norm(alias))) existing.aliases.push(alias);
      }
      names.set(id, existing);
    }
  }
  return names;
}

function resolveWorkflow(wanted: string, ids: string[], names: Map<string, WorkflowName>): string {
  const key = norm(wanted);
  const exact = ids.find((id) => norm(id) === key);
  if (exact) return exact;
  const matched = ids.find((id) => names.get(id)?.aliases.some((alias) => norm(alias) === key));
  if (matched) return matched;
  const known = ids.map((id) => {
    const label = names.get(id)?.label;
    return label && label !== id ? `${id}（${label}）` : id;
  });
  throw new ToolValidationError(`没有流程「${wanted}」。现有：${known.join('、') || '（无）'}`);
}

function resolveModule(wanted: string, catalog: CatalogItem[]): CatalogItem {
  const key = norm(wanted);
  const matched =
    catalog.find((item) => norm(item.id) === key) ??
    catalog.find((item) => norm(item.name) === key) ??
    catalog.find((item) => item.aliases.some((alias) => norm(alias) === key));
  if (matched) return matched;
  const known = catalog.map((item) => (item.name && item.name !== item.id ? `${item.id}（${item.name}）` : item.id));
  throw new ToolValidationError(`没有模块「${wanted}」。现有：${known.join('、') || '（无）'}`);
}

function objectSummary(
  records: FixedRecord[],
  counts: { entity: string; visible: number; hidden: number }[],
) {
  return allEntityIds(
    counts.map((count) => count.entity),
    records,
  ).map((entity) => {
    const record = records.find((item) => item.id === entity);
    const count = counts.find((item) => item.entity === entity);
    return {
      entity,
      label: record?.label ?? entity,
      fixed: record?.fields.length ?? 0,
      visibleExtensions: count?.visible ?? 0,
      hiddenExtensions: count?.hidden ?? 0,
    };
  });
}

function allEntityIds(extensions: string[], records: FixedRecord[]): string[] {
  return [...new Set([...extensions, ...records.map((record) => record.id)])].sort((a, b) => a.localeCompare(b));
}

function presentEntity(entity: string, rows: RegisteredField[], fixed: FixedRecord | undefined) {
  const fields = rows
    .filter((row) => row.entity === entity)
    .sort((a, b) => a.qualifiedKey.localeCompare(b.qualifiedKey))
    .map((row) => ({
      key: row.qualifiedKey,
      label: row.label,
      type: row.dataType,
      visible: row.visible,
      owner: row.owner,
      sharing: row.sharing,
      description: row.description ?? '',
    }));
  if (!fixed) return { entity, fields };
  return {
    entity,
    label: fixed.label,
    ...(fixed.note ? { note: fixed.note } : {}),
    fixed: fixed.fields,
    fields,
  };
}

function fieldCounts(fields: FieldRegistry, workspaceId: string) {
  const counts = new Map<string, { visible: number; hidden: number }>();
  for (const row of fields.listFields(workspaceId)) {
    const slot = counts.get(row.entity) ?? { visible: 0, hidden: 0 };
    if (row.visible) slot.visible += 1;
    else slot.hidden += 1;
    counts.set(row.entity, slot);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entity, count]) => ({ entity, ...count }));
}
