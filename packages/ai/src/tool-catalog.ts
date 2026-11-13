import type { ParameterProperty, ParameterSchema } from '@one/core';
import type { AgentMessage, AgentToolMeta } from './types.js';

/**
 * 工具目录（编排层，不进工具总线、不落 oplog）。
 *
 * 常驻上下文只放一行摘要和参数骨架（名称、类型、枚举、数值范围）。
 * 完整说明留在工具定义里，模型调用 tools.load 之后，下一轮才把该组的
 * 全文和参数说明附上。已加载的组只保留最近用过的 LOADED_GROUP_KEEP 组。
 * 授权范围始终是助手定义与总线的交集，加载不能越权。
 *
 * 工具数不超过 TOOL_CATALOG_DEFER_AT 时，授权内的工具仍然可以直接调用
 * （摘要够用就不用多一轮）。超过之后，未加载的组从 function calling 清单拿掉，
 * 只留分组目录、常驻工具和已经加载的组。
 */

/** 编排层元工具：按组把完整说明升进下一轮的 tools */
export const TOOLS_LOAD_ID = 'tools.load';

/** 高频读工具：任何模式下都带完整说明，常见查询不用先加载 */
export const PINNED_TOOL_IDS = ['wms.inventory.query', 'wms.sku.resolve'] as const;

/**
 * 超过这个数量才延迟暴露未加载的组。
 * 再低会让小模型多付一轮，再高则整份 schema 重新变重。
 * 这是个悬崖值——授权工具数一越过它，所有未加载组立刻都要先 tools.load。
 * 每次加工具都得回头看一眼余量。
 * 当前 general 约 81 个：73 个 wms（含 6 个报表）+ 3 个 memory + 5 个 core 读工具（不含 profile.propose）。
 */
export const TOOL_CATALOG_DEFER_AT = 96;

/** 一个会话里同时带着完整说明的组数。再加载或再用时，丢掉最久没用的。 */
export const LOADED_GROUP_KEEP = 3;

const SUMMARY_MAX = 80;
const STRUCT_DESC_MAX = 80;

const pinnedIds = new Set<string>(PINNED_TOOL_IDS);

/** 组 id：wms 用第二段（wms.order.conflict.list → order），其余用第一段 */
export function toolGroup(toolId: string): string {
  const parts = toolId.split('.');
  if (parts[0] === 'wms' && parts.length >= 2) return parts[1] ?? toolId;
  return parts[0] ?? toolId;
}

/** 一行摘要：第一个句号之前；超长再截断 */
export function toolSummary(description: string): string {
  const trimmed = description.trim();
  const end = trimmed.indexOf('。');
  const sentence = (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
  if (sentence.length <= SUMMARY_MAX) return sentence;
  return `${sentence.slice(0, SUMMARY_MAX)}…`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** 瘦参数：留下类型契约。数组 / 对象的一行结构说明保留（items 通常没有 properties） */
function slimProperty(prop: ParameterProperty): ParameterProperty {
  const next: ParameterProperty = { type: prop.type };
  if (prop.enum) next.enum = [...prop.enum];
  if (prop.minimum !== undefined) next.minimum = prop.minimum;
  if (prop.maximum !== undefined) next.maximum = prop.maximum;
  if (prop.default !== undefined) next.default = prop.default;
  if (prop.items) next.items = slimProperty(prop.items);
  if (prop.description && (prop.type === 'array' || prop.type === 'object')) {
    next.description = clip(prop.description, STRUCT_DESC_MAX);
  }
  return next;
}

export function slimParameters(schema: ParameterSchema): ParameterSchema {
  const properties: Record<string, ParameterProperty> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    properties[key] = slimProperty(prop);
  }
  const out: ParameterSchema = { type: 'object', properties };
  if (schema.required) out.required = [...schema.required];
  return out;
}

export function presentTool(tool: AgentToolMeta, mode: 'slim' | 'full'): AgentToolMeta {
  if (mode === 'full') return tool;
  return {
    ...tool,
    description: toolSummary(tool.description),
    parameters: slimParameters(tool.parameters),
  };
}

function groupsOf(tools: readonly AgentToolMeta[]): Map<string, AgentToolMeta[]> {
  const groups = new Map<string, AgentToolMeta[]>();
  for (const tool of tools) {
    const id = toolGroup(tool.id);
    const list = groups.get(id);
    if (list) list.push(tool);
    else groups.set(id, [tool]);
  }
  return groups;
}

function buildLoadTool(tools: readonly AgentToolMeta[], defer: boolean): AgentToolMeta {
  const lines = [...groupsOf(tools).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => `- ${group}（${list.length}）`);
  const head = defer
    ? '加载一组工具的完整说明。清单里还没有的工具必须先加载，下一轮才能调用。'
    : '加载一组工具的完整说明。清单里的工具现在就能调用，但只有一行摘要；加载后下一轮附上该组的完整参数规则。';
  return {
    id: TOOLS_LOAD_ID,
    label: '加载工具说明',
    description: `${head}\n可选组（组 id 与个数）：\n${lines.join('\n')}`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '组 id，取上面列表中的一项' },
      },
      required: ['group'],
    },
    permission: 'read',
  };
}

