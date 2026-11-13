/**
 * 连接器配置的静态检查。过不了就不能确认启用。
 * 不发请求，不读密钥库。
 */

import {
  INBOUND_SHAPE,
  NATURAL_KEY,
  OUTBOUND_EVENT_CANONICAL,
  SNAPSHOT_LINE,
  SNAPSHOT_TOP,
  canonicalFamily,
  isInboundCanonical,
} from './allowlist.js';
import {
  INTEGRATION_DEFAULTS,
  type Connector,
  type FieldMap,
  type IntegrationIssue,
  type IntegrationSettings,
  type InboundCanonical,
  type ValidateConnectorResult,
  type ValidateSettingsResult,
  type ValueSource,
} from './types.js';
import { CONNECTOR_ID_PATTERN, SECRET_REF_PATTERN } from './ids.js';

const SLUG = CONNECTOR_ID_PATTERN;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const REF_NAME = SECRET_REF_PATTERN;
const HEADER = /^[A-Za-z][A-Za-z0-9-]*$/;
const QUERY_PARAM = /^[A-Za-z][A-Za-z0-9_]*$/;
const DATE_FORMS = ['iso8601', 'date', 'unixMs', 'unixSec', 'yyyyMMdd', 'yyyy-MM-dd HH:mm:ss'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
const HMAC_PARTS = ['method', 'path', 'timestamp', 'body'] as const;
const CODE_ENTITIES = ['sku', 'partner', 'warehouse'] as const;
const CURSOR_FROM = ['iso8601', 'unixMs', 'watermark'] as const;

const CONNECTOR_KEYS = ['id', 'name', 'enabled', 'direction', 'transport', 'auth', 'endpoints', 'routes'] as const;
const AUTH_KEYS = ['adapter', 'secretRefs', 'placement', 'hmac', 'oauth'] as const;
const SETTINGS_KEYS = ['pollIntervalSec', 'maxAttempts', 'timeoutMs', 'writers', 'connectors'] as const;

export function validateConnector(input: unknown): ValidateConnectorResult {
  const issues: IntegrationIssue[] = [];
  const connector = readConnector(input, '', issues);
  if (issues.length > 0 || !connector) return { ok: false, issues };
  return { ok: true, connector };
}

export function validateIntegrationSettings(input: unknown): ValidateSettingsResult {
  const issues: IntegrationIssue[] = [];
  const root = asObject(input, '', issues);
  if (!root) return { ok: false, issues };
  rejectUnknown(root, SETTINGS_KEYS, '', issues);

  const pollIntervalSec = readInt(root, 'pollIntervalSec', INTEGRATION_DEFAULTS.pollIntervalSec, 15, 86_400, '', issues);
  const maxAttempts = readInt(root, 'maxAttempts', INTEGRATION_DEFAULTS.maxAttempts, 1, 50, '', issues);
  const timeoutMs = readInt(root, 'timeoutMs', INTEGRATION_DEFAULTS.timeoutMs, 1_000, 60_000, '', issues);
  const writers = readWriters(root.writers, '/writers', issues);

  const connectors: Record<string, Connector> = {};
  if (!Object.hasOwn(root, 'connectors')) {
    issues.push({ path: '/connectors', code: 'MISSING', message: '缺少 connectors' });
  } else if (!isPlainObject(root.connectors)) {
    issues.push({ path: '/connectors', code: 'TYPE', message: 'connectors 必须是以连接器 id 为键的对象' });
  } else {
    for (const [key, value] of Object.entries(root.connectors)) {
      if (!SLUG.test(key)) {
        issues.push({ path: `/connectors/${key}`, code: 'SLUG', message: '连接器键只能是小写字母、数字和短横线' });
      }
      const parsed = readConnector(value, `/connectors/${key}`, issues);
      if (!parsed) continue;
      if (parsed.id !== key) {
        issues.push({
          path: `/connectors/${key}/id`,
          code: 'ID_KEY',
          message: `连接器 id「${parsed.id}」与配置键「${key}」不一致`,
        });
      }
      connectors[key] = parsed;
    }
  }

  if (writers) checkWriters(writers, connectors, issues);

  if (issues.length > 0 || pollIntervalSec === undefined || maxAttempts === undefined || timeoutMs === undefined || !writers) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    settings: { pollIntervalSec, maxAttempts, timeoutMs, writers, connectors },
  };
}

function checkWriters(
  writers: IntegrationSettings['writers'],
  connectors: Record<string, Connector>,
  issues: IntegrationIssue[],
): void {
  const families = ['order', 'sku', 'partner'] as const;
  for (const family of families) {
    const named = writers[family];
    if (named && !connectors[named]) {
      issues.push({ path: `/writers/${family}`, code: 'WRITER', message: `writers.${family} 指向不存在的连接器 ${named}` });
    }
    const owners: string[] = [];
    for (const [id, connector] of Object.entries(connectors)) {
      if (!connector.enabled) continue;
      const inbound = connector.routes.some(
        (route) => route.enabled && route.direction === 'in' && canonicalFamily(route.canonical) === family,
      );
      if (inbound) owners.push(id);
    }
    if (owners.length > 1) {
      issues.push({
        path: `/writers/${family}`,
        code: 'WRITER',
        message: `${family} 入站只能有一个连接器，现在同时有 ${owners.join('、')}`,
      });
      continue;
    }
    const owner = owners[0];
    if (owner && named !== owner) {
      issues.push({
        path: `/writers/${family}`,
        code: 'WRITER',
        message: named
          ? `writers.${family} 是 ${named}，但启用的入站在 ${owner}`
          : `writers.${family} 为空，${owner} 却开了入站`,
      });
    }
  }
}

