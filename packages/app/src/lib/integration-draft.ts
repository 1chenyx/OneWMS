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

export interface ExternalApiRoute {
  id: string;
  title: string;
  text: string;
  /** 为空表示按当前配置就能交给对方。有字时说明保存或启用之前打过来会失败。 */
  blocked: string | null;
}

export interface ExternalApiView {
  lead: string;
  routes: ExternalApiRoute[];
}

const API_RESULTS = [
  '200 已接住。internalRef 是我们的单号。同一主键再推仍是 200，不改已经接住的单据。',
  '401 鉴权没对上。',
  '404 这条入口没开，或这家不是这类单据的入站方。',
  '422 报文或编码对不上。',
  '409 业务没接住，改完可以再推同一主键。',
  '一次一笔 JSON，最大 256KB。',
].join('\n');

/** 对接页上始终给出的调用约定。密钥只写占位。某一家的具体地址由 externalApi 再补。 */
export function callerGuide(origin: string | null): string {
  const base = origin ? origin.replace(/\/$/, '') : '{对方打得到的主机}';
  return [
    `POST ${base}/api/integrations/{连接器 id}/{路由 id}`,
    'Content-Type: application/json',
    '',
    '鉴权三选一。把占位换成已经写入本机的密钥。',
    'Authorization: Bearer {令牌}',
    '{请求头}: {前缀}{密钥}',
    'Authorization: Basic {Base64(用户名:密码)}',
    '',
    '保存并生效，并且这条路由是接收之后，才会真的接住。',
    'HMAC 和 OAuth 还没接通，选了这两档对方会被拒绝。',
    '',
    API_RESULTS,
  ].join('\n');
}

/**
 * 给对方的调用说明。地址和示例来自当前草稿，密钥只写占位，不写值。
 * 拉取和只推没有这条地址。
 */
export function externalApi(
  item: ConnectorDraft,
  opts: {
    moduleEnabled: boolean;
    origin: string | null;
    writers: { order: string | null; sku: string | null; partner: string | null } | null;
  },
): ExternalApiView {
  const built = overlayConnector(item);
  if (!built.ok) return { lead: built.message, routes: [] };
  if (item.direction === 'outbound') {
    return { lead: '这家只推。我们按事件推到上面的地址，对方不用调用我们。', routes: [] };
  }
  const routes = Array.isArray(built.value.routes) ? built.value.routes : [];
  const webhooks = routes.filter(isWebhookRoute);
  const polls = routes.some(isPollRoute);
  if (webhooks.length === 0) {
    return {
      lead: polls
        ? '这家是拉取。我们按间隔去取数，对方不用调用我们。'
        : '还没有接收路由。写上一条接收路由之后，这里会给出对方要调用的地址。',
      routes: [],
    };
  }
  const origin = opts.origin ? opts.origin.replace(/\/$/, '') : null;
  const listed = webhooks.map((route) => describeWebhook(item, route, origin, opts));
  const lead = [
    '对方按下面的地址推一笔 JSON。保存并生效之后才会真的接收。',
    '密钥用本机已经写入的那一份，说明里不写密钥值。',
    origin ? '' : '还没有局域网地址。把路径接到对方打得到的主机上。',
    polls ? '其余拉取路由仍由我们按间隔去取。' : '',
  ]
    .filter((line) => line !== '')
    .join('');
  return { lead, routes: listed };
}

function describeWebhook(
  item: ConnectorDraft,
  route: Record<string, unknown>,
  origin: string | null,
  opts: {
    moduleEnabled: boolean;
    writers: { order: string | null; sku: string | null; partner: string | null } | null;
  },
): ExternalApiRoute {
  const id = typeof route.id === 'string' ? route.id : '';
  const canonical = typeof route.canonical === 'string' ? route.canonical : '';
  const title = [id || '未命名', '接收', CANONICAL_LABEL[canonical] ?? canonical].filter((part) => part !== '').join(' · ');
  const auth = authLine(item);
  const path = isConnectorId(item.id.trim()) && isConnectorId(id) ? `/api/integrations/${item.id.trim()}/${id}` : '';
  const url = path ? `${origin ?? ''}${path}` : '';
  const sample = JSON.stringify(sampleBody(route), null, 2);
  const blocked = webhookBlocked(item, route, canonical, path, auth.ready, auth.reason, opts);
  const text = [
    `POST ${url || '(地址还没法拼)'}`,
    auth.line,
    'Content-Type: application/json',
    '',
    sample,
    '',
    ...(blocked ? [blocked, ''] : []),
    API_RESULTS,
  ].join('\n');
  return { id: id || title, title, text, blocked };
}

