/**
 * Webhook 收单、入站拉取和出站推送。
 * 入站映射成功后走工具总线，接受的收件才记下内部单号。
 * 拉取和 webhook 共用同一条接单路径。水位记在 integration_poll，不占用出站账本水位。
 * 出站先按连接器水位扫账本、映射后入队，再按队列发送。映射失败停在那条事件，下一轮再试。
 */

import { CoreError, type EventEnvelope, type ProfileSnapshot } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { checkInboundAuth, outboundAuthHeaders, type SecretReader } from './auth.js';
import { NATURAL_KEY, OUTBOUND_EVENT_CANONICAL, canonicalFamily, isInboundCanonical } from './allowlist.js';
import { applyMapping, outboundMatches } from './map.js';
import type { IntegrationQueue } from './queue.js';
import { buildOutboundSnapshot } from './snapshot.js';
import type {
  CodeLookup,
  Connector,
  CursorFrom,
  HttpMethod,
  IntegrationSettings,
  OutboundCanonical,
  Route,
} from './types.js';
import { validateIntegrationSettings } from './validate.js';

export const INTEGRATION_MODULE_ID = 'module.integration';

const BODY_MAX = 256 * 1024;
const PLACEHOLDERS = ['orderNo', 'skuCode', 'partnerCode'] as const;

export const emptyCodeLookup: CodeLookup = {
  resolve() {
    return undefined;
  },
};

/** 一个对照表给全部连接器共用，或按连接器各查各的。测试注入整张表，实跑按连接器查投影。 */
export type CodeLookupSource = CodeLookup | ((connectorId: string) => CodeLookup);

function codesFor(source: CodeLookupSource, connectorId: string): CodeLookup {
  return typeof source === 'function' ? source(connectorId) : source;
}

export interface ReceiveBody {
  ok: boolean;
  internalRef?: string;
  duplicate?: boolean;
  code?: string;
  message?: string;
  path?: string;
}

export interface ReceiveResult {
  status: 200 | 401 | 404 | 409 | 422 | 500;
  body: ReceiveBody;
}

export interface DeliverySkip {
  connectorId: string;
  routeId: string;
  eventId: string;
  code: string;
  message: string;
}

export interface CatchUpResult {
  enqueued: number;
  skipped: DeliverySkip[];
}

export interface PushResult {
  sent: number;
  failed: number;
  skipped: number;
}

export interface PollResult {
  fetched: number;
  accepted: number;
  failed: number;
}

export interface IntegrationRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface IntegrationResponse {
  status: number;
  body: string;
  /** 正文超过上限。调用方当失败，不要解析被截掉的半截。 */
  truncated?: boolean;
}

export type IntegrationFetch = (request: IntegrationRequest) => Promise<IntegrationResponse>;

export type SettingsLoad =
  | { ok: true; settings: IntegrationSettings }
  | { ok: false; status: 404 | 422; code: string; message: string };

/** 从 Profile 的 module.integration 读对接配置。停用和没装都当没有入口。 */
export function loadIntegrationSettings(modules: ProfileSnapshot['modules']): SettingsLoad {
  const installed = modules[INTEGRATION_MODULE_ID];
  if (!installed || installed.enabled !== true) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: '没有这条对接入口' };
  }
  const parsed = validateIntegrationSettings(installed.settings ?? {});
  if (!parsed.ok) {
    const first = parsed.issues[0];
    return { ok: false, status: 422, code: 'CONFIG', message: first?.message ?? '对接配置不合法' };
  }
  return { ok: true, settings: parsed.settings };
}