function readConnector(input: unknown, base: string, issues: IntegrationIssue[]): Connector | undefined {
  const obj = asObject(input, base || '/', issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, CONNECTOR_KEYS, base, issues);

  const id = readSlug(obj.id, `${base}/id`, issues);
  const name = readName(obj.name, `${base}/name`, issues);
  const enabled = readBool(obj.enabled, `${base}/enabled`, issues);
  const direction = readEnum(obj.direction, ['inbound', 'outbound', 'both'] as const, `${base}/direction`, issues);
  const transport = readTransport(obj.transport, `${base}/transport`, issues);
  const auth = readAuth(obj.auth, `${base}/auth`, issues);
  const endpoints = readEndpoints(obj.endpoints, `${base}/endpoints`, issues);
  const routes = readRoutes(obj.routes, `${base}/routes`, direction, auth?.adapter, endpoints, issues);

  if (issues.length > before || !id || !name || enabled === undefined || !direction || !transport || !auth || !endpoints || !routes) {
    return undefined;
  }
  return { id, name, enabled, direction, transport, auth, endpoints, routes };
}

function readTransport(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['kind', 'baseUrl'], path, issues);
  if (obj.kind !== 'http') {
    issues.push({ path: `${path}/kind`, code: 'ENUM', message: '第一版传输只有 http' });
  }
  const baseUrl = readBaseUrl(obj.baseUrl, `${path}/baseUrl`, issues);
  if (!baseUrl || obj.kind !== 'http') return undefined;
  return { kind: 'http' as const, baseUrl };
}

function readBaseUrl(input: unknown, path: string, issues: IntegrationIssue[]): string | undefined {
  if (typeof input !== 'string' || input === '' || input !== input.trim()) {
    issues.push({ path, code: 'URL', message: 'baseUrl 必须是 http 或 https 地址' });
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    issues.push({ path, code: 'URL', message: 'baseUrl 不是合法地址' });
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push({ path, code: 'URL', message: 'baseUrl 只允许 http 或 https' });
    return undefined;
  }
  if (url.username || url.password) {
    issues.push({ path, code: 'URL', message: '地址里不能带账号密码，密钥放到本机密钥库' });
    return undefined;
  }
  if (url.search || url.hash) {
    issues.push({ path, code: 'URL', message: 'baseUrl 不能带查询串或片段' });
    return undefined;
  }
  return input;
}

function readAuth(input: unknown, path: string, issues: IntegrationIssue[]): Connector['auth'] | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, AUTH_KEYS, path, issues);
  const adapter = readEnum(
    obj.adapter,
    ['none', 'bearer', 'apiKey', 'basic', 'hmac-sha256', 'oauth2-client'] as const,
    `${path}/adapter`,
    issues,
  );
  const secretRefs = readSecretRefs(obj.secretRefs, `${path}/secretRefs`, issues);
  if (!adapter || issues.length > before) return undefined;

  const auth: Connector['auth'] = { adapter };
  if (secretRefs && Object.keys(secretRefs).length > 0) auth.secretRefs = secretRefs;

  const need = (key: string) => {
    if (!secretRefs?.[key]) {
      issues.push({ path: `${path}/secretRefs/${key}`, code: 'SECRET_REF', message: `缺少密钥引用 ${key}` });
    }
  };
  const forbid = (key: 'placement' | 'hmac' | 'oauth') => {
    if (obj[key] !== undefined) {
      issues.push({ path: `${path}/${key}`, code: 'UNKNOWN_FIELD', message: `${adapter} 不用 ${key}` });
    }
  };

  if (adapter === 'none') {
    forbid('placement');
    forbid('hmac');
    forbid('oauth');
    if (secretRefs && Object.keys(secretRefs).length > 0) {
      issues.push({ path: `${path}/secretRefs`, code: 'SECRET_REF', message: 'none 不使用密钥引用' });
    }
  } else if (adapter === 'bearer') {
    need('token');
    exactRefs(secretRefs, ['token'], path, issues);
    forbid('placement');
    forbid('hmac');
    forbid('oauth');
  } else if (adapter === 'apiKey') {
    need('key');
    exactRefs(secretRefs, ['key'], path, issues);
    auth.placement = readPlacement(obj.placement, `${path}/placement`, issues);
    forbid('hmac');
    forbid('oauth');
  } else if (adapter === 'basic') {
    need('username');
    need('password');
    exactRefs(secretRefs, ['username', 'password'], path, issues);
    forbid('placement');
    forbid('hmac');
    forbid('oauth');
  } else if (adapter === 'hmac-sha256') {
    need('secret');
    exactRefs(secretRefs, ['secret'], path, issues);
    auth.hmac = readHmac(obj.hmac, `${path}/hmac`, issues);
    forbid('placement');
    forbid('oauth');
  } else {
    need('clientId');
    need('clientSecret');
    exactRefs(secretRefs, ['clientId', 'clientSecret'], path, issues);
    auth.oauth = readOAuth(obj.oauth, `${path}/oauth`, issues);
    forbid('placement');
    forbid('hmac');
  }

  if (issues.length > before) return undefined;
  return auth;
}

