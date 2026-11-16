/**
 * 浏览器侧记住的平台登录令牌，以及「当前这台服务是局域网还是平台」。
 * 令牌只放在本机浏览器。连接方式的真相在本机服务的 /api/connection。
 */

/** 已经在跑的平台根地址。设置页预填，用户可以改。 */
export const SUGGESTED_PLATFORM_BASE = 'http://49.235.83.195/onewms';

const TOKEN_KEY = 'onewms.platformToken';

export type ClientConnectionMode = 'lan' | 'platform';

let mode: ClientConnectionMode = 'lan';
const tokenListeners = new Set<() => void>();

export function clientConnectionMode(): ClientConnectionMode {
  return mode;
}

/** 服务端确认的连接方式。改回局域网时丢掉平台令牌，避免再带到本机接口。 */
export function noteConnectionMode(next: ClientConnectionMode): void {
  mode = next;
  if (next === 'lan') writePlatformToken(null);
}

export function readPlatformToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writePlatformToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式写不进时，本次运行仍可以用内存里的请求头；这里没有第二份缓存。
  }
  for (const listener of tokenListeners) listener();
}

export function subscribePlatformToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

export function roleLabel(role: string): string {
  if (role === 'owner') return '所有者';
  if (role === 'admin') return '管理员';
  if (role === 'clerk') return '作业员';
  if (role === 'viewer') return '只读';
  return role;
}
