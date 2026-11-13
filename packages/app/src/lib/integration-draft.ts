/**
 * 对接页的草稿。配置是 Profile 里的 JSON，密钥不进这份对象。
 * 名称、地址、鉴权和启用以表单为准，路由和映射留在连接器 JSON 里。
 * 模块 id 与 @one/wms 的 INTEGRATION_MODULE_ID 相同。页面不引用那个包。
 */

export const INTEGRATION_MODULE_ID = 'module.integration';

const CONNECTOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isConnectorId(value: string): boolean {
  return CONNECTOR_ID.test(value);
}

export const DIRECTION_OPTIONS = [
  { value: 'inbound', label: '只收' },
  { value: 'outbound', label: '只推' },
  { value: 'both', label: '收和推' },
] as const;

export const ADAPTER_OPTIONS = [
  { value: 'none', label: '不鉴权' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'apiKey', label: 'API Key' },
  { value: 'basic', label: 'Basic' },
  { value: 'hmac-sha256', label: 'HMAC（还没接通）' },
  { value: 'oauth2-client', label: 'OAuth（还没接通）' },
] as const;

export type DraftDirection = (typeof DIRECTION_OPTIONS)[number]['value'];
export type DraftAdapter = (typeof ADAPTER_OPTIONS)[number]['value'];

export interface ConnectorDraft {
  localId: string;
  id: string;
  name: string;
  enabled: boolean;
  direction: DraftDirection;
  baseUrl: string;
  adapter: DraftAdapter;
  header: string;
  prefix: string;
  json: string;
  secrets: Record<string, string>;
}

export interface IntegrationDraft {
  enabled: boolean;
  pollIntervalSec: number;
  maxAttempts: number;
  timeoutMs: number;
  connectors: ConnectorDraft[];
  selected: string | null;
}

export interface SettingsBody {
  pollIntervalSec: number;
  maxAttempts: number;
  timeoutMs: number;
  writers: { order: string | null; sku: string | null; partner: string | null };
  connectors: Record<string, unknown>;
}

const FAMILY_LABEL = { order: '订单入站', sku: '货品入站', partner: '往来入站' } as const;

const CANONICAL_LABEL: Record<string, string> = {
  'order.create': '建单',
  'order.transition': '改状态',
  'sku.create': '建货品',
  'sku.update': '改货品',
  'partner.create': '建往来',
  'partner.update': '改往来',
  'order.snapshot': '单据快照',
  'sku.snapshot': '货品快照',
  'partner.snapshot': '往来快照',
  'inventory.movement': '库存变动',
};

/** 表单这一格要写入的引用名。配置里如果改过引用名，就跟着配置走。 */
export function secretRefName(item: ConnectorDraft, slot: string): string {
  const built = overlayConnector(item);
  if (!built.ok || !isObject(built.value.auth) || !isObject(built.value.auth.secretRefs)) return slot;
  const name = built.value.auth.secretRefs[slot];
  return typeof name === 'string' && isConnectorSecretName(name) ? name : slot;
}

const SECRET_NAME = /^[a-z][a-z0-9-]{0,40}$/;

function isConnectorSecretName(value: string): boolean {
  return SECRET_NAME.test(value);
}

export function secretSlots(adapter: DraftAdapter): { slot: string; label: string }[] {
  if (adapter === 'bearer') return [{ slot: 'token', label: '令牌' }];
  if (adapter === 'apiKey') return [{ slot: 'key', label: '密钥' }];
  if (adapter === 'basic') return [
    { slot: 'username', label: '用户名' },
    { slot: 'password', label: '密码' },
  ];
  if (adapter === 'hmac-sha256') return [{ slot: 'secret', label: '签名密钥' }];
  if (adapter === 'oauth2-client') return [
    { slot: 'clientId', label: '客户端标识' },
    { slot: 'clientSecret', label: '客户端密钥' },
  ];
  return [];
}

export function emptyDraft(): IntegrationDraft {
  return {
    enabled: true,
    pollIntervalSec: 60,
    maxAttempts: 8,
    timeoutMs: 15_000,
    connectors: [],
    selected: null,
  };
}

export function draftFromModule(config: { enabled: boolean; settings?: Record<string, unknown> } | undefined): IntegrationDraft {
  if (!config) return emptyDraft();
  const settings = config.settings ?? {};
  const raw = isObject(settings.connectors) ? settings.connectors : {};
  const connectors = Object.entries(raw).map(([key, value]) => fromStored(key, value));
  return {
    enabled: config.enabled,
    pollIntervalSec: integer(settings.pollIntervalSec, 60),
    maxAttempts: integer(settings.maxAttempts, 8),
    timeoutMs: integer(settings.timeoutMs, 15_000),
    connectors,
    selected: connectors[0]?.localId ?? null,
  };
}

export function nextConnectorId(ids: readonly string[]): string {
  if (!ids.includes('erp')) return 'erp';
  let n = 2;
  while (ids.includes(`erp-${n}`)) n += 1;
  return `erp-${n}`;
}

