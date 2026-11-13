import type { AgentDef } from '../api/client';

/**
 * 助手管理页的工具分组。
 *
 * 分组键与编排层 toolGroup 一致：wms 工具取第二段（wms.order.conflict.list → order），
 * 其余取第一段。界面上把 ledger 并进库存——流水只有一个工具，单独成组反而不好找。
 * 应用包不依赖 @one/ai，所以这里自备一份，不从编排层引。
 */

export interface AgentToolInfo {
  id: string;
  label: string;
  description: string;
  permission: 'read' | 'write';
}

export type PermissionFilter = 'all' | 'read' | 'write';

/** 已授权、但当前工具目录里没有的 id */
export const MISSING_TOOLS = '__missing__';

/** 作业在前，档案其次，记忆和配置在最后。未知分组接在后面。 */
const GROUP_ORDER = [
  'inventory',
  'order',
  'picking',
  'stocktake',
  'replenish',
  'lpn',
  'serial',
  'sku',
  'location',
  'warehouse',
  'zone',
  'partner',
  'report',
  'memory',
  'profile',
  'ui',
] as const;

const GROUP_LABELS: Record<string, string> = {
  inventory: '库存',
  order: '出入库',
  picking: '拣货',
  stocktake: '盘点',
  replenish: '补货',
  lpn: '托盘',
  serial: '序列号',
  sku: '商品',
  location: '库位',
  warehouse: '仓库',
  zone: '库区',
  partner: '往来单位',
  report: '报表',
  memory: '记忆',
  profile: '配置',
  ui: '界面',
};

export interface ToolRow {
  id: string;
  label: string;
  description: string;
  permission: 'read' | 'write' | 'unknown';
}

export interface ToolBucket {
  id: string;
  label: string;
  tools: ToolRow[];
}

export function toolGroupId(toolId: string): string {
  const parts = toolId.split('.');
  const raw = parts[0] === 'wms' && parts.length >= 2 && parts[1] ? parts[1] : parts[0] || toolId;
  return raw === 'ledger' ? 'inventory' : raw;
}

export function groupLabel(groupId: string): string {
  if (groupId === MISSING_TOOLS) return '不在目录';
  return GROUP_LABELS[groupId] ?? groupId;
}

/** 列表里的一行说明：第一句，过长再截断 */
export function oneLine(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return '';
  const end = trimmed.indexOf('。');
  const sentence = (end === -1 ? trimmed : trimmed.slice(0, end + 1)).trim();
  if (sentence.length <= 72) return sentence;
  return `${sentence.slice(0, 72)}…`;
}

function permissionRank(permission: ToolRow['permission']): number {
  if (permission === 'read') return 0;
  if (permission === 'write') return 1;
  return 2;
}

function compareTools(a: ToolRow, b: ToolRow): number {
  const byPermission = permissionRank(a.permission) - permissionRank(b.permission);
  if (byPermission !== 0) return byPermission;
  return a.label.localeCompare(b.label, 'zh');
}