/** 本轮送给模型的工具清单。session 原样附在业务工具之后（如 ui.ask） */
export function presentCatalog(
  domain: readonly AgentToolMeta[],
  expanded: ReadonlySet<string>,
  session: readonly AgentToolMeta[] = [],
): AgentToolMeta[] {
  const defer = domain.length > TOOL_CATALOG_DEFER_AT;
  const out: AgentToolMeta[] = [];
  for (const tool of domain) {
    const loaded = expanded.has(toolGroup(tool.id));
    const pinned = pinnedIds.has(tool.id);
    if (defer && !loaded && !pinned) continue;
    out.push(presentTool(tool, loaded || pinned ? 'full' : 'slim'));
  }
  out.push(...session);
  if (domain.length > 0) out.push(buildLoadTool(domain, defer));
  return out;
}

export interface LoadOutcome {
  ok: boolean;
  /** 成功时为组 id，调用方把它记入已加载集合 */
  group?: string;
  payload: { group: string; toolIds: string[] } | { error: string };
}

/** 只加载授权集里存在的组。未知组回错误，不扩大权限 */
export function applyLoad(domain: readonly AgentToolMeta[], args: Record<string, unknown>): LoadOutcome {
  const group = typeof args.group === 'string' ? args.group.trim() : '';
  const available = [...new Set(domain.map((t) => toolGroup(t.id)))].sort((a, b) => a.localeCompare(b));
  if (!group || !available.includes(group)) {
    return {
      ok: false,
      payload: { error: `没有工具组「${group || '(空)'}」。可选：${available.join('、') || '（无）'}` },
    };
  }
  const toolIds = domain.filter((t) => toolGroup(t.id) === group).map((t) => t.id);
  return { ok: true, group, payload: { group, toolIds } };
}

/**
 * 把组记为最近使用。已在集合里则挪到末尾；超过 LOADED_GROUP_KEEP 时丢掉最久没用的。
 * 集合迭代顺序是从最久到最近。
 */
export function touchLoadedGroup(groups: Set<string>, group: string): void {
  if (!group) return;
  groups.delete(group);
  groups.add(group);
  while (groups.size > LOADED_GROUP_KEEP) {
    const oldest = groups.values().next().value;
    if (oldest === undefined) break;
    groups.delete(oldest);
  }
}

/**
 * 从会话历史恢复已加载的组。tools.load 成功才加入；
 * 之后调用该组里的工具会把它算作最近使用。只留最近 LOADED_GROUP_KEEP 组。
 */
export function expandedGroupsFromHistory(messages: readonly AgentMessage[]): Set<string> {
  const groups = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool-results') continue;
    for (const result of message.results) {
      if (result.toolId === TOOLS_LOAD_ID) {
        if (!result.ok) continue;
        const payload = result.payload;
        if (!payload || typeof payload !== 'object') continue;
        const group = (payload as { group?: unknown }).group;
        if (typeof group === 'string' && group) touchLoadedGroup(groups, group);
        continue;
      }
      if (result.toolId === 'ui.ask') continue;
      const group = toolGroup(result.toolId);
      if (groups.has(group)) touchLoadedGroup(groups, group);
    }
  }
  return groups;
}

/**
 * 目录开启时，拦住两种调用：不在授权集里的工具，以及延迟模式下还没加载的工具。
 * 返回 undefined 表示交给工具总线。
 */
export function catalogBlock(
  toolId: string,
  domain: readonly AgentToolMeta[],
  expanded: ReadonlySet<string>,
  sessionIds?: ReadonlySet<string>,
): { error: string } | undefined {
  if (toolId === TOOLS_LOAD_ID || toolId === 'ui.ask' || sessionIds?.has(toolId)) return undefined;
  if (!domain.some((t) => t.id === toolId)) {
    return { error: `工具 ${toolId} 不在该助手的授权范围内` };
  }
  if (domain.length <= TOOL_CATALOG_DEFER_AT) return undefined;
  if (expanded.has(toolGroup(toolId)) || pinnedIds.has(toolId)) return undefined;
  return { error: `工具 ${toolId} 尚未加载。先调用 tools.load，group 填 ${toolGroup(toolId)}` };
}