export function blankConnector(id: string): ConnectorDraft {
  return fromStored(id, {
    id,
    name: '新的对接',
    enabled: false,
    direction: 'inbound',
    transport: { kind: 'http', baseUrl: 'https://erp.example' },
    auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
    endpoints: [{ id: 'pull', method: 'GET', path: '/orders', shape: 'document' }],
    routes: [],
  });
}

export function buildSettings(draft: IntegrationDraft): { ok: true; settings: SettingsBody } | { ok: false; message: string } {
  const connectors: Record<string, unknown> = {};
  for (const item of draft.connectors) {
    const built = overlayConnector(item);
    if (!built.ok) return built;
    if (connectors[built.id]) return { ok: false, message: `连接器 id ${built.id} 重复` };
    connectors[built.id] = built.value;
  }
  return {
    ok: true,
    settings: {
      pollIntervalSec: draft.pollIntervalSec,
      maxAttempts: draft.maxAttempts,
      timeoutMs: draft.timeoutMs,
      writers: deriveWriters(connectors),
      connectors,
    },
  };
}

/** 保存前把表单盖回 JSON，文本框和将要提议的内容一致。密钥字段留在草稿里。 */
export function syncDraft(draft: IntegrationDraft, connectors: Record<string, unknown>): IntegrationDraft {
  return {
    ...draft,
    connectors: draft.connectors.map((item) => {
      const value = connectors[item.id];
      if (!isObject(value)) return item;
      const next = fromStored(item.id, value, item.localId);
      return { ...next, secrets: item.secrets };
    }),
  };
}

export function routeLines(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return ['这段还不是 JSON'];
  }
  if (!isObject(parsed) || !Array.isArray(parsed.routes)) return ['还没有路由'];
  if (parsed.routes.length === 0) return ['还没有路由'];
  return parsed.routes.map((route) => describeRoute(route));
}

export function writerPreview(draft: IntegrationDraft): string {
  const built = buildSettings(draft);
  if (!built.ok) return built.message;
  const names = new Map(draft.connectors.map((item) => [item.id, item.name.trim() || item.id]));
  const owners: Record<'order' | 'sku' | 'partner', string[]> = { order: [], sku: [], partner: [] };
  for (const [id, connector] of Object.entries(built.settings.connectors)) {
    if (!isObject(connector) || connector.enabled !== true || !Array.isArray(connector.routes)) continue;
    const families = new Set<'order' | 'sku' | 'partner'>();
    for (const route of connector.routes) {
      const family = inboundFamily(route);
      if (family) families.add(family);
    }
    for (const family of families) owners[family].push(names.get(id) || id);
  }
  return (['order', 'sku', 'partner'] as const)
    .map((family) => {
      const list = owners[family];
      if (list.length === 0) return `${FAMILY_LABEL[family]}：没有`;
      if (list.length === 1) return `${FAMILY_LABEL[family]}：${list[0]}`;
      return `${FAMILY_LABEL[family]}：${list.join('、')}不能同时写`;
    })
    .join('。');
}

export function modulePatch(input: {
  installed: boolean;
  wasEnabled: boolean;
  hadSettings: boolean;
  enabled: boolean;
  settings: SettingsBody;
}): { op: string; path: string; value?: unknown }[] {
  if (!input.installed) {
    return [{ op: 'add', path: `/modules/${INTEGRATION_MODULE_ID}`, value: { enabled: input.enabled, settings: input.settings } }];
  }
  const ops: { op: string; path: string; value?: unknown }[] = [];
  if (input.wasEnabled !== input.enabled) {
    ops.push({ op: 'replace', path: `/modules/${INTEGRATION_MODULE_ID}/enabled`, value: input.enabled });
  }
  ops.push({
    op: input.hadSettings ? 'replace' : 'add',
    path: `/modules/${INTEGRATION_MODULE_ID}/settings`,
    value: input.settings,
  });
  return ops;
}

function overlayConnector(item: ConnectorDraft): { ok: true; id: string; value: Record<string, unknown> } | { ok: false; message: string } {
  const label = item.name.trim() || item.id || '连接器';
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.json) as unknown;
  } catch {
    return { ok: false, message: `${label} 的配置还不是 JSON` };
  }
  if (!isObject(parsed)) return { ok: false, message: `${label} 的配置要是一个对象` };
  const id = item.id.trim();
  if (!isConnectorId(id)) return { ok: false, message: `${label} 的 id 只能是小写字母、数字和短横线` };
  const value: Record<string, unknown> = { ...parsed };
  value.id = id;
  value.name = item.name.trim();
  value.enabled = item.enabled;
  value.direction = item.direction;
  value.transport = { kind: 'http', baseUrl: item.baseUrl.trim() };
  value.auth = overlayAuth(item, isObject(parsed.auth) ? parsed.auth : undefined);
  return { ok: true, id, value };
}