function compareGroups(a: string, b: string): number {
  const ia = GROUP_ORDER.indexOf(a as (typeof GROUP_ORDER)[number]);
  const ib = GROUP_ORDER.indexOf(b as (typeof GROUP_ORDER)[number]);
  if (ia === -1 && ib === -1) return a.localeCompare(b, 'zh');
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

/**
 * 目录按业务分组。已授权但不在目录里的 id 单独成组放在最前，
 * 避免保存时静默丢掉，也让人能取消勾选。
 */
export function buildBuckets(catalog: readonly AgentToolInfo[], granted: readonly string[]): ToolBucket[] {
  const byId = new Map<string, AgentToolInfo>();
  for (const tool of catalog) {
    if (!byId.has(tool.id)) byId.set(tool.id, tool);
  }

  const grouped = new Map<string, ToolRow[]>();
  for (const tool of byId.values()) {
    const id = toolGroupId(tool.id);
    const row: ToolRow = {
      id: tool.id,
      label: tool.label,
      description: tool.description,
      permission: tool.permission,
    };
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }

  const buckets: ToolBucket[] = [...grouped.keys()].sort(compareGroups).map((id) => ({
    id,
    label: groupLabel(id),
    tools: grouped.get(id)!.sort(compareTools),
  }));

  const missing: ToolRow[] = [];
  const seen = new Set<string>();
  for (const id of granted) {
    if (byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push({
      id,
      label: id,
      description: '工具目录里已经没有这项。取消勾选后，保存提议就不会再带上它。',
      permission: 'unknown',
    });
  }
  if (missing.length > 0) {
    buckets.unshift({ id: MISSING_TOOLS, label: groupLabel(MISSING_TOOLS), tools: missing });
  }
  return buckets;
}

export function matchesTool(tool: ToolRow, query: string, permission: PermissionFilter): boolean {
  if (permission !== 'all' && tool.permission !== permission) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    tool.label.toLowerCase().includes(q) ||
    tool.id.toLowerCase().includes(q) ||
    tool.description.toLowerCase().includes(q)
  );
}

/** 筛掉空组。组内只留匹配的工具，分组顺序不变。 */
export function visibleBuckets(
  buckets: readonly ToolBucket[],
  query: string,
  permission: PermissionFilter,
): ToolBucket[] {
  return buckets
    .map((bucket) => ({
      ...bucket,
      tools: bucket.tools.filter((tool) => matchesTool(tool, query, permission)),
    }))
    .filter((bucket) => bucket.tools.length > 0);
}

export type GroupLevel = 'off' | 'read' | 'write' | 'custom';

export interface GroupChoice {
  value: 'off' | 'read' | 'write';
  label: string;
}

/** 整档的说法。配置的写入是提议，和直接改库存分开。 */
export function levelTitle(level: GroupLevel, groupId: string): string {
  if (level === 'off') return '不开放';
  if (level === 'custom') return '单独调整';
  if (level === 'read') return groupId === 'profile' ? '只能查看' : '只能查询';
  return groupId === 'profile' ? '可以提议' : '可以修改';
}

/** 大按钮下的一句说明。 */
export function levelDetail(bucket: ToolBucket, level: 'off' | 'read' | 'write'): string {
  if (level === 'off') return '这个助手用不到这一块。';
  if (bucket.id === 'profile') {
    return level === 'read' ? '只能查看配置，不能提议修改。' : '可以提议修改，确认后才生效。';
  }
  if (level === 'read') return '只能查询，不能改数据。';
  const hasRead = bucket.tools.some((tool) => tool.permission === 'read');
  return hasRead ? '可以查询，也可以修改。' : '可以修改这一块的数据。';
}

/**
 * 一块业务上能选的整档。没有查询工具就不出现「只能查询」，
 * 没有写入工具就不出现「可以修改」。
 */
export function groupChoices(bucket: ToolBucket): GroupChoice[] {
  const hasRead = bucket.tools.some((tool) => tool.permission === 'read');
  const hasWrite = bucket.tools.some((tool) => tool.permission === 'write');
  const choices: GroupChoice[] = [{ value: 'off', label: levelTitle('off', bucket.id) }];
  if (hasRead) choices.push({ value: 'read', label: levelTitle('read', bucket.id) });
  if (hasWrite) choices.push({ value: 'write', label: levelTitle('write', bucket.id) });
  return choices;
}

/** 当前授权落在整组的哪一档。对不齐任何一档就是自定义。 */
export function groupLevel(tools: readonly ToolRow[], granted: readonly string[]): GroupLevel {
  const set = new Set(granted);
  const reads = tools.filter((tool) => tool.permission === 'read');
  const writes = tools.filter((tool) => tool.permission === 'write');
  const selected = tools.filter((tool) => set.has(tool.id));
  if (selected.length === 0) return 'off';
  const allReads = reads.every((tool) => set.has(tool.id));
  const allWrites = writes.every((tool) => set.has(tool.id));
  if (allReads && allWrites && selected.length === reads.length + writes.length) {
    return writes.length > 0 ? 'write' : 'read';
  }
  if (allReads && writes.every((tool) => !set.has(tool.id)) && selected.length === reads.length) return 'read';
  return 'custom';
}

/** 把一整组拨到某一档。组外已有的授权保持原顺序。 */
export function applyGroupLevel(
  granted: readonly string[],
  tools: readonly ToolRow[],
  level: 'off' | 'read' | 'write',
): string[] {
  const ids = tools.map((tool) => tool.id);
  const cleared = applyToolIds(granted, ids, false);
  if (level === 'off') return cleared;
  if (level === 'read') {
    return applyToolIds(
      cleared,
      tools.filter((tool) => tool.permission === 'read').map((tool) => tool.id),
      true,
    );
  }
  return applyToolIds(cleared, ids, true);
}

/**
 * 清单上的一句话：先说能改的，再说只能查的，最多点出三块业务。
 * 一块都没有就是「还不能做任何事」。
 */
export function assistantSummary(buckets: readonly ToolBucket[], granted: readonly string[]): string {
  const modify: string[] = [];
  const propose: string[] = [];
  const query: string[] = [];
  const view: string[] = [];
  const custom: string[] = [];
  for (const bucket of buckets) {
    if (bucket.id === MISSING_TOOLS) continue;
    const level = groupLevel(bucket.tools, granted);
    if (level === 'off') continue;
    if (level === 'custom') custom.push(bucket.label);
    else if (level === 'write' && bucket.id === 'profile') propose.push(bucket.label);
    else if (level === 'write') modify.push(bucket.label);
    else if (bucket.id === 'profile') view.push(bucket.label);
    else query.push(bucket.label);
  }
  const phrases = [
    { verb: '可以修改', names: modify },
    { verb: '可以提议修改', names: propose },
    { verb: '只能查询', names: query },
    { verb: '只能查看', names: view },
    { verb: '单独调整', names: custom },
  ].filter((phrase) => phrase.names.length > 0);
  if (phrases.length === 0) return '还不能做任何事';
  let budget = 3;
  let omitted = 0;
  const parts: string[] = [];
  for (const phrase of phrases) {
    if (budget <= 0) {
      omitted += phrase.names.length;
      continue;
    }
    const take = phrase.names.slice(0, budget);
    omitted += phrase.names.length - take.length;
    budget -= take.length;
    parts.push(`${phrase.verb}${take.join('、')}`);
  }
  return omitted > 0 ? `${parts.join('，')}等` : parts.join('，');
}

/** 悬停说明：这一档各自包含哪些工具名，不写工具 id。 */
export function groupHint(bucket: ToolBucket): string {
  const reads = bucket.tools.filter((tool) => tool.permission === 'read').map((tool) => tool.label);
  const writes = bucket.tools.filter((tool) => tool.permission === 'write').map((tool) => tool.label);
  const writeName = bucket.id === 'profile' ? '可以提议' : '可以修改';
  const lines: string[] = [];
  if (reads.length > 0) lines.push(`${bucket.id === 'profile' ? '只能查看' : '只能查询'}：${reads.join('、')}`);
  if (writes.length > 0) {
    lines.push(reads.length > 0 ? `${writeName}：再包含 ${writes.join('、')}` : `${writeName}：${writes.join('、')}`);
  }
  return lines.join('\n');
}

/** 勾选或取消一批。保留原有顺序，新勾上的按这次的顺序接在后面。 */
export function applyToolIds(current: readonly string[], ids: readonly string[], on: boolean): string[] {
  const next = new Set(current);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of current) {
    if (!next.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const id of ids) {
    if (!next.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

export function readOnlyIds(catalog: readonly AgentToolInfo[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tool of catalog) {
    if (tool.permission !== 'read' || seen.has(tool.id)) continue;
    seen.add(tool.id);
    ids.push(tool.id);
  }
  return ids;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function agentLabel(agent: AgentDef): string {
  return agent.name.trim() || agent.id.trim() || '未命名';
}

/** 和当前生效的清单比，列出这次要改的助手。空数组表示没有差别。 */
export function agentChangeLines(
  before: readonly AgentDef[],
  after: readonly AgentDef[],
  catalog: readonly AgentToolInfo[],
): string[] {
  const prev = new Map(before.map((agent) => [agent.id, agent]));
  const nextIds = new Set(after.map((agent) => agent.id));
  const lines: string[] = [];
  for (const agent of after) {
    const old = prev.get(agent.id);
    const name = agentLabel(agent);
    const summary = assistantSummary(buildBuckets(catalog, agent.tools), agent.tools);
    if (!old) {
      lines.push(`新增「${name}」：${summary}`);
      continue;
    }
    if (agentSnapshot([old]) === agentSnapshot([agent])) continue;
    if (old.name !== agent.name) lines.push(`「${agentLabel(old)}」改名为「${name}」，${summary}`);
    else if (!sameIds(old.tools, agent.tools)) lines.push(`「${name}」改为${summary}`);
    else lines.push(`「${name}」的说明或人设有改动`);
  }
  for (const agent of before) {
    if (!nextIds.has(agent.id)) lines.push(`去掉「${agentLabel(agent)}」`);
  }
  return lines;
}

/** 脏检查用的稳定序列。字段顺序固定，避免只改对象键序就显示未保存。 */
export function agentSnapshot(defs: readonly AgentDef[]): string {
  return JSON.stringify(
    defs.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      tools: [...agent.tools],
      model: agent.model ?? null,
      allowedRoles: agent.allowedRoles ?? null,
    })),
  );
}