function webhookBlocked(
  item: ConnectorDraft,
  route: Record<string, unknown>,
  canonical: string,
  path: string,
  authReady: boolean,
  authReason: string,
  opts: {
    moduleEnabled: boolean;
    writers: { order: string | null; sku: string | null; partner: string | null } | null;
  },
): string | null {
  const reasons: string[] = [];
  if (!path) reasons.push('连接器 id 或路由 id 还没法拼成地址');
  if (!opts.moduleEnabled) reasons.push('对接还没启用，保存并生效后才会接收');
  if (!item.enabled) reasons.push('这家还没启用');
  if (route.enabled === false) reasons.push('这条路由停着');
  if (!authReady) reasons.push(authReason);
  const family = canonical.startsWith('order.') ? 'order' : canonical.startsWith('sku.') ? 'sku' : canonical.startsWith('partner.') ? 'partner' : undefined;
  if (item.enabled && opts.writers && family && opts.writers[family] !== item.id.trim()) {
    reasons.push('这类单据的入站不是这家，对方会得到 404');
  }
  return reasons.length > 0 ? reasons.join('。') : null;
}

function authLine(item: ConnectorDraft): { line: string; ready: boolean; reason: string } {
  if (item.adapter === 'bearer') return { line: 'Authorization: Bearer {令牌}', ready: true, reason: '' };
  if (item.adapter === 'apiKey') {
    const header = item.header.trim() || 'X-Api-Key';
    const prefix = item.prefix.trim();
    return { line: `${header}: ${prefix}{密钥}`, ready: true, reason: '' };
  }
  if (item.adapter === 'basic') return { line: 'Authorization: Basic {Base64(用户名:密码)}', ready: true, reason: '' };
  if (item.adapter === 'none') return { line: '接收必须带鉴权', ready: false, reason: '接收必须带鉴权，请改成 Bearer、API Key 或 Basic' };
  return { line: '这一档鉴权还没接通', ready: false, reason: '这一档鉴权还没接通，对方现在打过来会被拒绝' };
}

function sampleBody(route: Record<string, unknown>): Record<string, unknown> {
  const canonical = typeof route.canonical === 'string' ? route.canonical : '';
  const document: Record<string, unknown> = {};
  const externalId = isObject(route.idempotency) && typeof route.idempotency.externalIdPath === 'string' ? route.idempotency.externalIdPath : '';
  if (externalId) putSample(document, externalId, idExample(canonical));
  const mapping = isObject(route.mapping) ? route.mapping : {};
  if (Array.isArray(mapping.fields)) {
    for (const field of mapping.fields) {
      if (isObject(field)) absorbSample(document, field.from);
    }
  }
  if (isObject(mapping.lines) && typeof mapping.lines.from === 'string' && Array.isArray(mapping.lines.item)) {
    const line: Record<string, unknown> = {};
    for (const field of mapping.lines.item) {
      if (isObject(field)) absorbSample(line, field.from);
    }
    putSample(document, mapping.lines.from, [line]);
  }
  const inbound = isObject(route.inbound) ? route.inbound : {};
  const itemsPath = typeof inbound.itemsPath === 'string' ? inbound.itemsPath : '';
  if (itemsPath === '') return document;
  const wrapped: Record<string, unknown> = {};
  putSample(wrapped, itemsPath, document);
  return wrapped;
}

function absorbSample(target: Record<string, unknown>, from: unknown): void {
  if (!isObject(from) || typeof from.op !== 'string' || from.op === 'const') return;
  if (from.op === 'template' && typeof from.template === 'string') {
    for (const match of from.template.matchAll(/\{([^{}]+)\}/g)) putSample(target, match[1] ?? '', '示例');
    return;
  }
  if (typeof from.path !== 'string' || from.path === '') return;
  putSample(target, from.path, valueExample(from.path, from.op, typeof from.entity === 'string' ? from.entity : undefined));
}

function idExample(canonical: string): string {
  if (canonical.startsWith('sku.')) return 'SKU-1';
  if (canonical.startsWith('partner.')) return 'P-1';
  return 'SO1001';
}

function valueExample(path: string, op: string, entity: string | undefined): string {
  if (op === 'number') return '2';
  if (op === 'date') return '2026-11-13';
  if (op === 'code') {
    if (entity === 'partner') return 'C08';
    if (entity === 'warehouse') return 'WH-01';
    return 'A1';
  }
  const leaf = path.split('.').pop() ?? path;
  if (leaf === 'billNo' || leaf === 'orderNo') return 'SO1001';
  if (leaf === 'qty' || leaf === 'quantity') return '2';
  return '示例';
}

function putSample(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter((part) => part !== '');
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = cursor[key];
    if (!isObject(next)) {
      if (cursor[key] !== undefined) return;
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  const leaf = parts[parts.length - 1]!;
  if (cursor[leaf] === undefined) cursor[leaf] = value;
}

function isWebhookRoute(route: unknown): route is Record<string, unknown> {
  return isObject(route) && route.direction === 'in' && isObject(route.inbound) && route.inbound.mode === 'webhook';
}

function isPollRoute(route: unknown): boolean {
  return isObject(route) && route.direction === 'in' && isObject(route.inbound) && route.inbound.mode === 'poll';
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