function overlayAuth(item: ConnectorDraft, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  const refs = isObject(previous?.secretRefs) ? previous.secretRefs : {};
  const ref = (slot: string, fallback: string): string => {
    const value = refs[slot];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };
  if (item.adapter === 'none') return { adapter: 'none' };
  if (item.adapter === 'bearer') return { adapter: 'bearer', secretRefs: { token: ref('token', 'token') } };
  if (item.adapter === 'apiKey') {
    const placement: Record<string, string> = { header: item.header.trim() || 'X-Api-Key' };
    if (item.prefix.trim()) placement.prefix = item.prefix.trim();
    return { adapter: 'apiKey', secretRefs: { key: ref('key', 'key') }, placement };
  }
  if (item.adapter === 'basic') {
    return { adapter: 'basic', secretRefs: { username: ref('username', 'username'), password: ref('password', 'password') } };
  }
  if (item.adapter === 'hmac-sha256') {
    const hmac = isObject(previous?.hmac) ? previous.hmac : { header: 'X-Signature', signedParts: ['body'] };
    return { adapter: 'hmac-sha256', secretRefs: { secret: ref('secret', 'secret') }, hmac };
  }
  const oauth = isObject(previous?.oauth) ? previous.oauth : { tokenPath: '/oauth/token' };
  return {
    adapter: 'oauth2-client',
    secretRefs: { clientId: ref('clientId', 'client-id'), clientSecret: ref('clientSecret', 'client-secret') },
    oauth,
  };
}

function deriveWriters(connectors: Record<string, unknown>): SettingsBody['writers'] {
  const owners: Record<'order' | 'sku' | 'partner', string[]> = { order: [], sku: [], partner: [] };
  for (const [id, connector] of Object.entries(connectors)) {
    if (!isObject(connector) || connector.enabled !== true || !Array.isArray(connector.routes)) continue;
    const families = new Set<'order' | 'sku' | 'partner'>();
    for (const route of connector.routes) {
      const family = inboundFamily(route);
      if (family) families.add(family);
    }
    for (const family of families) owners[family].push(id);
  }
  const one = (family: 'order' | 'sku' | 'partner') => (owners[family].length === 1 ? owners[family][0] : null);
  return { order: one('order'), sku: one('sku'), partner: one('partner') };
}

function inboundFamily(route: unknown): 'order' | 'sku' | 'partner' | undefined {
  if (!isObject(route) || route.enabled !== true || route.direction !== 'in') return undefined;
  const canonical = route.canonical;
  if (typeof canonical !== 'string') return undefined;
  if (canonical.startsWith('order.')) return 'order';
  if (canonical.startsWith('sku.')) return 'sku';
  if (canonical.startsWith('partner.')) return 'partner';
  return undefined;
}

function describeRoute(route: unknown): string {
  if (!isObject(route)) return '路由不是对象';
  const id = typeof route.id === 'string' && route.id ? route.id : '未命名';
  const mode = route.direction === 'out' ? '推送' : routeInboundMode(route.inbound);
  const canonical = typeof route.canonical === 'string' ? (CANONICAL_LABEL[route.canonical] ?? route.canonical) : '';
  const off = route.enabled === false ? '停用' : '';
  return [id, mode, canonical, off].filter((part) => part !== '').join(' · ');
}

function routeInboundMode(inbound: unknown): string {
  if (!isObject(inbound)) return '入站';
  if (inbound.mode === 'poll') return '拉取';
  if (inbound.mode === 'webhook') return '接收';
  return '入站';
}

function fromStored(key: string, value: unknown, localId = key): ConnectorDraft {
  const record = isObject(value) ? value : {};
  const id = typeof record.id === 'string' ? record.id : key;
  const auth = isObject(record.auth) ? record.auth : {};
  const adapter = isAdapter(auth.adapter) ? auth.adapter : 'bearer';
  return {
    localId,
    id,
    name: typeof record.name === 'string' ? record.name : '',
    enabled: record.enabled === true,
    direction: isDirection(record.direction) ? record.direction : 'inbound',
    baseUrl: transportBase(record.transport),
    adapter,
    header: placementHeader(auth),
    prefix: placementPrefix(auth),
    json: JSON.stringify(isObject(value) ? value : { id: key }, null, 2),
    secrets: {},
  };
}

function transportBase(transport: unknown): string {
  if (!isObject(transport) || typeof transport.baseUrl !== 'string') return '';
  return transport.baseUrl;
}

function placementHeader(auth: Record<string, unknown>): string {
  const placement = isObject(auth.placement) ? auth.placement : undefined;
  return typeof placement?.header === 'string' ? placement.header : 'X-Api-Key';
}

function placementPrefix(auth: Record<string, unknown>): string {
  const placement = isObject(auth.placement) ? auth.placement : undefined;
  return typeof placement?.prefix === 'string' ? placement.prefix : '';
}

function authAdapter(auth: unknown): unknown {
  return isObject(auth) ? auth.adapter : undefined;
}

function isDirection(value: unknown): value is DraftDirection {
  return value === 'inbound' || value === 'outbound' || value === 'both';
}

function isAdapter(value: unknown): value is DraftAdapter {
  return ADAPTER_OPTIONS.some((item) => item.value === value);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
