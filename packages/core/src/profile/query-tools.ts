import { ToolValidationError } from '../errors.js';
import type { ToolDefinition } from '../bus/tool-bus.js';
import type { FieldRegistry } from '../registry/field-registry.js';
import type { ModuleRegistry } from '../modules/module-registry.js';
import type { ModuleManifest } from '../modules/manifest-types.js';
import type { ProfileService } from './profile-service.js';
import type { ProfileSnapshot, WorkflowDef, WorkflowEffect } from './profile-types.js';
import { describeWhenCondition, evalWhenCondition } from './when.js';

/**
 * 项目实况查询（只读）。
 *
 * 流程、模块开关、模块设置、扩展字段都在 Profile 里，而且可以改。
 * 系统提示只放简表。用户问「现在怎么走」「有哪些功能」「能配置什么」时，
 * 模型用这四条工具读当前快照，再回答。四条都不落事件。
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
      '查看当前项目概况：有哪些流程、哪些功能已安装或启用、各实体有多少可配置字段。' +
      '用户问「现在是什么情况」「有哪些功能」时先用本工具。' +
      '流程怎么走用 profile.workflow.query；某个功能的开关和设置用 profile.module.query；字段明细用 profile.field.query。' +
      READ_ONLY,
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const catalog = catalogOf(modules, snapshot);
      return {
        profileVersion: snapshot.version,
        workflows: Object.entries(snapshot.workflows)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, wf]) => ({
            id,
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
        fields: fieldCounts(fields, ctx.workspaceId),
        note: '细节用 profile.workflow.query、profile.module.query、profile.field.query。本工具不改配置。',
      };
    },
  };

  const workflowQuery: ToolDefinition = {
    id: 'profile.workflow.query',
    label: '查询流程',
    description:
      '查询当前流程配置：状态、转移、生效条件、数量效应。' +
      '不传 workflowId 返回全部流程；传入则只返回该流程（标识如 inbound、outbound，以概况里的 id 为准）。' +
      'active 为 true 表示按当前模块开关这条转移现在走得通。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: '流程 id（可选，缺省返回全部）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const nameOf = moduleNameOf(modules);
      const ids = Object.keys(snapshot.workflows).sort((a, b) => a.localeCompare(b));
      const wanted = (params as { workflowId?: string }).workflowId?.trim();
      if (wanted && !snapshot.workflows[wanted]) {
        throw new ToolValidationError(`没有流程「${wanted}」。现有：${ids.join('、') || '（无）'}`);
      }
      const picked = wanted ? [wanted] : ids;
      return {
        workflows: picked.map((id) => presentWorkflow(id, snapshot.workflows[id]!, snapshot, nameOf)),
      };
    },
  };

  const moduleQuery: ToolDefinition = {
    id: 'profile.module.query',
    label: '查询功能模块',
    description:
      '查询功能模块：代码里有哪些功能、是否已安装、是否启用、能改哪些设置以及当前值。' +
      '不传 moduleId 列出全部；传入则额外返回该模块贡献的流程、字段和工具名。' +
      '未安装的模块也在列表里，表示这套代码能装、当前项目还没装。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string', description: '模块 id（可选，如 module.asn、core.wms）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const snapshot = profile.getSnapshot(ctx.workspaceId);
      const catalog = catalogOf(modules, snapshot);
      const wanted = (params as { moduleId?: string }).moduleId?.trim();
      if (wanted && !catalog.some((item) => item.id === wanted)) {
        throw new ToolValidationError(
          `没有模块「${wanted}」。现有：${catalog.map((item) => item.id).join('、') || '（无）'}`,
        );
      }
      const picked = wanted ? catalog.filter((item) => item.id === wanted) : catalog;
      return {
        modules: picked.map((item) => presentModule(item, Boolean(wanted))),
      };
    },
  };

  const fieldQuery: ToolDefinition = {
    id: 'profile.field.query',
    label: '查询可配置字段',
    description:
      '查询扩展字段：挂在哪个实体上、名称、类型、是否还在界面显示、由谁提供。' +
      '不传 entity 列出全部实体；传入则只查该实体。已隐藏的字段数据仍在，只是不显示。' +
      READ_ONLY,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: '实体名（可选，如 sku）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const rows = fields.listFields(ctx.workspaceId);
      const known = [...new Set(rows.map((row) => row.entity))].sort((a, b) => a.localeCompare(b));
      const wanted = (params as { entity?: string }).entity?.trim();
      if (wanted && !known.includes(wanted)) {
        throw new ToolValidationError(`没有实体「${wanted}」的扩展字段。现有：${known.join('、') || '（无）'}`);
      }
      const entities = (wanted ? [wanted] : known).map((entity) => ({
        entity,
        fields: rows
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
          })),
      }));
      return { entities };
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
  wf: WorkflowDef,
  snapshot: ProfileSnapshot,
  nameOf: (moduleId: string) => string,
) {
  const labelOf = new Map(wf.states.map((state) => [state.id, state.label]));
  return {
    id,
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
