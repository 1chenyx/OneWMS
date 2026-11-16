import { FieldApiError } from './errors.js';
import {
  fieldLink,
  isPlatformHealth,
  noteFieldLink,
  platformNodeFromConnection,
  readFieldToken,
  readMeWorkspaceId,
  readPlatformLogin,
  writeFieldToken,
  type PlatformLoginResult,
  type PlatformMembership,
} from './platform.js';
import { fieldRequestTarget, normalizeBaseUrl } from './url.js';

export interface HealthDto {
  ok: true;
  nodeId: string;
  /** 缺省部署是 "default" */
  workspaceId: string;
}

export interface FieldModuleConfig {
  enabled?: boolean;
  manifest?: { name?: string };
}

export interface FieldStateLabel {
  id: string;
  label: string;
}

/** 现场端只用模块开关，以及收货徽标要用的流程状态名。其余字段不解释。 */
export interface FieldSnapshot {
  workspaceId: string;
  modules: Record<string, FieldModuleConfig | undefined>;
  workflows?: {
    inbound?: { states?: FieldStateLabel[] };
    outbound?: { states?: FieldStateLabel[] };
  };
}

export interface ProbeResult {
  baseUrl: string;
  health: HealthDto;
  snapshot: FieldSnapshot;
}

export interface ModuleRow {
  id: string;
  name: string;
  on: boolean;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function httpError(status: number, body: unknown, fallback: string): FieldApiError {
  const record = body && typeof body === 'object' ? (body as { code?: unknown; message?: unknown }) : {};
  const code = typeof record.code === 'string' ? record.code : 'FIELD_HTTP';
  const message = typeof record.message === 'string' ? record.message : fallback;
  return new FieldApiError(code, message, status);
}

function asHealth(body: unknown): HealthDto {
  const record = body && typeof body === 'object' ? (body as { ok?: unknown; nodeId?: unknown; workspaceId?: unknown }) : {};
  if (record.ok !== true || typeof record.nodeId !== 'string' || typeof record.workspaceId !== 'string') {
    throw new FieldApiError('FIELD_NOT_WMS', '这不是仓库服务', 200);
  }
  return { ok: true, nodeId: record.nodeId, workspaceId: record.workspaceId };
}

function asStateLabels(value: unknown): FieldStateLabel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const states: FieldStateLabel[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { id?: unknown; label?: unknown };
    if (typeof rec.id !== 'string') continue;
    states.push({ id: rec.id, label: typeof rec.label === 'string' ? rec.label : rec.id });
  }
  return states;
}

function asSnapshot(body: unknown): FieldSnapshot {
  const record = body && typeof body === 'object' ? (body as { workspaceId?: unknown; modules?: unknown; workflows?: unknown }) : {};
  if (typeof record.workspaceId !== 'string' || !record.modules || typeof record.modules !== 'object' || Array.isArray(record.modules)) {
    throw new FieldApiError('FIELD_SNAPSHOT', '连上了，但没读到配置', 200);
  }
  const snapshot: FieldSnapshot = {
    workspaceId: record.workspaceId,
    modules: record.modules as FieldSnapshot['modules'],
  };
  if (record.workflows && typeof record.workflows === 'object' && !Array.isArray(record.workflows)) {
    const wf = record.workflows as { inbound?: { states?: unknown }; outbound?: { states?: unknown } };
    snapshot.workflows = {
      inbound: { states: asStateLabels(wf.inbound?.states) },
      outbound: { states: asStateLabels(wf.outbound?.states) },
    };
  }
  return snapshot;
}

/** enabled === true 才算开。缺模块、false、安装降级都当关。 */
export function moduleOn(snapshot: FieldSnapshot | null | undefined, id: string): boolean {
  return snapshot?.modules[id]?.enabled === true;
}

