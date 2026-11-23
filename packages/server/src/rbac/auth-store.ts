import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { BUILTIN_ROLES, sanitizeGrants, type RoleSeed } from './permissions.js';

/**
 * 用户 / 角色 / 登录会话存储（module.rbac）。
 *
 * 为什么不进 profile.roles：`ConfigState.roles` 是 v1 预留、恒空（见
 * packages/core/src/profile/profile-types.ts 的注释），而且账号密码不该跟着
 * 慢通道进 oplog 全文——那是会同步到别的节点、会被 AI 读到的事实流。
 * 所以这里自建一份，落盘方式与 chat-threads.json / ai-config.json 同级：
 * dbPath 同目录的 users.json，temp + rename 原子写，:memory: 宿主只在进程内。
 *
 * 密码用 node:crypto 的 scrypt（自带 salt，不引新依赖），只存散列不存明文。
 * 会话是进程内存态 + 落盘令牌：重启后不必重新登录，但过期照旧过期。
 */

export const AUTH_FILE = 'users.json';
export const AUTH_FILE_VERSION = 1;
/** 会话不活动的默认上限（分钟），与 rbac-manifest 的 sessionTimeoutMinutes 默认值一致 */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 240;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const USERNAME = /^[a-zA-Z0-9._@-]{2,64}$/;
const MAX_NAME = 60;
/** 最短口令。现场账号不该是 123456，但也不做复杂度要求——扫码枪旁边没人记得住 */
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  node: string;
  status: 'active' | 'disabled';
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

/** 出接口用的用户面：不带散列 */
export type PublicUser = Omit<AuthUser, 'passwordHash'>;

export interface AuthRole {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  grants: string[];
}

export interface AuthSession {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(normalizeSecret(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(normalizeSecret(password), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** scrypt 遇 NUL 字节会抛错；顺手把首尾空白去掉，免得复制粘贴带了个换行登不上 */
function normalizeSecret(raw: string): string {
  return raw.replace(/\0/g, '').trim();
}

export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string') throw new AuthError('BAD_REQUEST', '口令必须是字符串');
  const secret = normalizeSecret(raw);
  if (secret.length < MIN_PASSWORD) throw new AuthError('AUTH_WEAK_PASSWORD', `口令至少 ${MIN_PASSWORD} 位`);
  if (secret.length > MAX_PASSWORD) throw new AuthError('BAD_REQUEST', `口令最长 ${MAX_PASSWORD} 位`);
  return secret;
}

export function validateUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new AuthError('BAD_REQUEST', '账号必须是字符串');
  const username = raw.trim();
  if (!USERNAME.test(username)) {
    throw new AuthError('AUTH_BAD_USERNAME', '账号只能含字母数字和 ._@-，长度 2-64');
  }
  return username;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** dbPath → users.json 路径；:memory: 宿主无落盘位 → null（只在进程内有效） */
export function resolveAuthPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_AUTH_PATH === 'string' && env.ONE_AUTH_PATH.trim()) return env.ONE_AUTH_PATH;
  if (dbPath === ':memory:') return null;
  return resolve(dirname(resolve(dbPath)), AUTH_FILE);
}

interface AuthFile {
  version: typeof AUTH_FILE_VERSION;
  roles: AuthRole[];
  users: AuthUser[];
  sessions: AuthSession[];
}

function seedRoles(): AuthRole[] {
  return BUILTIN_ROLES.map(fromSeed);
}

function fromSeed(seed: RoleSeed): AuthRole {
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    builtin: true,
    grants: [...seed.grants],
  };
}

function clip(raw: unknown, max: number): string {
  return typeof raw === 'string' ? Array.from(raw.trim()).slice(0, max).join('') : '';
}

function readUser(raw: unknown): AuthUser | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const username = clip(row.username, 64);
  const passwordHash = typeof row.passwordHash === 'string' ? row.passwordHash : '';
  if (!username || !passwordHash) return undefined;
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
  return {
    id: typeof row.id === 'string' && row.id ? row.id : randomBytes(8).toString('hex'),
    username,
    displayName: clip(row.displayName, MAX_NAME) || username,
    roleId: clip(row.roleId, 80) || BUILTIN_ROLES[0]!.id,
    node: clip(row.node, 80),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    passwordHash,
    createdAt,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : createdAt,
  };
}

function readRole(raw: unknown): AuthRole | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const id = clip(row.id, 80);
  if (!id) return undefined;
  const grants = sanitizeGrants(row.grants) ?? [];
  return {
    id,
    name: clip(row.name, MAX_NAME) || id,
    description: clip(row.description, 300),
    builtin: row.builtin === true,
    grants,
  };
}

function readSession(raw: unknown): AuthSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const token = typeof row.token === 'string' ? row.token : '';
  const userId = typeof row.userId === 'string' ? row.userId : '';
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : 0;
  if (!token || !userId || createdAt === 0) return undefined;
  return {
    token,
    userId,
    createdAt,
    expiresAt: typeof row.expiresAt === 'number' ? row.expiresAt : createdAt,
    lastSeenAt: typeof row.lastSeenAt === 'number' ? row.lastSeenAt : createdAt,
  };
}

