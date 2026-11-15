import type { ParameterProperty, ParameterSchema } from '@one/core';
import type { AgentMessage, AgentToolMeta } from './types.js';

/**
 * 工具目录（编排层，不进工具总线、不落 oplog）。
 *
 * 常驻上下文只放一行摘要和参数骨架（名称、类型、枚举、数值范围）。
 * 完整说明不在 tools 数组里原地升级——tools.load 把整组说明（描述全文，
 * 加上正文没写过的参数一句）放进这一步的任务框。类型、枚举、必填留在
 * 工具清单里，不在说明里再写一遍。模型按说明发出调用之后，任务框不再带
 * 这段说明；下一条用户消息也不再把该组留在清单里，要用再加载。会话记录
 * 仍是全文。授权范围始终是助手定义与总线的交集，加载不能越权。
 *
 * 工具数不超过 TOOL_CATALOG_DEFER_AT 时，授权内的工具仍然可以直接调用
 * （摘要够用就不用多一轮）。超过之后，未加载的组从 function calling 清单拿掉，
 * 只留分组目录、常驻工具和本轮已经加载的组（LOADED_GROUP_KEEP 控制本轮列出哪些）。
 */

/** 编排层元工具：按组取回完整说明（作为结果返回，不进 tools 数组） */
export const TOOLS_LOAD_ID = 'tools.load';

/** 高频读工具：任何模式下都带完整说明，常见查询不用先加载 */
export const PINNED_TOOL_IDS = ['wms.inventory.query', 'wms.order.query', 'wms.sku.resolve'] as const;

/**
 * 超过这个数量就启用延迟目录：未加载的组不进 function calling 清单，只用
 * tools.load 的分组索引（一行一组）占位，用到哪组加载哪组（说明随结果返回，
 * 下一轮该组工具进清单可直接调用）。这是分步分块的省 token 结构——实测
 * 全量瘦清单约 12K 字符/轮，索引+常驻+1 个已加载组约 3.6K/轮。
 * 悬崖值只需盖住「直发更便宜」的小清单：两个工具的小助手不值得多一轮
 * tools.load。general 约 85 个工具，长期处于延迟模式。
 */
export const TOOL_CATALOG_DEFER_AT = 16;

/** 一个会话里保持「已加载」的组数（延迟模式下决定哪些组列出）。再加载或再用时，丢掉最久没用的。 */
export const LOADED_GROUP_KEEP = 3;

const SUMMARY_MAX = 80;
const STRUCT_DESC_MAX = 80;

const pinnedIds = new Set<string>(PINNED_TOOL_IDS);

/**
 * 单据按任务拆开，避免开一张单就把流转、改单、冲突的说明一起带上。
 * 开单和取消仍是 order。助手管理页的「出入库」分组不跟这里走。
 */
const ORDER_GROUP_OVERRIDE: Readonly<Record<string, string>> = {
  'wms.order.transition': 'order-flow',
  'wms.order.putaway': 'order-flow',
  'wms.order.revise': 'order-edit',
  'wms.order.query': 'order-edit',
  'wms.order.conflict.list': 'order-edit',
  'wms.order.conflict.accept': 'order-edit',
  'wms.order.conflict.dismiss': 'order-edit',
};

/** 组 id：单据见 ORDER_GROUP_OVERRIDE；其余 wms 用第二段，再其余用第一段 */
export function toolGroup(toolId: string): string {
  const override = ORDER_GROUP_OVERRIDE[toolId];
  if (override) return override;
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
    : '加载一组工具的完整说明（随本次调用的结果返回）。清单里的工具现在就能调用，但只有一行摘要；要完整参数规则就先加载对应组。';
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
    // 已加载的组维持摘要：全文在 tools.load 的结果里，不原地升级——
    // tools 数组要字节稳定，前缀缓存才命得中（见文件头）
    out.push(presentTool(tool, pinned ? 'full' : 'slim'));
  }
  out.push(...session);
  if (domain.length > 0) out.push(buildLoadTool(domain, defer));
  return out;
}

export interface LoadOutcome {
  ok: boolean;
  /** 成功时为组 id，调用方把它记入已加载集合 */
  group?: string;
  payload: { group: string; toolIds: string[]; docs: string } | { error: string };
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
  const tools = domain.filter((t) => toolGroup(t.id) === group);
  return {
    ok: true,
    group,
    payload: { group, toolIds: tools.map((t) => t.id), docs: renderGroupDocs(group, tools) },
  };
}

/**
 * 整组说明：每个工具的描述全文。常驻工具的全文已经在清单里，这里不重复。
 * 参数的类型、枚举、必填也不重复。正文没写到的参数说明留一句。
 */
function renderGroupDocs(group: string, tools: readonly AgentToolMeta[]): string {
  const documented = tools.filter((t) => !pinnedIds.has(t.id));
  const blocks = documented.map((t) => renderToolDoc(t));
  const lines = [`【${group} 组完整说明】本组工具现在可直接调用，无需再次加载。`];
  if (documented.length < tools.length) lines.push('常驻工具的说明已在清单里，这里不重复。');
  if (blocks.length > 0) lines.push(blocks.join('\n\n'));
  return lines.join('\n\n');
}

function renderToolDoc(tool: AgentToolMeta): string {
  const lines = [`### ${tool.id}——${tool.label}`, tool.description.trim()];
  const notes = uniqueParamNotes(tool);
  if (notes.length > 0) {
    lines.push('参数里正文没写的：');
    lines.push(...notes);
  }
  return lines.join('\n');
}

/** 正文已经包含的参数说明不再附。类型和必填看工具清单。 */
function uniqueParamNotes(tool: AgentToolMeta): string[] {
  const body = tool.description;
  const notes: string[] = [];
  for (const [name, prop] of Object.entries(tool.parameters.properties ?? {})) {
    const desc = prop.description?.trim();
    if (!desc || alreadySaid(body, desc)) continue;
    notes.push(`- ${name}：${desc}`);
  }
  return notes;
}

function alreadySaid(body: string, desc: string): boolean {
  if (body.includes(desc)) return true;
  const parts = desc
    .split(/[，。；]/)
    .map((part) => part.replace(/（[^）]*）/g, '').trim())
    .filter((part) => part.length >= 6);
  return parts.length > 0 && parts.every((part) => body.includes(part));
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
 * 从会话历史统计最近加载过的组。tools.load 成功才加入；
 * 之后调用该组里的工具会把它算作最近使用。只留最近 LOADED_GROUP_KEEP 组。
 * 编排不在新的一条用户消息开始时调用它：跨轮恢复会把瘦 schema 一直留在清单里。
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