function exactRefs(
  refs: Record<string, string> | undefined,
  allowed: readonly string[],
  path: string,
  issues: IntegrationIssue[],
): void {
  if (!refs) return;
  for (const key of Object.keys(refs)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}/secretRefs/${key}`, code: 'SECRET_REF', message: `这个鉴权方式没有密钥引用 ${key}` });
    }
  }
}

function readSecretRefs(input: unknown, path: string, issues: IntegrationIssue[]): Record<string, string> | undefined {
  if (input === undefined) return {};
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || !REF_NAME.test(value)) {
      issues.push({
        path: `${path}/${key}`,
        code: 'SECRET_REF',
        message: '密钥引用名只能是短名字，例如 token。密钥本身放在本机密钥库',
      });
      continue;
    }
    refs[key] = value;
  }
  return refs;
}

function readPlacement(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['header', 'prefix'], path, issues);
  if (typeof obj.header !== 'string' || !HEADER.test(obj.header)) {
    issues.push({ path: `${path}/header`, code: 'HEADER', message: 'apiKey 要写放在哪个头' });
    return undefined;
  }
  if (
    obj.prefix !== undefined &&
    (typeof obj.prefix !== 'string' || obj.prefix.length < 1 || obj.prefix.length > 40 || /\n/.test(obj.prefix))
  ) {
    issues.push({ path: `${path}/prefix`, code: 'HEADER', message: '前缀最长 40 个字符' });
    return undefined;
  }
  return { header: obj.header, ...(obj.prefix !== undefined ? { prefix: obj.prefix } : {}) };
}

function readHmac(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['header', 'timestampHeader', 'signedParts'], path, issues);
  if (typeof obj.header !== 'string' || !HEADER.test(obj.header)) {
    issues.push({ path: `${path}/header`, code: 'HEADER', message: '签名要写放在哪个头' });
    return undefined;
  }
  if (obj.timestampHeader !== undefined && (typeof obj.timestampHeader !== 'string' || !HEADER.test(obj.timestampHeader))) {
    issues.push({ path: `${path}/timestampHeader`, code: 'HEADER', message: '时间戳头的名字不合法' });
    return undefined;
  }
  if (!Array.isArray(obj.signedParts) || obj.signedParts.length === 0) {
    issues.push({ path: `${path}/signedParts`, code: 'ENUM', message: 'signedParts 至少包含一段' });
    return undefined;
  }
  const parts: Array<(typeof HMAC_PARTS)[number]> = [];
  for (const part of obj.signedParts) {
    if (typeof part !== 'string' || !(HMAC_PARTS as readonly string[]).includes(part)) {
      issues.push({ path: `${path}/signedParts`, code: 'ENUM', message: 'signedParts 只能是 method、path、timestamp、body' });
      return undefined;
    }
    if (parts.includes(part as (typeof HMAC_PARTS)[number])) {
      issues.push({ path: `${path}/signedParts`, code: 'ENUM', message: `signedParts 重复了 ${part}` });
      return undefined;
    }
    parts.push(part as (typeof HMAC_PARTS)[number]);
  }
  return {
    header: obj.header,
    ...(obj.timestampHeader !== undefined ? { timestampHeader: obj.timestampHeader } : {}),
    signedParts: parts,
  };
}

function readOAuth(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['tokenPath'], path, issues);
  if (typeof obj.tokenPath !== 'string' || !obj.tokenPath.startsWith('/') || obj.tokenPath.includes('..') || /\s/.test(obj.tokenPath)) {
    issues.push({ path: `${path}/tokenPath`, code: 'PATH', message: 'tokenPath 必须是以 / 开头的路径' });
    return undefined;
  }
  return { tokenPath: obj.tokenPath };
}

function readEndpoints(input: unknown, path: string, issues: IntegrationIssue[]): Connector['endpoints'] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path, code: 'TYPE', message: 'endpoints 必须是数组' });
    return undefined;
  }
  const endpoints: Connector['endpoints'] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    const itemPath = `${path}/${index}`;
    const obj = asObject(value, itemPath, issues);
    if (!obj) continue;
    rejectUnknown(obj, ['id', 'method', 'path', 'shape'], itemPath, issues);
    const id = readSlug(obj.id, `${itemPath}/id`, issues);
    const method = readEnum(obj.method, METHODS, `${itemPath}/method`, issues);
    const endpointPath = typeof obj.path === 'string' && isEndpointPath(obj.path) ? obj.path : undefined;
    if (!endpointPath) {
      issues.push({
        path: `${itemPath}/path`,
        code: 'PATH',
        message: '端点路径以 / 开头，占位只允许 {orderNo}、{skuCode}、{partnerCode}',
      });
    }
    if (obj.shape !== 'document') {
      issues.push({ path: `${itemPath}/shape`, code: 'ENUM', message: '第一版报文形状只有 document' });
    }
    if (id && seen.has(id)) issues.push({ path: `${itemPath}/id`, code: 'DUPLICATE', message: `端点 id ${id} 重复` });
    if (id) seen.add(id);
    if (id && method && endpointPath && obj.shape === 'document') {
      endpoints.push({ id, method, path: endpointPath, shape: 'document' });
    }
  }
  return endpoints;
}

function isEndpointPath(value: string): boolean {
  if (!value.startsWith('/') || /\s/.test(value) || value.includes('//')) return false;
  if (value.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  const stripped = value.replace(/\{(orderNo|skuCode|partnerCode)\}/g, 'x');
  return !stripped.includes('{') && !stripped.includes('}');
}

function readRoutes(
  input: unknown,
  path: string,
  connectorDirection: Connector['direction'] | undefined,
  adapter: Connector['auth']['adapter'] | undefined,
  endpoints: Connector['endpoints'] | undefined,
  issues: IntegrationIssue[],
): Connector['routes'] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path, code: 'TYPE', message: 'routes 必须是数组' });
    return undefined;
  }
  const routes: Connector['routes'] = [];
  const seen = new Set<string>();
  const endpointIds = new Set((endpoints ?? []).map((endpoint) => endpoint.id));
  for (const [index, value] of input.entries()) {
    const route = readRoute(value, `${path}/${index}`, connectorDirection, adapter, endpointIds, issues);
    if (!route) continue;
    if (seen.has(route.id)) issues.push({ path: `${path}/${index}/id`, code: 'DUPLICATE', message: `路由 id ${route.id} 重复` });
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
}

function readRoute(
  input: unknown,
  path: string,
  connectorDirection: Connector['direction'] | undefined,
  adapter: Connector['auth']['adapter'] | undefined,
  endpointIds: Set<string>,
  issues: IntegrationIssue[],
): Connector['routes'][number] | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(
    obj,
    ['id', 'enabled', 'direction', 'endpointId', 'inbound', 'outbound', 'canonical', 'idempotency', 'mapping'],
    path,
    issues,
  );
  const id = readSlug(obj.id, `${path}/id`, issues);
  const enabled = readBool(obj.enabled, `${path}/enabled`, issues);
  const direction = readEnum(obj.direction, ['in', 'out'] as const, `${path}/direction`, issues);
  const canonical = typeof obj.canonical === 'string' ? obj.canonical : undefined;
  if (!canonical) issues.push({ path: `${path}/canonical`, code: 'ENUM', message: '缺少 canonical' });

  if (direction && connectorDirection) {
    const allowed =
      connectorDirection === 'both' || (connectorDirection === 'inbound' ? direction === 'in' : direction === 'out');
    if (!allowed) {
      issues.push({
        path: `${path}/direction`,
        code: 'DIRECTION',
        message: `连接器方向是 ${connectorDirection}，路由不能是 ${direction}`,
      });
    }
  }

  const endpointId = obj.endpointId === undefined ? undefined : readSlug(obj.endpointId, `${path}/endpointId`, issues);
  if (typeof obj.endpointId === 'string' && endpointId && !endpointIds.has(endpointId)) {
    issues.push({ path: `${path}/endpointId`, code: 'ENDPOINT', message: `端点 ${endpointId} 不存在` });
  }

  const inbound = obj.inbound === undefined ? undefined : readInbound(obj.inbound, `${path}/inbound`, issues);
  const outbound = obj.outbound === undefined ? undefined : readOutbound(obj.outbound, `${path}/outbound`, issues);
  const externalIdPath = readExternalId(obj.idempotency, `${path}/idempotency`, issues);
  const mapping = readMapping(obj.mapping, `${path}/mapping`, direction, canonical, externalIdPath, issues);

  if (direction === 'in') {
    if (obj.inbound === undefined) issues.push({ path: `${path}/inbound`, code: 'MISSING', message: '入站路由要写 inbound' });
    if (obj.outbound !== undefined) {
      issues.push({ path: `${path}/outbound`, code: 'UNKNOWN_FIELD', message: '入站路由不写出站触发' });
    }
    if (canonical && !isInboundCanonical(canonical)) {
      issues.push({ path: `${path}/canonical`, code: 'CANONICAL', message: `${canonical} 不是入站目标` });
    }
    if (inbound?.mode === 'webhook') {
      if (endpointId) issues.push({ path: `${path}/endpointId`, code: 'ENDPOINT', message: 'webhook 不调用对方端点' });
      if (enabled && adapter === 'none') {
        issues.push({ path: `${path}/inbound/mode`, code: 'AUTH', message: 'webhook 必须校验请求，鉴权不能是 none' });
      }
    }
    if (inbound?.mode === 'poll' && obj.endpointId === undefined) {
      issues.push({ path: `${path}/endpointId`, code: 'ENDPOINT', message: '拉取要指定端点' });
    }
  }
  if (direction === 'out') {
    if (obj.outbound === undefined) issues.push({ path: `${path}/outbound`, code: 'MISSING', message: '出站路由要写出站触发' });
    if (obj.inbound !== undefined) {
      issues.push({ path: `${path}/inbound`, code: 'UNKNOWN_FIELD', message: '出站路由不写入站触发' });
    }
    if (obj.endpointId === undefined) issues.push({ path: `${path}/endpointId`, code: 'ENDPOINT', message: '出站要指定端点' });
    if (canonical && outbound?.event) {
      const expected = OUTBOUND_EVENT_CANONICAL[outbound.event];
      if (canonical !== expected) {
        issues.push({ path: `${path}/canonical`, code: 'CANONICAL', message: `${outbound.event} 对应 ${expected}` });
      }
    }
  }

  if (issues.length > before || !id || enabled === undefined || !direction || !canonical || !externalIdPath || !mapping) {
    return undefined;
  }
  return {
    id,
    enabled,
    direction,
    ...(endpointId ? { endpointId } : {}),
    ...(inbound ? { inbound } : {}),
    ...(outbound ? { outbound } : {}),
    canonical: canonical as Connector['routes'][number]['canonical'],
    idempotency: { externalIdPath },
    mapping,
  };
}

function readInbound(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, ['mode', 'cursor', 'itemsPath'], path, issues);
  const mode = readEnum(obj.mode, ['webhook', 'poll'] as const, `${path}/mode`, issues);
  if (typeof obj.itemsPath !== 'string' || (obj.itemsPath !== '' && !PATH.test(obj.itemsPath))) {
    issues.push({ path: `${path}/itemsPath`, code: 'PATH', message: 'itemsPath 是列表路径，单笔用空串' });
  }
  let cursor: { queryParam: string; from: (typeof CURSOR_FROM)[number] } | undefined;
  if (mode === 'poll') {
    const cursorObj = asObject(obj.cursor, `${path}/cursor`, issues);
    if (cursorObj) {
      rejectUnknown(cursorObj, ['queryParam', 'from'], `${path}/cursor`, issues);
      const from = readEnum(cursorObj.from, CURSOR_FROM, `${path}/cursor/from`, issues);
      if (typeof cursorObj.queryParam !== 'string' || !QUERY_PARAM.test(cursorObj.queryParam)) {
        issues.push({ path: `${path}/cursor/queryParam`, code: 'PATH', message: 'queryParam 必须是查询参数名' });
      } else if (from) {
        cursor = { queryParam: cursorObj.queryParam, from };
      }
    }
  } else if (obj.cursor !== undefined) {
    issues.push({ path: `${path}/cursor`, code: 'UNKNOWN_FIELD', message: 'webhook 没有拉取水位' });
  }
  if (issues.length > before || !mode || typeof obj.itemsPath !== 'string') return undefined;
  return { mode, itemsPath: obj.itemsPath, ...(cursor ? { cursor } : {}) };
}

function readOutbound(input: unknown, path: string, issues: IntegrationIssue[]) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, ['event', 'when', 'requireLink'], path, issues);
  const event = readEnum(
    obj.event,
    Object.keys(OUTBOUND_EVENT_CANONICAL) as Array<keyof typeof OUTBOUND_EVENT_CANONICAL>,
    `${path}/event`,
    issues,
  );
  const requireLink = readBool(obj.requireLink, `${path}/requireLink`, issues);
  let when: { path: string; eq: string } | undefined;
  if (obj.when !== undefined) {
    const whenObj = asObject(obj.when, `${path}/when`, issues);
    if (whenObj) {
      rejectUnknown(whenObj, ['path', 'eq'], `${path}/when`, issues);
      if (typeof whenObj.path !== 'string' || !PATH.test(whenObj.path)) {
        issues.push({ path: `${path}/when/path`, code: 'PATH', message: 'when.path 必须是快照上的字段' });
      } else if (event) {
        const top = SNAPSHOT_TOP[OUTBOUND_EVENT_CANONICAL[event]];
        if (!top.includes(whenObj.path)) {
          issues.push({ path: `${path}/when/path`, code: 'ALLOWLIST', message: `${whenObj.path} 不在这份快照上` });
        }
      }
      if (typeof whenObj.eq !== 'string' || whenObj.eq === '') {
        issues.push({ path: `${path}/when/eq`, code: 'TYPE', message: 'when.eq 必须是非空字符串' });
      }
      if (typeof whenObj.path === 'string' && typeof whenObj.eq === 'string' && whenObj.eq !== '') {
        when = { path: whenObj.path, eq: whenObj.eq };
      }
    }
  }
  if (issues.length > before || !event || requireLink === undefined) return undefined;
  return { event, requireLink, ...(when ? { when } : {}) };
}

function readExternalId(input: unknown, path: string, issues: IntegrationIssue[]): string | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['externalIdPath'], path, issues);
  if (typeof obj.externalIdPath !== 'string' || !PATH.test(obj.externalIdPath)) {
    issues.push({ path: `${path}/externalIdPath`, code: 'PATH', message: 'externalIdPath 必须是点路径' });
    return undefined;
  }
  return obj.externalIdPath;
}

function readMapping(
  input: unknown,
  path: string,
  direction: 'in' | 'out' | undefined,
  canonical: string | undefined,
  externalIdPath: string | undefined,
  issues: IntegrationIssue[],
) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, ['fields', 'lines'], path, issues);
  if (!Array.isArray(obj.fields)) {
    issues.push({ path: `${path}/fields`, code: 'TYPE', message: 'fields 必须是数组' });
    return undefined;
  }

  const fields: FieldMap[] = [];
  const seen = new Set<string>();
  for (const [index, value] of obj.fields.entries()) {
    const field = readField(value, `${path}/fields/${index}`, direction, canonical, false, issues);
    if (!field) continue;
    if (seen.has(field.to)) {
      issues.push({ path: `${path}/fields/${index}/to`, code: 'DUPLICATE', message: `字段 ${field.to} 映射了两次` });
    }
    seen.add(field.to);
    fields.push(field);
  }

  let lines: Connector['routes'][number]['mapping']['lines'];
  if (obj.lines !== undefined) {
    lines = readLines(obj.lines, `${path}/lines`, direction, canonical, issues);
  }

  if (direction === 'in' && canonical && isInboundCanonical(canonical)) {
    checkInboundMapping(canonical, fields, lines, externalIdPath, path, issues);
  }
  if (direction === 'out' && canonical && externalIdPath) {
    const snapshot = SNAPSHOT_TOP[canonical as keyof typeof SNAPSHOT_TOP];
    if (snapshot && !snapshot.includes(externalIdPath)) {
      issues.push({
        path: path.replace(/\/mapping$/, '/idempotency/externalIdPath'),
        code: 'ALLOWLIST',
        message: `出站幂等路径 ${externalIdPath} 不在快照上`,
      });
    }
  }

  if (fields.length === 0 && !lines) {
    issues.push({ path, code: 'MISSING', message: '映射至少要有一个字段或一组明细' });
  }
  if (issues.length > before) return undefined;
  return { fields, ...(lines ? { lines } : {}) };
}

function checkInboundMapping(
  canonical: InboundCanonical,
  fields: FieldMap[],
  lines: Connector['routes'][number]['mapping']['lines'],
  externalIdPath: string | undefined,
  path: string,
  issues: IntegrationIssue[],
): void {
  const shape = INBOUND_SHAPE[canonical];
  for (const name of shape.required) {
    if (!fields.some((field) => field.to === name)) {
      issues.push({ path: `${path}/fields`, code: 'REQUIRED', message: `${canonical} 必须映射 ${name}` });
    }
  }
  const natural = NATURAL_KEY[canonical];
  const keyField = fields.find((field) => field.to === natural);
  if (keyField && externalIdPath && (keyField.from.op !== 'path' || keyField.from.path !== externalIdPath)) {
    issues.push({
      path: `${path}/fields`,
      code: 'IDEMPOTENCY',
      message: `${natural} 必须用 path 读取 ${externalIdPath}，这样重试才是同一张单`,
    });
  }
  if (shape.lines && !lines) {
    issues.push({ path: `${path}/lines`, code: 'REQUIRED', message: '建单必须映射明细' });
  }
  if (!shape.lines && lines) {
    issues.push({ path: `${path}/lines`, code: 'ALLOWLIST', message: `${canonical} 没有明细` });
  }
  if (shape.lineRequired && lines) {
    for (const name of shape.lineRequired) {
      if (!lines.item.some((field) => field.to === name)) {
        issues.push({ path: `${path}/lines/item`, code: 'REQUIRED', message: `明细必须映射 ${name}` });
      }
    }
  }
}

function readLines(
  input: unknown,
  path: string,
  direction: 'in' | 'out' | undefined,
  canonical: string | undefined,
  issues: IntegrationIssue[],
) {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  rejectUnknown(obj, ['to', 'from', 'item'], path, issues);
  const to = typeof obj.to === 'string' && PATH.test(obj.to) ? obj.to : undefined;
  const from = typeof obj.from === 'string' && PATH.test(obj.from) ? obj.from : undefined;
  if (!to) issues.push({ path: `${path}/to`, code: 'PATH', message: '明细目标路径不合法' });
  if (!from) issues.push({ path: `${path}/from`, code: 'PATH', message: '明细来源路径不合法' });

  if (direction === 'in' && canonical === 'order.create' && to && to !== 'lines') {
    issues.push({ path: `${path}/to`, code: 'ALLOWLIST', message: '入站明细只能写到 lines' });
  }
  if (direction === 'out') {
    const lineAllow = canonical ? SNAPSHOT_LINE[canonical as keyof typeof SNAPSHOT_LINE] : undefined;
    if (!lineAllow) issues.push({ path, code: 'ALLOWLIST', message: '这份快照没有明细' });
    if (from && from !== 'lines') issues.push({ path: `${path}/from`, code: 'ALLOWLIST', message: '出站明细只能读快照的 lines' });
  }

  if (!Array.isArray(obj.item) || obj.item.length === 0) {
    issues.push({ path: `${path}/item`, code: 'TYPE', message: '明细映射不能为空' });
    return undefined;
  }
  const item: FieldMap[] = [];
  const seen = new Set<string>();
  for (const [index, value] of obj.item.entries()) {
    const field = readField(value, `${path}/item/${index}`, direction, canonical, true, issues);
    if (!field) continue;
    if (seen.has(field.to)) {
      issues.push({ path: `${path}/item/${index}/to`, code: 'DUPLICATE', message: `明细字段 ${field.to} 映射了两次` });
    }
    seen.add(field.to);
    item.push(field);
  }
  if (issues.length > before || !to || !from) return undefined;
  return { to, from, item };
}

function readField(
  input: unknown,
  path: string,
  direction: 'in' | 'out' | undefined,
  canonical: string | undefined,
  inLine: boolean,
  issues: IntegrationIssue[],
): FieldMap | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['to', 'from'], path, issues);
  if (typeof obj.to !== 'string' || !PATH.test(obj.to)) {
    issues.push({ path: `${path}/to`, code: 'PATH', message: '目标路径不合法' });
    return undefined;
  }
  const source = readSource(obj.from, `${path}/from`, issues);
  if (!source) return undefined;

  if (direction === 'in' && canonical && isInboundCanonical(canonical)) {
    const shape = INBOUND_SHAPE[canonical];
    const rules = inLine ? shape.lineFields : shape.fields;
    const rule = rules?.[obj.to];
    if (!rule) {
      issues.push({ path: `${path}/to`, code: 'ALLOWLIST', message: `${canonical} 不能写入 ${obj.to}` });
    } else if (!rule.ops.includes(source.op)) {
      issues.push({ path: `${path}/from/op`, code: 'OP', message: `${obj.to} 不能用 ${source.op}` });
    } else if (
      source.op === 'const' &&
      rule.constValues &&
      (typeof source.value !== 'string' || !rule.constValues.includes(source.value))
    ) {
      issues.push({ path: `${path}/from/value`, code: 'ENUM', message: `${obj.to} 只能是 ${rule.constValues.join('、')}` });
    } else if (
      source.op === 'const' &&
      rule.constPattern &&
      (typeof source.value !== 'string' || !rule.constPattern.test(source.value))
    ) {
      issues.push({ path: `${path}/from/value`, code: 'FORMAT', message: `${obj.to} 的常量格式不对` });
    } else if (source.op === 'const' && !rule.constValues && !rule.constPattern && typeof source.value !== 'string') {
      issues.push({ path: `${path}/from/value`, code: 'TYPE', message: `${obj.to} 的常量必须是字符串` });
    } else if (source.op === 'const' && typeof source.value === 'string' && source.value.trim() === '') {
      issues.push({ path: `${path}/from/value`, code: 'TYPE', message: `${obj.to} 的常量不能是空串` });
    } else if (source.op === 'date' && rule.dateTo && source.to !== rule.dateTo) {
      issues.push({ path: `${path}/from/to`, code: 'FORMAT', message: `${obj.to} 的日期要写成 ${rule.dateTo}` });
    }
  }

  if (direction === 'out' && canonical) {
    const allowed = inLine
      ? SNAPSHOT_LINE[canonical as keyof typeof SNAPSHOT_LINE]
      : SNAPSHOT_TOP[canonical as keyof typeof SNAPSHOT_TOP];
    for (const sourcePath of sourcePaths(source)) {
      if (allowed && !allowed.includes(sourcePath)) {
        issues.push({ path: `${path}/from`, code: 'ALLOWLIST', message: `快照上没有 ${sourcePath}` });
      }
    }
  }

  return { to: obj.to, from: source };
}

function sourcePaths(source: ValueSource): string[] {
  if (source.op === 'const') return [];
  if (source.op === 'template') return templatePaths(source.template);
  return [source.path];
}

function templatePaths(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const inner = match[1] ?? '';
    if (PATH.test(inner)) found.push(inner);
  }
  return found;
}

function readSource(input: unknown, path: string, issues: IntegrationIssue[]): ValueSource | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const op = obj.op;
  if (op === 'path' || op === 'number') {
    rejectUnknown(obj, ['op', 'path'], path, issues);
    if (typeof obj.path !== 'string' || !PATH.test(obj.path)) {
      issues.push({ path: `${path}/path`, code: 'PATH', message: '来源路径不合法' });
      return undefined;
    }
    return op === 'path' ? { op, path: obj.path } : { op, path: obj.path };
  }
  if (op === 'const') {
    rejectUnknown(obj, ['op', 'value'], path, issues);
    const value = obj.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
      issues.push({ path: `${path}/value`, code: 'TYPE', message: '常量只能是字符串、数字、布尔或 null' });
      return undefined;
    }
    return { op, value };
  }
  if (op === 'enum') {
    rejectUnknown(obj, ['op', 'path', 'map', 'fallback'], path, issues);
    if (typeof obj.path !== 'string' || !PATH.test(obj.path)) {
      issues.push({ path: `${path}/path`, code: 'PATH', message: '来源路径不合法' });
      return undefined;
    }
    if (obj.fallback !== 'reject') {
      issues.push({ path: `${path}/fallback`, code: 'ENUM', message: '对不上的枚举只能拒绝，不能静默丢掉' });
      return undefined;
    }
    const map = readEnumMap(obj.map, `${path}/map`, issues);
    if (!map) return undefined;
    return { op, path: obj.path, map, fallback: 'reject' };
  }
  if (op === 'date') {
    rejectUnknown(obj, ['op', 'path', 'from', 'to'], path, issues);
    if (typeof obj.path !== 'string' || !PATH.test(obj.path)) {
      issues.push({ path: `${path}/path`, code: 'PATH', message: '来源路径不合法' });
      return undefined;
    }
    const from = readEnum(obj.from, DATE_FORMS, `${path}/from`, issues);
    const to = readEnum(obj.to, DATE_FORMS, `${path}/to`, issues);
    if (!from || !to) return undefined;
    return { op, path: obj.path, from, to };
  }
  if (op === 'code') {
    rejectUnknown(obj, ['op', 'entity', 'path'], path, issues);
    if (typeof obj.path !== 'string' || !PATH.test(obj.path)) {
      issues.push({ path: `${path}/path`, code: 'PATH', message: '来源路径不合法' });
      return undefined;
    }
    const entity = readEnum(obj.entity, CODE_ENTITIES, `${path}/entity`, issues);
    if (!entity) return undefined;
    return { op, entity, path: obj.path };
  }
  if (op === 'template') {
    rejectUnknown(obj, ['op', 'template'], path, issues);
    if (typeof obj.template !== 'string' || obj.template === '') {
      issues.push({ path: `${path}/template`, code: 'TEMPLATE', message: '模板不能为空' });
      return undefined;
    }
    if (!isTemplate(obj.template)) {
      issues.push({ path: `${path}/template`, code: 'TEMPLATE', message: '模板只替换 {路径}，不能写表达式' });
      return undefined;
    }
    return { op, template: obj.template };
  }
  issues.push({ path: `${path}/op`, code: 'OP', message: '算子必须是 path、const、number、enum、date、code、template' });
  return undefined;
}

function isTemplate(template: string): boolean {
  const stripped = template.replace(/\{([^{}]+)\}/g, (_all, inner: string) => (PATH.test(inner) ? '' : '{'));
  return !stripped.includes('{') && !stripped.includes('}');
}

function readEnumMap(input: unknown, path: string, issues: IntegrationIssue[]): Record<string, string> | undefined {
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    issues.push({ path, code: 'ENUM', message: '枚举对照不能为空' });
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key === '' || typeof value !== 'string' || value === '') {
      issues.push({ path, code: 'ENUM', message: '枚举的两边都必须是非空字符串' });
      return undefined;
    }
    map[key] = value;
  }
  return map;
}

function readWriters(input: unknown, path: string, issues: IntegrationIssue[]): IntegrationSettings['writers'] | undefined {
  if (input === undefined) return { order: null, sku: null, partner: null };
  const obj = asObject(input, path, issues);
  if (!obj) return undefined;
  rejectUnknown(obj, ['order', 'sku', 'partner'], path, issues);
  const read = (key: 'order' | 'sku' | 'partner'): string | null | undefined => {
    if (obj[key] === undefined || obj[key] === null) return null;
    if (typeof obj[key] !== 'string' || !SLUG.test(obj[key])) {
      issues.push({ path: `${path}/${key}`, code: 'SLUG', message: `writers.${key} 必须是连接器 id 或 null` });
      return undefined;
    }
    return obj[key];
  };
  const order = read('order');
  const sku = read('sku');
  const partner = read('partner');
  if (order === undefined || sku === undefined || partner === undefined) return undefined;
  return { order, sku, partner };
}

function readInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  base: string,
  issues: IntegrationIssue[],
): number | undefined {
  if (!Object.hasOwn(obj, key)) return fallback;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push({ path: `${base}/${key}`, code: 'RANGE', message: `${key} 必须是 ${min} 到 ${max} 的整数` });
    return undefined;
  }
  return value;
}

function readSlug(input: unknown, path: string, issues: IntegrationIssue[]): string | undefined {
  if (typeof input !== 'string' || !SLUG.test(input)) {
    issues.push({ path, code: 'SLUG', message: 'id 只能是小写字母、数字和短横线' });
    return undefined;
  }
  return input;
}

function readName(input: unknown, path: string, issues: IntegrationIssue[]): string | undefined {
  if (typeof input !== 'string' || input.trim() === '' || input.length > 80) {
    issues.push({ path, code: 'NAME', message: '名称不能为空，最长 80 个字符' });
    return undefined;
  }
  return input;
}

function readBool(input: unknown, path: string, issues: IntegrationIssue[]): boolean | undefined {
  if (typeof input !== 'boolean') {
    issues.push({ path, code: 'TYPE', message: '必须是布尔值' });
    return undefined;
  }
  return input;
}

function readEnum<T extends string>(
  input: unknown,
  allowed: readonly T[],
  path: string,
  issues: IntegrationIssue[],
): T | undefined {
  if (typeof input !== 'string' || !allowed.includes(input as T)) {
    issues.push({ path, code: 'ENUM', message: `只能是 ${allowed.join('、')}` });
    return undefined;
  }
  return input as T;
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  base: string,
  issues: IntegrationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${base}/${key}`.replace('//', '/'), code: 'UNKNOWN_FIELD', message: `不能有字段 ${key}` });
    }
  }
}

function asObject(input: unknown, path: string, issues: IntegrationIssue[]): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) {
    issues.push({ path: path || '/', code: 'TYPE', message: '必须是对象' });
    return undefined;
  }
  return input;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