export async function receiveWebhook(input: {
  settings: IntegrationSettings;
  connectorId: string;
  routeId: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  secrets: SecretReader;
  queue: IntegrationQueue;
  codes: CodeLookupSource;
  invoke: (toolId: string, params: Record<string, unknown>) => Promise<unknown>;
  now?: string;
}): Promise<ReceiveResult> {
  const found = findWebhook(input.settings, input.connectorId, input.routeId);
  if (!found) return done(404, { ok: false, code: 'NOT_FOUND', message: '没有这条对接入口' });
  const { connector, route } = found;

  const auth = checkInboundAuth(connector, input.headers, input.secrets);
  if (!auth.ok) return done(401, { ok: false, code: 'AUTH', message: auth.message });

  const document = readDocument(input.body, route.inbound?.itemsPath ?? '');
  if (!document.ok) return done(422, { ok: false, code: 'MAP_SOURCE', message: document.message });
  if (jsonSize(input.body) > BODY_MAX) return done(422, { ok: false, code: 'MAP_SOURCE', message: '报文过大' });

  return acceptInboundDocument({
    connector,
    route,
    document: document.value,
    raw: input.body,
    queue: input.queue,
    codes: codesFor(input.codes, input.connectorId),
    invoke: input.invoke,
    now: input.now,
  });
}

export function catchUpOutbound(input: {
  ws: WmsWorkspace;
  settings: IntegrationSettings;
  queue: IntegrationQueue;
  codes: CodeLookupSource;
  now?: string;
}): CatchUpResult {
  input.ws.sync();
  let enqueued = 0;
  const skipped: DeliverySkip[] = [];
  for (const connector of Object.values(input.settings.connectors)) {
    if (!connector.enabled) continue;
    const routes = connector.routes.filter((route) => route.enabled && route.direction === 'out' && route.outbound);
    if (routes.length === 0) continue;
    const codes = codesFor(input.codes, connector.id);
    const start = input.queue.cursor(connector.id);
    let advanced = start;
    let stalled = false;
    input.ws.events.forEach((env) => {
      if (stalled) return false;
      const interested = routes.filter((route) => route.outbound?.event === env.type);
      if (interested.length === 0) {
        advanced = env.lamport;
        return;
      }
      const expected = isOutboundEvent(env.type) ? OUTBOUND_EVENT_CANONICAL[env.type] : undefined;
      const built = buildOutboundSnapshot(input.ws, env, connector.id, input.queue);
      if (!built.ok) {
        if (built.retry) {
          stalled = true;
          skipped.push({
            connectorId: connector.id,
            routeId: interested[0]?.id ?? connector.id,
            eventId: env.eventId,
            code: 'SNAPSHOT',
            message: built.message,
          });
          advanced = Math.min(advanced, env.lamport - 1);
          return false;
        }
        advanced = env.lamport;
        return;
      }
      for (const route of interested) {
        if (!expected || route.canonical !== expected) continue;
        const ref = linkRef(route.canonical as OutboundCanonical, built.value);
        const linked = ref ? input.queue.hasLink(connector.id, ref) : false;
        if (!outboundMatches(route, built.value, { hasLink: linked })) continue;
        const mapped = applyMapping(route, built.value, codes);
        if (!mapped.ok) {
          stalled = true;
          skipped.push({
            connectorId: connector.id,
            routeId: route.id,
            eventId: env.eventId,
            code: mapped.code,
            message: mapped.message,
          });
          continue;
        }
        const row = input.queue.enqueue({
          connectorId: connector.id,
          routeId: route.id,
          eventId: env.eventId,
          body: mapped.value,
          now: input.now,
        });
        if (row.created) enqueued += 1;
      }
      if (stalled) {
        // 同一 lamport 上的前一条已经处理过。水位停在这一档之前，下一轮整档重放，入队是幂等的。
        advanced = Math.min(advanced, env.lamport - 1);
        return false;
      }
      advanced = env.lamport;
    }, { fromLamport: start });
    if (advanced >= 0 && advanced !== start) input.queue.advanceCursor(connector.id, advanced);
  }
  return { enqueued, skipped };
}

