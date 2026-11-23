/**
 * 浏览器侧的本机登录态（module.rbac）。
 *
 * 与 lib/connection.ts 的平台令牌分开：平台令牌是给平台接口用的，
 * 这里是给**本机** /api/* 用的（局域网模式下多个人共用一台服务器）。
 * rbac 停用时服务端不拦请求，这份状态也就一直是「未启用」，界面不显示登录门。
 *
 * 用模块级单例 + 订阅（和 connection.ts 一个路子），而不是 React context：
 * 请求头拼装（api/request.ts）和导航过滤（nav.ts）都要读它，
 * 那两处不在组件树里，拿不到 context。
 */

const TOKEN_KEY = 'onewms.sessionToken';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleName: string;
  node: string;
  status: 'active' | 'disabled';
  grants: string[];
}

export interface AuthStatus {
  /** rbac 模块是否启用。停用 = 免登录单人模式，一切权限判定直接通过 */
  enabled: boolean;
  /** 是否已经建过第一个账号。false 时登录页显示「建仓库经理」表单 */
  bootstrapped: boolean;
  sessionTimeoutMinutes: number;
}

const DISABLED_STATUS: AuthStatus = { enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 };

let status: AuthStatus = DISABLED_STATUS;
let user: SessionUser | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function readSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式写不进：本次运行仍能用内存里的请求头，刷新后要重新登录。
  }
}

export function authStatus(): AuthStatus {
  return status;
}

export function noteAuthStatus(next: AuthStatus): void {
  status = next;
  // 模块被关掉时把登录态清干净，别留个「已登录」的假象
  if (!next.enabled) clearSession();
  notify();
}

export function currentSessionUser(): SessionUser | null {
  return user;
}

export function noteSessionUser(next: SessionUser | null): void {
  user = next;
  notify();
}

export function clearSession(): void {
  user = null;
  writeSessionToken(null);
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 授权模式匹配，与服务端 rbac/permissions.ts 同一套语法：
 * `*` 贪婪通配（可跨段），单独一条 `*` = 全部权限。
 */
export function grantMatches(grant: string, permission: string): boolean {
  if (grant === permission || grant === '*') return true;
  const parts = grant.split('*');
  if (parts.length === 1) return false;
  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '') continue;
    const found = permission.indexOf(part, index);
    if (found < 0) return false;
    // 首段必须从头对齐，尾段必须收到末尾：否则 `page:*x` 会误判
    if (i === 0 && found !== 0) return false;
    if (i === parts.length - 1 && found + part.length !== permission.length) return false;
    index = found + part.length;
  }
  return true;
}

export function sessionCan(permission: string): boolean {
  // rbac 停用（默认）= 单人作业，全部放行
  if (!status.enabled) return true;
  if (!user) return false;
  return user.grants.some((grant) => grantMatches(grant, permission));
}

/** 页面能不能进 / 导航要不要显示这一项 */
export function canVisitPage(page: string): boolean {
  return sessionCan(`page:${page}`);
}