function readFile(path: string): AuthFile {
  const fallback: AuthFile = { version: AUTH_FILE_VERSION, roles: seedRoles(), users: [], sessions: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[one-server] 用户档案不合法，已忽略（${path}）`);
    return fallback;
  }
  const row = raw as Partial<AuthFile>;
  const roles = Array.isArray(row.roles)
    ? row.roles.map(readRole).filter((item): item is AuthRole => item !== undefined)
    : [];
  const byId = new Map(roles.map((role) => [role.id, role]));
  // 内置角色始终在场：文件被手改坏 / 老版本没有它时补回来，授权以文件里的为准
  for (const seed of BUILTIN_ROLES) if (!byId.has(seed.id)) roles.unshift(fromSeed(seed));
  const users = Array.isArray(row.users)
    ? row.users.map(readUser).filter((item): item is AuthUser => item !== undefined)
    : [];
  const userIds = new Set(users.map((user) => user.id));
  const sessions = Array.isArray(row.sessions)
    ? row.sessions
        .map(readSession)
        .filter((item): item is AuthSession => item !== undefined && userIds.has(item.userId))
    : [];
  return { version: AUTH_FILE_VERSION, roles, users, sessions };
}

function writeFile(path: string, file: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(file), 'utf-8');
  renameSync(tmp, path);
}

export interface LoginResult {
  token: string;
  user: PublicUser;
  expiresAt: number;
}

export interface AuthStore {
  readonly path: string | null;
  roles(): AuthRole[];
  getRole(id: string): AuthRole | undefined;
  createRole(input: { name: string; description?: string; grants: string[] }): AuthRole;
  updateRole(id: string, input: { name?: string; description?: string; grants?: string[] }): AuthRole;
  removeRole(id: string): boolean;
  users(): PublicUser[];
  getUser(id: string): PublicUser | undefined;
  findByUsername(username: string): AuthUser | undefined;
  createUser(input: {
    username: string;
    displayName?: string;
    roleId: string;
    password: string;
    node?: string;
  }): PublicUser;
  updateUser(
    id: string,
    input: { displayName?: string; roleId?: string; node?: string; status?: 'active' | 'disabled'; password?: string },
  ): PublicUser;
  removeUser(id: string): boolean;
  login(username: string, password: string, ttlMs: number): LoginResult;
  /** 取会话并续期（滑动过期）。过期或用户已停用/删除 → undefined 且顺手清掉 */
  session(token: string, ttlMs: number): LoginResult | undefined;
  logout(token: string): boolean;
  logoutUser(userId: string): number;
}

export function createAuthStore(path: string | null): AuthStore {
  const state: AuthFile = path === null
    ? { version: AUTH_FILE_VERSION, roles: seedRoles(), users: [], sessions: [] }
    : readFile(path);

  const persist = (): void => {
    if (path !== null) writeFile(path, state);
  };

  const publicUser = (user: AuthUser): PublicUser => {
    const { passwordHash: _hash, ...rest } = user;
    return rest;
  };

  const requireRole = (roleId: string): AuthRole => {
    const role = state.roles.find((item) => item.id === roleId);
    if (!role) throw new AuthError('AUTH_ROLE_MISSING', `角色 ${roleId} 不存在`);
    return role;
  };

  return {
    path,

    roles() {
      return state.roles.map((role) => ({ ...role, grants: [...role.grants] }));
    },

    getRole(id) {
      const role = state.roles.find((item) => item.id === id);
      return role ? { ...role, grants: [...role.grants] } : undefined;
    },

    createRole(input) {
      const name = clip(input.name, MAX_NAME);
      if (!name) throw new AuthError('BAD_REQUEST', '角色名称不能为空');
      const id = `role.${randomBytes(6).toString('hex')}`;
      if (state.roles.some((role) => role.name === name)) {
        throw new AuthError('AUTH_ROLE_TAKEN', `已经有叫「${name}」的角色`);
      }
      const role: AuthRole = {
        id,
        name,
        description: clip(input.description, 300),
        builtin: false,
        grants: [...input.grants],
      };
      state.roles.push(role);
      persist();
      return { ...role, grants: [...role.grants] };
    },

    updateRole(id, input) {
      const role = requireRole(id);
      if (input.name !== undefined) {
        const name = clip(input.name, MAX_NAME);
        if (!name) throw new AuthError('BAD_REQUEST', '角色名称不能为空');
        if (state.roles.some((item) => item.id !== id && item.name === name)) {
          throw new AuthError('AUTH_ROLE_TAKEN', `已经有叫「${name}」的角色`);
        }
        role.name = name;
      }
      if (input.description !== undefined) role.description = clip(input.description, 300);
      if (input.grants !== undefined) role.grants = [...input.grants];
      persist();
      return { ...role, grants: [...role.grants] };
    },

    removeRole(id) {
      const role = state.roles.find((item) => item.id === id);
      // 内置角色不删：它是新用户的回落面，删了就没有「默认能干什么」的答案
      if (!role || role.builtin) return false;
      if (state.users.some((user) => user.roleId === id)) {
        throw new AuthError('AUTH_ROLE_IN_USE', '还有用户挂在这个角色上，先改他们的角色');
      }
      state.roles = state.roles.filter((item) => item.id !== id);
      persist();
      return true;
    },

    users() {
      return state.users.map(publicUser);
    },

    getUser(id) {
      const user = state.users.find((item) => item.id === id);
      return user ? publicUser(user) : undefined;
    },

    findByUsername(username) {
      const wanted = username.trim().toLowerCase();
      return state.users.find((user) => user.username.toLowerCase() === wanted);
    },

    createUser(input) {
      const username = validateUsername(input.username);
      if (state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
        throw new AuthError('AUTH_USER_TAKEN', `账号 ${username} 已经存在`, 409);
      }
      requireRole(input.roleId);
      const now = Date.now();
      const user: AuthUser = {
        id: randomBytes(8).toString('hex'),
        username,
        displayName: clip(input.displayName, MAX_NAME) || username,
        roleId: input.roleId,
        node: clip(input.node, 80),
        status: 'active',
        passwordHash: hashPassword(validatePassword(input.password)),
        createdAt: now,
        updatedAt: now,
      };
      state.users.push(user);
      persist();
      return publicUser(user);
    },

    updateUser(id, input) {
      const user = state.users.find((item) => item.id === id);
      if (!user) throw new AuthError('AUTH_USER_MISSING', '用户不存在', 404);
      if (input.displayName !== undefined) {
        user.displayName = clip(input.displayName, MAX_NAME) || user.username;
      }
      if (input.roleId !== undefined) {
        requireRole(input.roleId);
        user.roleId = input.roleId;
      }
      if (input.node !== undefined) user.node = clip(input.node, 80);
      if (input.status !== undefined) {
        if (input.status !== 'active' && input.status !== 'disabled') {
          throw new AuthError('BAD_REQUEST', 'status 只能是 active 或 disabled');
        }
        user.status = input.status;
      }
      if (input.password !== undefined) {
        user.passwordHash = hashPassword(validatePassword(input.password));
      }
      user.updatedAt = Date.now();
      // 停用或改角色当场生效：把这个人已有的会话全部作废
      if (input.status === 'disabled' || input.roleId !== undefined) {
        state.sessions = state.sessions.filter((item) => item.userId !== id);
      }
      persist();
      return publicUser(user);
    },

    removeUser(id) {
      const before = state.users.length;
      state.users = state.users.filter((item) => item.id !== id);
      if (state.users.length === before) return false;
      state.sessions = state.sessions.filter((item) => item.userId !== id);
      persist();
      return true;
    },

    login(username, password, ttlMs) {
      const user = state.users.find(
        (item) => item.username.toLowerCase() === username.trim().toLowerCase(),
      );
      // 账号不存在也走一次散列比对：别让响应时间泄露「这个账号在不在」
      const hash = user?.passwordHash ?? hashPassword('not-a-real-password');
      if (!verifyPassword(password, hash) || user === undefined) {
        throw new AuthError('AUTH_BAD_CREDENTIALS', '账号或口令不对', 401);
      }
      if (user.status === 'disabled') {
        throw new AuthError('AUTH_USER_DISABLED', '这个账号已停用，找管理员开', 403);
      }
      const now = Date.now();
      const token = newToken();
      state.sessions = state.sessions.filter((item) => item.expiresAt > now);
      state.sessions.push({ token, userId: user.id, createdAt: now, expiresAt: now + ttlMs, lastSeenAt: now });
      persist();
      return { token, user: publicUser(user), expiresAt: now + ttlMs };
    },

    session(token, ttlMs) {
      const now = Date.now();
      const found = state.sessions.find((item) => item.token === token);
      if (!found) return undefined;
      if (found.expiresAt <= now) {
        state.sessions = state.sessions.filter((item) => item.token !== token);
        persist();
        return undefined;
      }
      const user = state.users.find((item) => item.id === found.userId);
      if (!user || user.status === 'disabled') {
        state.sessions = state.sessions.filter((item) => item.token !== token);
        persist();
        return undefined;
      }
      // 滑动过期：每次带令牌的请求都把窗口往后推，交接班中途不会突然被踢
      found.lastSeenAt = now;
      found.expiresAt = now + ttlMs;
      persist();
      return { token: found.token, user: publicUser(user), expiresAt: found.expiresAt };
    },

    logout(token) {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.token !== token);
      if (state.sessions.length === before) return false;
      persist();
      return true;
    },

    logoutUser(userId) {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.userId !== userId);
      if (state.sessions.length === before) return 0;
      persist();
      return before - state.sessions.length;
    },
  };
}
