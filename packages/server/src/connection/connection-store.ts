import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 这台机器的界面连哪里。
 *
 * lan：请求留在本机服务，设备之间走局域网配对。
 * platform：除了本接口，/api 都转到平台根地址。静态页面仍由本机提供，
 * 所以桌面壳和开发服务器不用改地址，也不依赖平台开 CORS。
 *
 * 明文 JSON 与 peers.json 同级。写法 temp + rename。
 */

export const CONNECTION_FILE = 'connection.json';
export const CONNECTION_VERSION = 1;

export type ConnectionMode = 'lan' | 'platform';

export interface ConnectionState {
  mode: ConnectionMode;
  /** 平台根地址，不含 /api，无尾斜杠。局域网模式下也保留，方便改回去再连。 */
  platformBaseUrl: string;
}

export interface ConnectionView extends ConnectionState {
  /** false = 宿主无落盘位，重启后回到局域网 */
  persisted: boolean;
}

interface ConnectionFile {
  version: typeof CONNECTION_VERSION;
  mode: ConnectionMode;
  platformBaseUrl: string;
}

const EMPTY: ConnectionState = { mode: 'lan', platformBaseUrl: '' };

/** dbPath → 连接文件；:memory: → null（只在进程内有效） */
export function resolveConnectionPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_CONNECTION_PATH === 'string' && env.ONE_CONNECTION_PATH.trim()) {
    return env.ONE_CONNECTION_PATH;
  }
  if (dbPath === ':memory:') return null;
  return resolve(dirname(resolve(dbPath)), CONNECTION_FILE);
}

export type NormalizeBaseResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * 平台根地址。接受用户把 /api 也写上，存的时候去掉，避免转到 /api/api。
 * 不接受查询串、账号密码，避免把令牌写进连接文件。
 */
export function normalizePlatformBaseUrl(raw: unknown): NormalizeBaseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: '平台地址不能为空（形如 http://主机/onewms，不要带 /api）' };
  }
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, message: `平台地址不合法：${text}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: '平台地址必须以 http:// 或 https:// 开头' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: `平台地址缺少主机名：${text}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: '平台地址里不要写账号或密码' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, message: '平台地址不要带查询参数' };
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -'/api'.length).replace(/\/+$/, '');
  if (path === '/') path = '';
  return { ok: true, url: `${parsed.origin}${path}` };
}

export interface ConnectionStore {
  readonly path: string | null;
  current(): ConnectionState;
  view(): ConnectionView;
  set(next: ConnectionState): ConnectionView;
}

export function createConnectionStore(path: string | null): ConnectionStore {
  let memory = path === null ? { ...EMPTY } : readConnection(path);
  return {
    path,
    current: () => ({ ...memory }),
    view: () => ({ ...memory, persisted: path !== null }),
    set(next) {
      memory = { mode: next.mode, platformBaseUrl: next.platformBaseUrl };
      if (path !== null) writeConnection(path, memory);
      return { ...memory, persisted: path !== null };
    },
  };
}

function readConnection(path: string): ConnectionState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { ...EMPTY };
  }
  if (!isConnectionFile(raw)) {
    console.warn(`[one-server] 连接设置不合法，已按局域网处理（${path}）`);
    return { ...EMPTY };
  }
  if (raw.mode === 'platform') {
    const base = normalizePlatformBaseUrl(raw.platformBaseUrl);
    if (!base.ok) {
      console.warn(`[one-server] 平台地址不可用，已按局域网处理（${path}）`);
      return { ...EMPTY };
    }
    return { mode: 'platform', platformBaseUrl: base.url };
  }
  const kept = typeof raw.platformBaseUrl === 'string' ? normalizePlatformBaseUrl(raw.platformBaseUrl) : null;
  return { mode: 'lan', platformBaseUrl: kept?.ok ? kept.url : '' };
}

function isConnectionFile(raw: unknown): raw is ConnectionFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const file = raw as { mode?: unknown; platformBaseUrl?: unknown };
  return (file.mode === 'lan' || file.mode === 'platform') && typeof file.platformBaseUrl === 'string';
}

function writeConnection(path: string, state: ConnectionState): void {
  const file: ConnectionFile = { version: CONNECTION_VERSION, ...state };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, path);
}