export async function pushDue(input: {
  ws: WmsWorkspace;
  settings: IntegrationSettings;
  queue: IntegrationQueue;
  secrets: SecretReader;
  fetchImpl?: IntegrationFetch;
  now?: string;
  limit?: number;
}): Promise<PushResult> {
  const fetchImpl = input.fetchImpl ?? httpFetch;
  const now = input.now;
  const due = input.queue.due(now ?? new Date().toISOString(), input.limit ?? 20);
  const result: PushResult = { sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const connector = input.settings.connectors[row.connectorId];
    const route = connector?.routes.find((item) => item.id === row.routeId);
    if (!connector?.enabled || !route?.enabled || route.direction !== 'out') {
      result.skipped += 1;
      continue;
    }
    const endpoint = connector.endpoints.find((item) => item.id === route.endpointId);
    if (!endpoint) {
      input.queue.markFailed(row.id, '端点不在配置里', { maxAttempts: input.settings.maxAttempts, now });
      result.failed += 1;
      continue;
    }
    const auth = outboundAuthHeaders(connector, input.secrets);
    if (!auth.ok) {
      input.queue.markFailed(row.id, auth.message, { maxAttempts: input.settings.maxAttempts, now });
      result.failed += 1;
      continue;
    }
    const path = await resolvePath(input.ws, input.queue, connector, endpoint.path, row.eventId);
    if (!path.ok) {
      input.queue.markFailed(row.id, path.message, { maxAttempts: input.settings.maxAttempts, now });
      result.failed += 1;
      continue;
    }
    const request: IntegrationRequest = {
      url: joinUrl(connector.transport.baseUrl, path.value),
      method: endpoint.method,
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify(row.body),
      timeoutMs: input.settings.timeoutMs,
    };
    try {
      const response = await fetchImpl(request);
      if (response.status >= 200 && response.status < 300) {
        input.queue.markSent(row.id, now);
        result.sent += 1;
      } else {
        input.queue.markFailed(row.id, `对方返回 ${response.status}`, { maxAttempts: input.settings.maxAttempts, now });
        result.failed += 1;
      }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      input.queue.markFailed(row.id, timedOut ? '请求超时' : '请求没有送出', {
        maxAttempts: input.settings.maxAttempts,
        now,
      });
      result.failed += 1;
    }
  }
  return result;
}

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

/**
 * 按间隔拉取入站。一页一条路由，没有分页配置。
 * 时钟水位用这次请求开始的时间：请求途中写入的单据下一轮还能再见到，重复的靠收件去重。
 * watermark 模式没有响应路径，整页成功才记下最后一笔外部主键；一笔都没有就先不带这个参数。
 * 这一页有一笔没接住，水位不动。已经接住的下一轮变成重复。失败也记下尝试时间。
 */
export async function pollInbound(input: {
  settings: IntegrationSettings;
  queue: IntegrationQueue;
  secrets: SecretReader;
  codes: CodeLookupSource;
  invoke: (connectorId: string, toolId: string, params: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: IntegrationFetch;
  now?: string;
}): Promise<PollResult> {
  const fetchImpl = input.fetchImpl ?? httpFetch;
  const at = instant(input.now);
  const atMs = Date.parse(at);
  const result: PollResult = { fetched: 0, accepted: 0, failed: 0 };

  for (const connector of Object.values(input.settings.connectors)) {
    const codes = codesFor(input.codes, connector.id);
    for (const route of connector.routes) {
      if (!pollRouteReady(input.settings, connector, route)) continue;
      const cursor = route.inbound?.cursor;
      if (!cursor) continue;
      const state = input.queue.pollWatermark(connector.id, route.id);
      if (state && atMs - Date.parse(state.lastAttemptAt) < input.settings.pollIntervalSec * 1000) continue;

      const endpoint = connector.endpoints.find((item) => item.id === route.endpointId);
      const auth = outboundAuthHeaders(connector, input.secrets);
      const path = endpoint?.path ?? '';
      if (!endpoint || !auth.ok || PLACEHOLDERS.some((key) => path.includes(`{${key}}`))) {
        input.queue.recordPoll(connector.id, route.id, at);
        result.failed += 1;
        continue;
      }

      const query = cursorQuery(cursor.from, state?.watermark ?? null);
      const request: IntegrationRequest = {
        url: joinUrl(connector.transport.baseUrl, withQuery(endpoint.path, cursor.queryParam, query)),
        method: endpoint.method,
        headers: { accept: 'application/json', ...auth.headers },
        body: '',
        timeoutMs: input.settings.timeoutMs,
      };
      result.fetched += 1;
      let response: IntegrationResponse;
      try {
        response = await fetchImpl(request);
      } catch {
        input.queue.recordPoll(connector.id, route.id, at);
        result.failed += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300 || response.truncated || response.body.length > BODY_MAX) {
        input.queue.recordPoll(connector.id, route.id, at);
        result.failed += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body) as unknown;
      } catch {
        input.queue.recordPoll(connector.id, route.id, at);
        result.failed += 1;
        continue;
      }
      const items = readItems(parsed, route.inbound?.itemsPath ?? '');
      if (!items.ok) {
        input.queue.recordPoll(connector.id, route.id, at);
        result.failed += 1;
        continue;
      }

      let pageOk = true;
      for (const item of items.items) {
        if (!isPlainObject(item)) {
          pageOk = false;
          result.failed += 1;
          continue;
        }
        const accepted = await acceptInboundDocument({
          connector,
          route,
          document: item,
          raw: item,
          queue: input.queue,
          codes,
          invoke: (toolId, params) => input.invoke(connector.id, toolId, params),
          now: at,
        });
        if (accepted.status === 200 && accepted.body.duplicate !== true) result.accepted += 1;
        if (accepted.status !== 200) {
          pageOk = false;
          result.failed += 1;
        }
      }
      if (!pageOk) {
        input.queue.recordPoll(connector.id, route.id, at);
        continue;
      }
      const mark = nextWatermark(cursor.from, at, items.items, route.idempotency.externalIdPath);
      if (mark === undefined) input.queue.recordPoll(connector.id, route.id, at);
      else input.queue.recordPoll(connector.id, route.id, at, mark);
    }
  }
  return result;
}

