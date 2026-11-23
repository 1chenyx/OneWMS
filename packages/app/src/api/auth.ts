import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './request';
import {
  authStatus,
  clearSession,
  currentSessionUser,
  noteAuthStatus,
  noteSessionUser,
  subscribeSession,
  writeSessionToken,
  type AuthStatus,
  type SessionUser,
} from '../lib/session';

/**
 * module.rbac 的接口面：登录门 + 用户与角色管理。
 *
 * rbac 停用（默认）时这些端点回 RBAC_DISABLED，界面上整块不出现——
 * 所以这里的 hook 只在 `authStatus().enabled` 为真时才 enabled。
 */

export interface AuthRoleView {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  grants: string[];
}

const KEYS = {
  status: ['auth', 'status'] as const,
  me: ['auth', 'me'] as const,
  users: ['auth', 'users'] as const,
  roles: ['auth', 'roles'] as const,
};

/** 登录门第一问：要不要登录、能不能自助建第一个账号 */
async function fetchStatus(): Promise<AuthStatus> {
  const view = await request<AuthStatus>('/api/auth/status');
  noteAuthStatus(view);
  return view;
}

/** 刷新页面后拿回上次的登录态（令牌还在 localStorage 里） */
async function fetchMe(): Promise<SessionUser> {
  const view = await request<{ user: SessionUser }>('/api/auth/me');
  noteSessionUser(view.user);
  return view.user;
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const view = await request<{ token: string; user: SessionUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  writeSessionToken(view.token);
  noteSessionUser(view.user);
  return view.user;
}

/** 一个用户都还没有时建第一个仓库经理。建完这条通道就关了。 */
export async function bootstrap(input: {
  username: string;
  displayName?: string;
  password: string;
}): Promise<SessionUser> {
  return request<SessionUser>('/api/auth/bootstrap', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  try {
    await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    // 服务端那一下失败也要把本地清掉，否则界面还显示着已登录
    clearSession();
    noteSessionUser(null);
  }
}

export async function changeOwnPassword(oldPassword: string, password: string): Promise<void> {
  await request<{ ok: boolean }>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, password }),
  });
  // 改口令会把这个人所有会话作废（含当前这个），直接退回登录门
  clearSession();
  noteSessionUser(null);
}

export function useAuthStatus() {
  return useQuery({
    queryKey: KEYS.status,
    queryFn: fetchStatus,
    staleTime: 30_000,
  });
}

/** rbac 启用且有本地令牌时才去问 /me；否则保持「未登录」 */
export function useSessionUser(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.me,
    queryFn: fetchMe,
    enabled: enabled && authStatus().enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function useAuthUsers(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.users,
    queryFn: () => request<{ rows: SessionUser[]; total: number }>('/api/auth/users'),
    enabled,
  });
}

export function useAuthRoles(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.roles,
    queryFn: () => request<{ rows: AuthRoleView[]; total: number }>('/api/auth/roles'),
    enabled,
  });
}

function useAuthMutation<TInput>(
  key: 'users' | 'roles',
  method: 'POST' | 'PATCH' | 'DELETE',
  url: (input: TInput) => string,
  bodyOf?: (input: TInput) => unknown,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) =>
      request<unknown>(url(input), {
        method,
        ...(bodyOf ? { body: JSON.stringify(bodyOf(input)) } : {}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS[key] }),
  });
}

export function useCreateUser() {
  return useAuthMutation<{
    username: string;
    displayName?: string;
    roleId: string;
    password: string;
    node?: string;
  }>('users', 'POST', () => '/api/auth/users', (input) => input);
}

export function useUpdateUser() {
  return useAuthMutation<{ id: string; patch: Record<string, unknown> }>(
    'users',
    'PATCH',
    (input) => `/api/auth/users/${encodeURIComponent(input.id)}`,
    (input) => input.patch,
  );
}

export function useDeleteUser() {
  return useAuthMutation<{ id: string }>(
    'users',
    'DELETE',
    (input) => `/api/auth/users/${encodeURIComponent(input.id)}`,
  );
}

export function useCreateRole() {
  return useAuthMutation<{ name: string; description?: string; grants: string[] }>(
    'roles',
    'POST',
    () => '/api/auth/roles',
    (input) => input,
  );
}

export function useUpdateRole() {
  return useAuthMutation<{ id: string; patch: Record<string, unknown> }>(
    'roles',
    'PATCH',
    (input) => `/api/auth/roles/${encodeURIComponent(input.id)}`,
    (input) => input.patch,
  );
}

export function useDeleteRole() {
  return useAuthMutation<{ id: string }>(
    'roles',
    'DELETE',
    (input) => `/api/auth/roles/${encodeURIComponent(input.id)}`,
  );
}

/** 组件订阅登录态（模块级单例，和 useConnectionMode 一个路子） */
export function useSession(): { status: AuthStatus; user: SessionUser | null } {
  const snapshot = useSyncExternalStore(subscribeSession, currentSessionUser, currentSessionUser);
  const statusSnapshot = useSyncExternalStore(subscribeSession, authStatus, authStatus);
  return { status: statusSnapshot, user: snapshot };
}