export function moduleRows(modules: FieldSnapshot['modules']): ModuleRow[] {
  return Object.entries(modules)
    .map(([id, config]) => ({
      id,
      name: config?.manifest?.name || id,
      on: config?.enabled === true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface FieldRequestOptions {
  /** 健康检查和登录本身不带令牌。 */
  auth?: boolean;
}

/** 读和写都从这里出去。平台模式带 Bearer。开发页上的平台地址走 /__field。 */
export async function fieldRequest(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
  options?: FieldRequestOptions,
): Promise<Response> {
  const pagePort = typeof window === 'undefined' ? '' : window.location.port;
  const target = fieldRequestTarget(baseUrl, path, import.meta.env.DEV, pagePort);
  const headers = new Headers(init?.headers);
  if (target.relay) headers.set('x-field-base', baseUrl);
  if (options?.auth !== false && fieldLink() === 'platform') {
    const token = readFieldToken();
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  }
  try {
    return await fetchImpl(target.url, { ...init, headers });
  } catch {
    throw new FieldApiError('FIELD_OFFLINE', '没连上，看地址再试', 0);
  }
}

export async function probeServer(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const baseUrl = normalizeBaseUrl(rawUrl);
  const healthRes = await fieldRequest(baseUrl, '/api/health', undefined, fetchImpl, { auth: false });
  const healthBody = await readBody(healthRes);
  if (!healthRes.ok) throw httpError(healthRes.status, healthBody, '没连上，看地址再试');
  if (isPlatformHealth(healthBody)) return probePlatform(baseUrl, fetchImpl);

  noteFieldLink('lan');
  const health = asHealth(healthBody);
  const snapRes = await fieldRequest(baseUrl, '/api/profile/snapshot', undefined, fetchImpl, { auth: false });
  const snapBody = await readBody(snapRes);
  if (!snapRes.ok) throw httpError(snapRes.status, snapBody, '连上了，但没读到配置');
  return { baseUrl, health, snapshot: asSnapshot(snapBody) };
}

async function probePlatform(baseUrl: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  noteFieldLink('platform');
  if (!readFieldToken()) throw new FieldApiError('FIELD_PLATFORM_AUTH', '这是平台，先登录账号', 401);
  const snapRes = await fieldRequest(baseUrl, '/api/profile/snapshot', undefined, fetchImpl);
  const snapBody = await readBody(snapRes);
  if (snapRes.status === 401) {
    writeFieldToken(null);
    throw new FieldApiError('FIELD_PLATFORM_AUTH', '登录已失效，重新登录', 401);
  }
  if (!snapRes.ok) throw httpError(snapRes.status, snapBody, '连上了，但没读到配置');
  const snapshot = asSnapshot(snapBody);
  const nodeId = await readPlatformNode(baseUrl, fetchImpl);
  let workspaceId = snapshot.workspaceId;
  const meRes = await fieldRequest(baseUrl, '/api/auth/me', undefined, fetchImpl);
  if (meRes.ok) {
    const meId = readMeWorkspaceId(await readBody(meRes));
    if (meId) workspaceId = meId;
  }
  return { baseUrl, health: { ok: true, nodeId, workspaceId }, snapshot };
}

async function readPlatformNode(baseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const res = await fieldRequest(baseUrl, '/api/connection', undefined, fetchImpl, { auth: false });
    if (!res.ok) return platformNodeFromConnection(null, baseUrl);
    return platformNodeFromConnection(await readBody(res), baseUrl);
  } catch {
    return platformNodeFromConnection(null, baseUrl);
  }
}

export async function platformLogin(
  rawUrl: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformLoginResult & { baseUrl: string }> {
  const baseUrl = normalizeBaseUrl(rawUrl);
  noteFieldLink('platform');
  const res = await fieldRequest(
    baseUrl,
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    fetchImpl,
    { auth: false },
  );
  const body = await readBody(res);
  if (!res.ok) throw httpError(res.status, body, '没登录上');
  const parsed = readPlatformLogin(body);
  if (!parsed) throw new FieldApiError('FIELD_PLATFORM_AUTH', '平台没有返回登录结果', res.status);
  writeFieldToken(parsed.token);
  return { ...parsed, baseUrl };
}

export async function selectPlatformWorkspace(
  rawUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const baseUrl = normalizeBaseUrl(rawUrl);
  const res = await fieldRequest(
    baseUrl,
    '/api/session/workspace',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    },
    fetchImpl,
  );
  if (!res.ok) throw httpError(res.status, await readBody(res), '没选中工作区');
}

export async function platformLogout(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fieldRequest(
      baseUrl,
      '/api/auth/logout',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      fetchImpl,
    );
  } catch {
    // 令牌清掉即可，平台会话过期也一样。
  }
  writeFieldToken(null);
}

export type { PlatformMembership };

/** 读路径不走写端口。失败与写端口同一套 code。 */
export async function fieldGet(baseUrl: string, path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fieldRequest(baseUrl, path, undefined, fetchImpl);
  } catch (err) {
    if (err instanceof FieldApiError) throw new FieldApiError(err.code, '没发出去，看完再试', err.status);
    throw new FieldApiError('FIELD_OFFLINE', '没发出去，看完再试', 0);
  }
  const body = await readBody(res);
  if (!res.ok) throw httpError(res.status, body, '没发出去，看完再试');
  return body;
}