/** 真实 HTTP。测试注入 fetchImpl，不走这里。出站不读正文。拉取正文超过上限就标截断。 */
export async function httpFetch(request: IntegrationRequest): Promise<IntegrationResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' ? undefined : request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const text = await response.text();
  if (text.length > BODY_MAX) return { status: response.status, body: '', truncated: true };
  return { status: response.status, body: text };
}

async function acceptInboundDocument(input: {
  connector: Connector;
  route: Route;
  document: Record<string, unknown>;
  raw: unknown;
  queue: IntegrationQueue;
  codes: CodeLookup;
  invoke: (toolId: string, params: Record<string, unknown>) => Promise<unknown>;
  now?: string;
}): Promise<ReceiveResult> {
  const external = externalIdOf(input.document, input.route.idempotency.externalIdPath);
  if (!external.ok) return done(422, { ok: false, code: 'IDEMPOTENCY', message: external.message });

  const existing = input.queue.acceptedRef(input.connector.id, input.route.id, external.id);
  if (existing) return done(200, { ok: true, internalRef: existing, duplicate: true });

  if (!isInboundCanonical(input.route.canonical)) {
    return done(422, { ok: false, code: 'CANONICAL', message: '这条路由不是入站目标' });
  }
  const mapped = applyMapping(input.route, input.document, input.codes);
  if (!mapped.ok) {
    try {
      input.queue.recordInbox({
        connectorId: input.connector.id,
        routeId: input.route.id,
        externalId: external.id,
        raw: input.raw,
        outcome: 'rejected',
        error: mapped.message,
        now: input.now,
      });
    } catch {
      // 拒绝记录没写上也不改判定：这笔没有进业务账。
    }
    return done(422, { ok: false, code: mapped.code, message: mapped.message, ...(mapped.path ? { path: mapped.path } : {}) });
  }

  const internalRef = readInternalRef(input.route.canonical, mapped.value);
  if (!internalRef) return done(422, { ok: false, code: 'MAP_MISSING', message: '映射结果没有内部单号' });

  const toolId = TOOL_OF[input.route.canonical];
  try {
    await input.invoke(toolId, mapped.value);
  } catch (err) {
    const rejected = rejectionOf(err);
    if (rejected) return done(409, { ok: false, code: rejected.code, message: rejected.message });
    return done(500, { ok: false, code: 'INTERNAL', message: '接收没有完成' });
  }

  try {
    const recorded = input.queue.recordInbox({
      connectorId: input.connector.id,
      routeId: input.route.id,
      externalId: external.id,
      raw: input.raw,
      outcome: 'accepted',
      internalRef,
      now: input.now,
    });
    if (recorded.disposition === 'duplicate') {
      return done(200, { ok: true, internalRef: recorded.internalRef, duplicate: true });
    }
    if (recorded.disposition === 'accepted') {
      return done(200, { ok: true, internalRef: recorded.internalRef });
    }
    return done(500, { ok: false, code: 'INTERNAL', message: '接收没有完成' });
  } catch {
    return done(500, { ok: false, code: 'INTERNAL', message: '接收没有完成' });
  }
}

const TOOL_OF = {
  'order.create': 'wms.order.create',
  'order.transition': 'wms.order.transition',
  'sku.create': 'wms.sku.create',
  'sku.update': 'wms.sku.update',
  'partner.create': 'wms.partner.create',
  'partner.update': 'wms.partner.update',
} as const;

function findWebhook(settings: IntegrationSettings, connectorId: string, routeId: string): { connector: Connector; route: Route } | undefined {
  const connector = settings.connectors[connectorId];
  if (!connector?.enabled || connector.id !== connectorId) return undefined;
  const route = connector.routes.find((item) => item.id === routeId);
  if (!route?.enabled || route.direction !== 'in' || route.inbound?.mode !== 'webhook') return undefined;
  if (!isInboundCanonical(route.canonical)) return undefined;
  const family = canonicalFamily(route.canonical);
  if (family !== 'order' && family !== 'sku' && family !== 'partner') return undefined;
  if (settings.writers[family] !== connector.id) return undefined;
  return { connector, route };
}

function pollRouteReady(settings: IntegrationSettings, connector: Connector, route: Route): boolean {
  if (!connector.enabled || !route.enabled) return false;
  if (route.direction !== 'in' || route.inbound?.mode !== 'poll' || !route.inbound.cursor) return false;
  if (!isInboundCanonical(route.canonical)) return false;
  const family = canonicalFamily(route.canonical);
  if (family !== 'order' && family !== 'sku' && family !== 'partner') return false;
  return settings.writers[family] === connector.id;
}

/** 第一次时钟水位从纪元拉全量。watermark 模式在还没有主键时不带参数。 */
function cursorQuery(from: CursorFrom, stored: string | null): string | undefined {
  if (from === 'iso8601') return stored ?? EPOCH_ISO;
  if (from === 'unixMs') return stored ?? '0';
  return stored ?? undefined;
}

function nextWatermark(from: CursorFrom, at: string, items: unknown[], externalIdPath: string): string | undefined {
  if (from === 'iso8601') return at;
  if (from === 'unixMs') return String(Date.parse(at));
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  if (!isPlainObject(last)) return undefined;
  const external = externalIdOf(last, externalIdPath);
  return external.ok ? external.id : undefined;
}

function withQuery(path: string, key: string, value: string | undefined): string {
  if (value === undefined) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function readItems(body: unknown, itemsPath: string): { ok: true; items: unknown[] } | { ok: false; message: string } {
  if (itemsPath === '') {
    if (!isPlainObject(body)) return { ok: false, message: '拉取结果不是一笔对象' };
    return { ok: true, items: [body] };
  }
  const read = readPath(body, itemsPath);
  if (!read.ok) return { ok: false, message: read.message };
  if (!read.found || !Array.isArray(read.value)) return { ok: false, message: '拉取结果不是列表' };
  return { ok: true, items: read.value };
}

function instant(now: string | undefined): string {
  const parsed = Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(parsed)) throw new Error('时间不合法');
  return new Date(parsed).toISOString();
}

function readDocument(body: unknown, itemsPath: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const read = itemsPath === '' ? { ok: true as const, found: true, value: body } : readPath(body, itemsPath);
  if (!read.ok) return { ok: false, message: read.message };
  if (!read.found) return { ok: false, message: '报文里没有这一笔' };
  if (Array.isArray(read.value)) return { ok: false, message: 'webhook 一次收一笔' };
  if (!isPlainObject(read.value)) return { ok: false, message: '报文不是对象' };
  return { ok: true, value: read.value };
}

function externalIdOf(document: Record<string, unknown>, path: string): { ok: true; id: string } | { ok: false; message: string } {
  const read = readPath(document, path);
  if (!read.ok) return { ok: false, message: read.message };
  if (!read.found || typeof read.value !== 'string') return { ok: false, message: '外部主键必须是文本' };
  if (read.value.length === 0 || read.value.length > 256 || /[\s\u0000-\u001f]/.test(read.value)) {
    return { ok: false, message: '外部主键不合法' };
  }
  return { ok: true, id: read.value };
}

function readInternalRef(canonical: keyof typeof TOOL_OF, value: Record<string, unknown>): string | undefined {
  const key = NATURAL_KEY[canonical];
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

function rejectionOf(err: unknown): { code: string; message: string } | undefined {
  if (err instanceof CoreError) return { code: err.code, message: err.message };
  if (err instanceof Error && err.message.startsWith('TOOL_REJECTED:')) {
    return { code: 'TOOL_REJECTED', message: err.message.slice('TOOL_REJECTED:'.length).trim() || '工具拒绝了这笔' };
  }
  return undefined;
}

function linkRef(canonical: OutboundCanonical, snapshot: Record<string, unknown>): string | undefined {
  if (canonical === 'order.snapshot') return readSnapshotString(snapshot, 'orderNo');
  if (canonical === 'sku.snapshot') return readSnapshotString(snapshot, 'skuCode');
  if (canonical === 'partner.snapshot') return readSnapshotString(snapshot, 'partnerCode');
  return readSnapshotString(snapshot, 'orderNo') ?? readSnapshotString(snapshot, 'skuCode');
}

async function resolvePath(
  ws: WmsWorkspace,
  queue: IntegrationQueue,
  connector: Connector,
  path: string,
  eventId: string,
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  if (!PLACEHOLDERS.some((key) => path.includes(`{${key}}`))) return { ok: true, value: path };
  ws.sync();
  const env = findEvent(ws, eventId);
  if (!env) return { ok: false, message: '领域事件不在账本里' };
  const built = buildOutboundSnapshot(ws, env, connector.id, queue);
  if (!built.ok) return { ok: false, message: built.message };
  let filled = path;
  for (const key of PLACEHOLDERS) {
    const token = `{${key}}`;
    if (!filled.includes(token)) continue;
    const value = built.value[key];
    if (typeof value !== 'string' || value === '' || /[\s\u0000-\u001f]/.test(value)) {
      return { ok: false, message: '地址里的单号没有值' };
    }
    filled = filled.split(token).join(encodeURIComponent(value));
  }
  return { ok: true, value: filled };
}

function findEvent(ws: WmsWorkspace, eventId: string): EventEnvelope | undefined {
  let found: EventEnvelope | undefined;
  ws.events.forEach((env) => {
    if (env.eventId === eventId) {
      found = env;
      return false;
    }
  });
  return found;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return base + (path.startsWith('/') ? path : `/${path}`);
}

function isOutboundEvent(type: string): type is keyof typeof OUTBOUND_EVENT_CANONICAL {
  return Object.hasOwn(OUTBOUND_EVENT_CANONICAL, type);
}

function readSnapshotString(snapshot: Record<string, unknown>, key: string): string | undefined {
  const value = snapshot[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readPath(root: unknown, path: string): { ok: true; found: boolean; value?: unknown } | { ok: false; message: string } {
  let cursor = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return { ok: false, message: `路径 ${path} 中间不是对象` };
    if (!Object.hasOwn(cursor, segment)) return { ok: true, found: false };
    cursor = cursor[segment];
  }
  return { ok: true, found: true, value: cursor };
}

function jsonSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.length : BODY_MAX + 1;
  } catch {
    return BODY_MAX + 1;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function done(status: ReceiveResult['status'], body: ReceiveBody): ReceiveResult {
  return { status, body };
}
