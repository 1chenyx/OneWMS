import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PatchOp } from '@one/core';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import {
  AuthError,
  createAuthStore,
  hashPassword,
  resolveAuthPath,
  validatePassword,
  validateUsername,
  verifyPassword,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
} from '../src/rbac/auth-store.js';
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_IDS,
  hasPermission,
  isValidGrant,
  sanitizeGrants,
  grantMatches,
} from '../src/rbac/permissions.js';
import {
  bearerToken,
  isPublicPath,
  rbacEnabled,
  requiredPermission,
  sessionTtlMs,
} from '../src/rbac/auth-middleware.js';

/**
 * module.rbac（用户与角色）的落地口径测试。
 *
 * 第一性质：**装上但默认停用**——单人本地作业免登录，停用时行为和从前完全一致
 * （authGuard 整体空转、业务端点照常 200）。启用只在局域网/平台多人作业时经慢通道发生。
 * 其余覆盖：权限模式通配语义、口令散列与会话（含滑动过期与落盘读回）、
 * /api/auth/* 路由、actor 归属。
 */

let ctx: AppContext | undefined;
let tmpDir: string | undefined;

afterEach(() => {
  ctx?.close();
  ctx = undefined;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  vi.useRealTimers();
});

type App = ReturnType<typeof createApp>;

const json = { 'content-type': 'application/json' };

function setup(options?: { authPath?: string }): App {
  ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-rbac-test',
    ...(options?.authPath === undefined ? {} : { authPath: options.authPath }),
  });
  return createApp(ctx);
}

function freshTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'one-rbac-'));
  return tmpDir;
}

/** 慢通道：开 / 关 module.rbac（生产上就是模块页那一下确认） */
function setRbacEnabled(c: AppContext, enabled = true): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.rbac/enabled', value: enabled }];
  const { proposalId } = c.ws.profile.propose('user:tester', patch, enabled ? '多人作业，开账号' : '回到单人');
  c.ws.profile.confirm(proposalId, 'user:tester');
}

/** 慢通道：改会话超时（分钟） */
function setSessionTimeout(c: AppContext, minutes: number): void {
  const patch: PatchOp[] = [
    { op: 'replace', path: '/modules/module.rbac/settings/sessionTimeoutMinutes', value: minutes },
  ];
  const { proposalId } = c.ws.profile.propose('user:tester', patch, '交接班短一些');
  c.ws.profile.confirm(proposalId, 'user:tester');
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function post(app: App, url: string, body: unknown, headers: Record<string, string> = json): Promise<Response> {
  return app.request(url, { method: 'POST', body: JSON.stringify(body), headers });
}

function patch(app: App, url: string, body: unknown, headers: Record<string, string> = json): Promise<Response> {
  return app.request(url, { method: 'PATCH', body: JSON.stringify(body), headers });
}

function del(app: App, url: string, headers: Record<string, string> = json): Promise<Response> {
  return app.request(url, { method: 'DELETE', headers });
}

const withToken = (token: string): Record<string, string> => ({ ...json, authorization: `Bearer ${token}` });

interface UserView {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  node: string;
  status: 'active' | 'disabled';
  roleName: string;
  grants: string[];
}

/** 建第一个仓库经理（bootstrap 只在 0 用户时可用） */
async function bootstrap(app: App, username = 'boss', password = 'boss-pass-1'): Promise<UserView> {
  const res = await post(app, '/api/auth/bootstrap', { username, password, displayName: '仓库经理' });
  expect(res.status).toBe(200);
  return jsonOf<UserView>(res);
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await post(app, '/api/auth/login', { username, password });
  expect(res.status).toBe(200);
  const data = await jsonOf<{ token: string; user: UserView }>(res);
  expect(data.token).toBeTruthy();
  return data.token;
}

/** 启用 rbac + 建经理 + 建一个指定角色的账号，返回两套令牌 */
async function enabledWithUsers(
  app: App,
  roleId: 'role.worker' | 'role.auditor' | 'role.keeper',
): Promise<{ manager: string; other: string; otherId: string; managerId: string }> {
  setRbacEnabled(ctx!);
  const managerView = await bootstrap(app);
  const manager = await login(app, 'boss', 'boss-pass-1');
  const res = await post(app, '/api/auth/users', { username: 'staff', password: 'staff-pass-1', roleId }, withToken(manager));
  expect(res.status).toBe(200);
  const created = await jsonOf<UserView>(res);
  expect(created.roleId).toBe(roleId);
  const other = await login(app, 'staff', 'staff-pass-1');
  return { manager, other, otherId: created.id, managerId: managerView.id };
}

const grantsOf = (roleId: string): readonly string[] =>
  BUILTIN_ROLES.find((role) => role.id === roleId)!.grants;

describe('permissions：授权模式的合法性与通配语义', () => {
  it('isValidGrant：四类权限对象与 * 合法，越界写法一律不合法', () => {
    for (const ok of ['*', 'page:users', 'page:*', 'tool.read:wms.sku.query', 'tool.write:wms.picking.*', 'config.propose', 'config.confirm', 'report.export:*']) {
      expect(isValidGrant(ok), ok).toBe(true);
    }
    for (const bad of ['', 'Page:Users', 'page:', '.page', 'page:users 空格', 'a'.repeat(121), '1abc', 'page:中文']) {
      expect(isValidGrant(bad), bad).toBe(false);
    }
    expect(isValidGrant('a'.repeat(120))).toBe(true);
  });

  it('sanitizeGrants：非数组或含非法项 → undefined；合法则去重并 trim', () => {
    expect(sanitizeGrants('page:*')).toBeUndefined();
    expect(sanitizeGrants(undefined)).toBeUndefined();
    expect(sanitizeGrants({ grants: [] })).toBeUndefined();
    expect(sanitizeGrants(['page:*', 1])).toBeUndefined();
    expect(sanitizeGrants(['page:*', 'BAD grant'])).toBeUndefined();
    expect(sanitizeGrants([])).toEqual([]);
    expect(sanitizeGrants([' page:users ', 'page:users', 'tool.read:*'])).toEqual(['page:users', 'tool.read:*']);
  });

  it("grantMatches：'*' 匹配一切，其余按模式对齐", () => {
    expect(grantMatches('*', 'page:users')).toBe(true);
    expect(grantMatches('*', 'tool.write:wms.picking.pick')).toBe(true);
    expect(grantMatches('page:users', 'page:users')).toBe(true);
    expect(grantMatches('page:users', 'page:roles')).toBe(false);
  });

  it("grantMatches：'page:*' 命中页面，不越界到工具权限", () => {
    expect(grantMatches('page:*', 'page:users')).toBe(true);
    expect(grantMatches('page:*', 'page:dashboard')).toBe(true);
    expect(grantMatches('page:*', 'tool.read:x')).toBe(false);
    expect(grantMatches('page:*', 'config.confirm')).toBe(false);
  });

  it("grantMatches：'tool.write:wms.picking.*' 的前缀语义", () => {
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.picking.pick')).toBe(true);
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.picking.create')).toBe(true);
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.order.putaway')).toBe(false);
    // 读权限不被写模式覆盖
    expect(grantMatches('tool.write:wms.picking.*', 'tool.read:wms.picking.query')).toBe(false);
  });

  it('grantMatches：首段必须从头对齐，不能在中间命中', () => {
    expect(grantMatches('picking.*', 'tool.write:wms.picking.pick')).toBe(false);
    expect(grantMatches('write:*', 'tool.write:wms.picking.pick')).toBe(false);
    expect(grantMatches('tool.*', 'tools.read:x')).toBe(false);
    // '*' 是贪婪通配，可跨段
    expect(grantMatches('tool.*', 'tool.read:wms.sku.query')).toBe(true);
    expect(grantMatches('*:users', 'page:users')).toBe(true);
  });

  it('hasPermission：任一模式命中即通过；空授权什么都不给', () => {
    expect(hasPermission([], 'page:users')).toBe(false);
    expect(hasPermission(['page:*'], 'page:users')).toBe(true);
    expect(hasPermission(['page:dashboard', 'tool.read:*'], 'tool.read:wms.sku.query')).toBe(true);
    expect(hasPermission(['page:dashboard', 'tool.read:*'], 'tool.write:wms.sku.create')).toBe(false);
  });

  it('内置四角色：只有经理有 * 与 config.confirm；库工没有用户页', () => {
    expect(BUILTIN_ROLES.map((role) => role.id)).toEqual([
      'role.manager',
      'role.keeper',
      'role.worker',
      'role.auditor',
    ]);
    expect([...BUILTIN_ROLE_IDS].sort()).toEqual(['role.auditor', 'role.keeper', 'role.manager', 'role.worker']);
    expect(grantsOf('role.manager')).toEqual(['*']);

    for (const roleId of ['role.keeper', 'role.worker', 'role.auditor']) {
      expect(hasPermission(grantsOf(roleId), 'config.confirm'), roleId).toBe(false);
    }
    expect(hasPermission(grantsOf('role.keeper'), 'config.propose')).toBe(true);
    expect(hasPermission(grantsOf('role.worker'), 'config.propose')).toBe(false);

    // page:* 覆盖用户页：仓管员与审计能看用户列表，库工不能
    expect(hasPermission(grantsOf('role.keeper'), 'page:users')).toBe(true);
    expect(hasPermission(grantsOf('role.auditor'), 'page:users')).toBe(true);
    expect(hasPermission(grantsOf('role.worker'), 'page:users')).toBe(false);

    // 审计只读：没有任何写权限
    expect(hasPermission(grantsOf('role.auditor'), 'tool.write:wms.picking.pick')).toBe(false);
    expect(hasPermission(grantsOf('role.auditor'), 'tool.read:wms.picking.query')).toBe(true);
    // 库工只做那几类写操作
    expect(hasPermission(grantsOf('role.worker'), 'tool.write:wms.picking.pick')).toBe(true);
    expect(hasPermission(grantsOf('role.worker'), 'tool.write:wms.order.putaway')).toBe(true);
    expect(hasPermission(grantsOf('role.worker'), 'tool.write:wms.sku.create')).toBe(false);
  });
});

describe('auth-store：口令散列', () => {
  it('hash + verify 往返；错口令不通过', () => {
    const stored = hashPassword('secret-1');
    expect(verifyPassword('secret-1', stored)).toBe(true);
    expect(verifyPassword('secret-2', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('散列串里没有明文，同口令两次散列不同（salt）', () => {
    const password = 'warehouse-2026';
    const a = hashPassword(password);
    const b = hashPassword(password);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
    expect(b).not.toContain(password);
    expect(a.startsWith('scrypt:')).toBe(true);
    expect(verifyPassword(password, a)).toBe(true);
    expect(verifyPassword(password, b)).toBe(true);
  });

  it('散列串被改坏 / 不是 scrypt 格式 → 不通过（不抛）', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt:1:2:3:4:5')).toBe(false);
    expect(verifyPassword('x', 'scrypt:16384:8:1::')).toBe(false);
  });

  it('首尾空白与 NUL 字节被归一：粘贴带了换行也登得上', () => {
    const stored = hashPassword('  secret-1  ');
    expect(verifyPassword('secret-1', stored)).toBe(true);
  });

  it('validatePassword：少于 6 位抛 AUTH_WEAK_PASSWORD，超长与非字符串抛 BAD_REQUEST', () => {
    expect(() => validatePassword('12345')).toThrowError(AuthError);
    try {
      validatePassword('12345');
    } catch (err) {
      expect((err as AuthError).code).toBe('AUTH_WEAK_PASSWORD');
    }
    expect(validatePassword('123456')).toBe('123456');
    expect(validatePassword('  abcdefg ')).toBe('abcdefg');
    expect(() => validatePassword(123456)).toThrowError(/口令必须是字符串/);
    expect(() => validatePassword('x'.repeat(201))).toThrowError(/最长/);
  });

  it('validateUsername：非法字符抛 AUTH_BAD_USERNAME，合法则 trim 后返回', () => {
    expect(validateUsername('  boss.name_1@x-2 ')).toBe('boss.name_1@x-2');
    for (const bad of ['a', '有中文', 'has space', 'x'.repeat(65), '']) {
      try {
        validateUsername(bad);
        expect.unreachable(`${bad} 应该被拒`);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_BAD_USERNAME');
      }
    }
    expect(() => validateUsername(null)).toThrowError(/账号必须是字符串/);
  });
});

describe('auth-store：用户与角色', () => {
  it('内存态（path=null）：内置四角色在场，用户面不带散列', () => {
    const store = createAuthStore(null);
    expect(store.path).toBeNull();
    expect(store.roles().map((role) => role.id).sort()).toEqual(
      ['role.auditor', 'role.keeper', 'role.manager', 'role.worker'],
    );
    expect(store.roles().every((role) => role.builtin)).toBe(true);
    expect(store.users()).toEqual([]);

    const created = store.createUser({ username: 'bob', roleId: 'role.worker', password: 'bob-pass-1' });
    expect(created).toMatchObject({ username: 'bob', displayName: 'bob', roleId: 'role.worker', status: 'active' });
    expect(Object.keys(created)).not.toContain('passwordHash');
    expect(store.findByUsername('BOB')?.username).toBe('bob');
    expect(store.getUser(created.id)?.id).toBe(created.id);
  });

  it('重名账号 → AUTH_USER_TAKEN（409）；不存在的角色 → AUTH_ROLE_MISSING', () => {
    const store = createAuthStore(null);
    store.createUser({ username: 'bob', roleId: 'role.worker', password: 'bob-pass-1' });
    try {
      store.createUser({ username: 'BOB', roleId: 'role.worker', password: 'bob-pass-2' });
      expect.unreachable('重名应该被拒');
    } catch (err) {
      expect((err as AuthError).code).toBe('AUTH_USER_TAKEN');
      expect((err as AuthError).status).toBe(409);
    }
    expect(() => store.createUser({ username: 'carl', roleId: 'role.ghost', password: 'carl-pass-1' })).toThrowError(
      /不存在/,
    );
  });

  it('内置角色删不掉（removeRole → false）；自建角色可删', () => {
    const store = createAuthStore(null);
    expect(store.removeRole('role.manager')).toBe(false);
    expect(store.removeRole('role.worker')).toBe(false);
    expect(store.removeRole('role.ghost')).toBe(false);
    expect(store.getRole('role.manager')).toBeDefined();

    const custom = store.createRole({ name: '质检员', grants: ['page:scenario', 'tool.read:*'] });
    expect(custom.builtin).toBe(false);
    expect(custom.id.startsWith('role.')).toBe(true);
    expect(store.removeRole(custom.id)).toBe(true);
    expect(store.getRole(custom.id)).toBeUndefined();
  });

  it('自建角色上还有用户 → AUTH_ROLE_IN_USE；角色重名 → AUTH_ROLE_TAKEN', () => {
    const store = createAuthStore(null);
    const custom = store.createRole({ name: '质检员', grants: ['tool.read:*'] });
    const user = store.createUser({ username: 'bob', roleId: custom.id, password: 'bob-pass-1' });
    try {
      store.removeRole(custom.id);
      expect.unreachable('有用户挂着不该删掉');
    } catch (err) {
      expect((err as AuthError).code).toBe('AUTH_ROLE_IN_USE');
    }
    expect(() => store.createRole({ name: '质检员', grants: [] })).toThrowError(/已经有叫/);
    // 用户改走别的角色后即可删
    store.updateUser(user.id, { roleId: 'role.worker' });
    expect(store.removeRole(custom.id)).toBe(true);
    expect(() => store.createRole({ name: '', grants: [] })).toThrowError(/名称不能为空/);
  });

  it('updateRole 改授权与名称；不存在的角色 → AUTH_ROLE_MISSING', () => {
    const store = createAuthStore(null);
    const updated = store.updateRole('role.worker', { grants: ['page:*'] });
    expect(updated.grants).toEqual(['page:*']);
    expect(updated.builtin).toBe(true);
    expect(() => store.updateRole('role.ghost', { name: 'x' })).toThrowError(/不存在/);
  });
});

describe('auth-store：登录会话（滑动过期与作废）', () => {
  const ttl = 60_000;

  function storeWithBob() {
    const store = createAuthStore(null);
    const user = store.createUser({ username: 'bob', roleId: 'role.worker', password: 'bob-pass-1' });
    return { store, user };
  }

  it('login 拿到令牌，session(token, ttl) 取回用户；错口令 → AUTH_BAD_CREDENTIALS(401)', () => {
    const { store, user } = storeWithBob();
    const result = store.login('bob', 'bob-pass-1', ttl);
    expect(result.user.id).toBe(user.id);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    const found = store.session(result.token, ttl);
    expect(found?.user.username).toBe('bob');
    expect(found?.token).toBe(result.token);

    try {
      store.login('bob', 'wrong-pass', ttl);
      expect.unreachable('错口令不该登录成功');
    } catch (err) {
      expect((err as AuthError).code).toBe('AUTH_BAD_CREDENTIALS');
      expect((err as AuthError).status).toBe(401);
    }
    // 账号不存在也是同一句错（不泄露账号在不在）
    expect(() => store.login('ghost', 'whatever-1', ttl)).toThrowError(/账号或口令不对/);
    expect(store.session('not-a-token', ttl)).toBeUndefined();
  });

  it('logout 后会话取不到；重复登出 → false', () => {
    const { store } = storeWithBob();
    const { token } = store.login('bob', 'bob-pass-1', ttl);
    expect(store.logout(token)).toBe(true);
    expect(store.session(token, ttl)).toBeUndefined();
    expect(store.logout(token)).toBe(false);
  });

  it('停用账号：登录被拒（403），已有会话当场作废', () => {
    const { store, user } = storeWithBob();
    const { token } = store.login('bob', 'bob-pass-1', ttl);
    expect(store.session(token, ttl)).toBeDefined();
    store.updateUser(user.id, { status: 'disabled' });
    expect(store.session(token, ttl)).toBeUndefined();
    try {
      store.login('bob', 'bob-pass-1', ttl);
      expect.unreachable('停用账号不该登录成功');
    } catch (err) {
      expect((err as AuthError).code).toBe('AUTH_USER_DISABLED');
      expect((err as AuthError).status).toBe(403);
    }
    // 重新启用后可登录
    store.updateUser(user.id, { status: 'active' });
    expect(store.login('bob', 'bob-pass-1', ttl).user.status).toBe('active');
  });

  it('改角色也作废该用户会话（权限当场生效）', () => {
    const { store, user } = storeWithBob();
    const { token } = store.login('bob', 'bob-pass-1', ttl);
    store.updateUser(user.id, { roleId: 'role.auditor' });
    expect(store.session(token, ttl)).toBeUndefined();
    expect(store.getUser(user.id)?.roleId).toBe('role.auditor');
  });

  it('改口令：旧口令失效、新口令能登录；只改显示名不作废会话', () => {
    const { store, user } = storeWithBob();
    store.updateUser(user.id, { password: 'bob-pass-2' });
    expect(() => store.login('bob', 'bob-pass-1', ttl)).toThrowError(/账号或口令不对/);
    expect(store.login('bob', 'bob-pass-2', ttl).user.username).toBe('bob');
    expect(() => store.updateUser(user.id, { password: '123' })).toThrowError(/至少/);

    const { token } = store.login('bob', 'bob-pass-2', ttl);
    store.updateUser(user.id, { displayName: '老 Bob' });
    expect(store.session(token, ttl)?.user.displayName).toBe('老 Bob');
  });

  it('logoutUser 清掉某人全部会话；removeUser 连人带会话一起清', () => {
    const { store, user } = storeWithBob();
    const first = store.login('bob', 'bob-pass-1', ttl).token;
    const second = store.login('bob', 'bob-pass-1', ttl).token;
    expect(store.logoutUser(user.id)).toBe(2);
    expect(store.session(first, ttl)).toBeUndefined();
    expect(store.session(second, ttl)).toBeUndefined();
    expect(store.logoutUser(user.id)).toBe(0);

    const third = store.login('bob', 'bob-pass-1', ttl).token;
    expect(store.removeUser(user.id)).toBe(true);
    expect(store.session(third, ttl)).toBeUndefined();
    expect(store.removeUser(user.id)).toBe(false);
  });

  it('滑动过期：每次带令牌的请求都把窗口往后推，超过窗口才失效', () => {
    vi.useFakeTimers();
    const { store } = storeWithBob();
    const { token } = store.login('bob', 'bob-pass-1', 60_000);

    vi.advanceTimersByTime(45_000);
    expect(store.session(token, 60_000)?.user.username).toBe('bob'); // 45s 时续期到 105s
    vi.advanceTimersByTime(45_000);
    expect(store.session(token, 60_000)?.user.username).toBe('bob'); // 90s 仍在窗口内（滑动生效）
    vi.advanceTimersByTime(61_000);
    expect(store.session(token, 60_000)).toBeUndefined(); // 151s：距上次续期 61s，过期
    // 过期会话顺手清掉：再问一次也是 undefined
    expect(store.session(token, 60_000)).toBeUndefined();
  });

  it('ttl 传极小值时立即过期（不依赖假时钟）', async () => {
    const { store } = storeWithBob();
    const { token } = store.login('bob', 'bob-pass-1', 5);
    await new Promise((done) => setTimeout(done, 30));
    expect(store.session(token, 60_000)).toBeUndefined();
  });
});

describe('auth-store：落盘模式（重启读回）', () => {
  it('用户、自建角色与会话令牌都能被同一路径的新 store 读回', () => {
    const dir = freshTmpDir();
    const path = join(dir, 'users.json');
    const first = createAuthStore(path);
    expect(first.path).toBe(path);
    const user = first.createUser({ username: 'boss', roleId: 'role.manager', password: 'boss-pass-1', node: 'n1' });
    const custom = first.createRole({ name: '质检员', grants: ['page:scenario'] });
    const { token } = first.login('boss', 'boss-pass-1', 60_000);

    const second = createAuthStore(path);
    expect(second.users()).toHaveLength(1);
    expect(second.getUser(user.id)).toMatchObject({ username: 'boss', roleId: 'role.manager', node: 'n1' });
    expect(Object.keys(second.users()[0]!)).not.toContain('passwordHash');
    expect(second.getRole(custom.id)?.name).toBe('质检员');
    expect(second.roles()).toHaveLength(5); // 四内置 + 一自建
    // 重启后不必重新登录，且散列仍可校验
    expect(second.session(token, 60_000)?.user.username).toBe('boss');
    expect(second.login('boss', 'boss-pass-1', 60_000).user.id).toBe(user.id);
  });

  it('文件里缺内置角色时补回来；不合法的文件整体忽略并回到种子', () => {
    const dir = freshTmpDir();
    const path = join(dir, 'users.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        roles: [{ id: 'role.custom', name: '临时', description: '', builtin: false, grants: ['page:*'] }],
        users: [{ id: 'u1', username: 'hand', passwordHash: hashPassword('hand-pass-1'), roleId: 'role.custom' }],
        sessions: [{ token: 'tok-1', userId: 'u1', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }],
      }),
      'utf-8',
    );
    const store = createAuthStore(path);
    const ids = store.roles().map((role) => role.id);
    for (const builtin of BUILTIN_ROLE_IDS) expect(ids).toContain(builtin);
    expect(ids).toContain('role.custom');
    expect(store.users().map((user) => user.username)).toEqual(['hand']);
    expect(store.session('tok-1', 60_000)?.user.username).toBe('hand');

    writeFileSync(path, '这不是 JSON', 'utf-8');
    const broken = createAuthStore(path);
    expect(broken.users()).toEqual([]);
    expect(broken.roles()).toHaveLength(4);
  });

  it('resolveAuthPath：:memory: 无落盘位，其余落在 dbPath 同目录，env 可覆盖', () => {
    expect(resolveAuthPath(':memory:', {})).toBeNull();
    const resolved = resolveAuthPath('/data/one/onewms.db', {});
    expect(resolved?.endsWith('users.json')).toBe(true);
    expect(resolved?.includes('one')).toBe(true);
    expect(resolveAuthPath(':memory:', { ONE_AUTH_PATH: '/tmp/x/users.json' })).toBe('/tmp/x/users.json');
  });
});

describe('auth-middleware：放行清单与权限点名（纯函数面）', () => {
  it('isPublicPath：非 /api/ 一律放行；清单内前缀放行，边界不越界', () => {
    for (const open of ['/', '/index.html', '/assets/app.js', '/users', '/api']) {
      expect(isPublicPath(open), open).toBe(true);
    }
    for (const open of [
      '/api/health',
      '/api/connection',
      '/api/connection/mode',
      '/api/sync/hello',
      '/api/integrations/webhook',
      '/api/auth/status',
      '/api/auth/login',
      '/api/auth/bootstrap',
    ]) {
      expect(isPublicPath(open), open).toBe(true);
    }
    for (const closed of [
      '/api/profile/snapshot',
      '/api/proposals',
      '/api/auth',
      '/api/auth/users',
      '/api/auth/me',
      '/api/auth/logout',
      '/api/auth/roles',
      '/api/tools/wms.sku.query/invoke',
      '/api/healthx',
      '/api/syncx/hello',
    ]) {
      expect(isPublicPath(closed), closed).toBe(false);
    }
  });

  it('bearerToken：只认 Bearer 前缀', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   abc.def ')).toBe('abc.def');
    expect(bearerToken('abc.def')).toBeUndefined();
    expect(bearerToken('Bearer ')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it('sessionTtlMs：默认 240 分钟；慢通道改设置后跟着变', () => {
    setup();
    expect(DEFAULT_SESSION_TIMEOUT_MINUTES).toBe(240);
    expect(sessionTtlMs(ctx!)).toBe(240 * 60_000);
    setSessionTimeout(ctx!, 30);
    expect(sessionTtlMs(ctx!)).toBe(30 * 60_000);
  });

  it('requiredPermission：用户与角色页点名 page:users，慢通道按动作分档', () => {
    setup();
    const c = ctx!;
    expect(requiredPermission('GET', '/api/auth/users', c)).toBe('page:users');
    expect(requiredPermission('POST', '/api/auth/users', c)).toBe('page:users');
    expect(requiredPermission('PATCH', '/api/auth/roles/role.worker', c)).toBe('page:users');
    expect(requiredPermission('POST', '/api/proposals/p1/confirm', c)).toBe('config.confirm');
    expect(requiredPermission('POST', '/api/proposals/p1/reject', c)).toBe('config.confirm');
    // 非 POST 的慢通道端点只要登录
    expect(requiredPermission('GET', '/api/proposals', c)).toBeNull();
    expect(requiredPermission('GET', '/api/proposals/p1', c)).toBeNull();
    expect(requiredPermission('GET', '/api/profile/snapshot', c)).toBeNull();
    // 提案入口在 profile 路由下：POST /api/profile/propose 要 config.propose
    expect(requiredPermission('POST', '/api/profile/propose', c)).toBe('config.propose');
  });

  it('requiredPermission：工具端点按工具声明给 tool.read / tool.write，不在总线上则不点名', () => {
    setup();
    const c = ctx!;
    const tools = c.ws.tools.list();
    const write = tools.find((tool) => tool.permission === 'write');
    const read = tools.find((tool) => tool.permission !== 'write');
    expect(write).toBeDefined();
    expect(read).toBeDefined();
    expect(requiredPermission('POST', `/api/tools/${write!.id}/invoke`, c)).toBe(`tool.write:${write!.id}`);
    expect(requiredPermission('POST', `/api/tools/${write!.id}/confirm`, c)).toBe(`tool.write:${write!.id}`);
    expect(requiredPermission('POST', `/api/tools/${read!.id}/invoke`, c)).toBe(`tool.read:${read!.id}`);
    expect(requiredPermission('POST', '/api/tools/wms.ghost.tool/invoke', c)).toBeNull();
    expect(requiredPermission('GET', `/api/tools/${write!.id}`, c)).toBeNull();
  });
});

describe('authGuard：默认停用 = 零影响（这条最重要）', () => {
  it('module.rbac 装上但默认停用', () => {
    setup();
    const modules = ctx!.ws.profile.getSnapshot().modules;
    expect(modules['module.rbac']).toBeDefined();
    expect(modules['module.rbac']?.enabled).toBe(false);
    expect(rbacEnabled(ctx!)).toBe(false);
  });

  it('停用时业务端点无令牌照常 200，行为和从前完全一致', async () => {
    const app = setup();
    const snapshot = await app.request('/api/profile/snapshot');
    expect(snapshot.status).toBe(200);
    expect((await jsonOf<{ version: number }>(snapshot)).version).toBeGreaterThan(0);

    const catalog = await app.request('/api/profile/catalog');
    expect(catalog.status).toBe(200);

    const health = await app.request('/api/health');
    expect(health.status).toBe(200);

    const proposals = await app.request('/api/proposals');
    expect(proposals.status).toBe(200);
    expect(await jsonOf<unknown[]>(proposals)).toEqual([]);

    const tools = await app.request('/api/ui/pages');
    expect([200, 404]).toContain(tools.status);
  });

  it('停用时慢通道照走：提案 + 确认都不需要令牌', async () => {
    const app = setup();
    const propose = await post(app, '/api/profile/propose', {
      patch: [{ op: 'replace', path: '/modules/module.putaway/enabled', value: false }],
      note: '停用上架模块',
    });
    expect(propose.status).toBe(201);
    const { proposalId } = await jsonOf<{ proposalId: string }>(propose);
    const confirm = await post(app, `/api/proposals/${proposalId}/confirm`, {});
    expect(confirm.status).toBe(200);
    expect(ctx!.ws.profile.getSnapshot().modules['module.putaway']?.enabled).toBe(false);
  });

  it('停用时用户与角色端点回 RBAC_DISABLED(409)，只有 status 可读', async () => {
    const app = setup();
    const status = await app.request('/api/auth/status');
    expect(status.status).toBe(200);
    expect(await jsonOf<{ enabled: boolean; bootstrapped: boolean; sessionTimeoutMinutes: number }>(status)).toEqual({
      enabled: false,
      bootstrapped: false,
      sessionTimeoutMinutes: 240,
    });

    const calls: Array<Promise<Response>> = [
      post(app, '/api/auth/login', { username: 'boss', password: 'boss-pass-1' }),
      post(app, '/api/auth/bootstrap', { username: 'boss', password: 'boss-pass-1' }),
      app.request('/api/auth/me'),
      post(app, '/api/auth/password', { oldPassword: 'a-1234', password: 'b-1234' }),
      app.request('/api/auth/users'),
      post(app, '/api/auth/users', { username: 'bob', password: 'bob-pass-1' }),
      patch(app, '/api/auth/users/x', { status: 'disabled' }),
      del(app, '/api/auth/users/x'),
      app.request('/api/auth/roles'),
      post(app, '/api/auth/roles', { name: '质检员', grants: [] }),
      patch(app, '/api/auth/roles/role.worker', { name: 'x' }),
      del(app, '/api/auth/roles/role.worker'),
    ];
    for (const call of await Promise.all(calls)) {
      expect(call.status).toBe(409);
      expect((await jsonOf<{ code: string }>(call)).code).toBe('RBAC_DISABLED');
    }
    // 停用状态下角色也没被删掉：内置四角色仍在（档案保留）
    expect(ctx!.auth.roles()).toHaveLength(4);
  });
});

describe('authGuard：启用后才拦', () => {
  it('启用后无令牌访问业务端点 → 401 UNAUTHORIZED', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    expect(rbacEnabled(ctx!)).toBe(true);

    for (const url of ['/api/profile/snapshot', '/api/proposals', '/api/auth/me', '/api/auth/users']) {
      const res = await app.request(url);
      expect(res.status, url).toBe(401);
      expect((await jsonOf<{ code: string; message: string }>(res)).code).toBe('UNAUTHORIZED');
    }
    const proposed = await post(app, '/api/profile/propose', { patch: [], note: 'x' });
    expect(proposed.status).toBe(401);
  });

  it('公共路径与静态资源仍放行（登录页自己得打得开）', async () => {
    const app = setup();
    setRbacEnabled(ctx!);

    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/connection')).status).toBe(200);
    expect((await app.request('/api/sync/hello')).status).toBe(200);

    const status = await app.request('/api/auth/status');
    expect(status.status).toBe(200);
    expect(await jsonOf<{ enabled: boolean; bootstrapped: boolean }>(status)).toMatchObject({
      enabled: true,
      bootstrapped: false,
    });

    for (const url of ['/', '/index.html', '/users']) {
      const res = await app.request(url);
      expect(res.status, url).not.toBe(401);
    }
  });

  it('带经理令牌 → 200；令牌是垃圾 → 401', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const token = await login(app, 'boss', 'boss-pass-1');

    const ok = await app.request('/api/profile/snapshot', { headers: withToken(token) });
    expect(ok.status).toBe(200);
    const bad = await app.request('/api/profile/snapshot', { headers: withToken('garbage') });
    expect(bad.status).toBe(401);
    const noBearer = await app.request('/api/profile/snapshot', { headers: { authorization: token } });
    expect(noBearer.status).toBe(401);
  });

  it('库工没有 page:users → 403 FORBIDDEN，但登录本身没被拦', async () => {
    const app = setup();
    const worker = await enabledWithUsers(app, 'role.worker');
    const denied = await app.request('/api/auth/users', { headers: withToken(worker.other) });
    expect(denied.status).toBe(403);
    const body = await jsonOf<{ code: string; message: string }>(denied);
    expect(body.code).toBe('FORBIDDEN');
    expect(body.message).toContain('page:users');
    // 403 只发生在权限点名处：普通业务端点登录了就放行
    expect((await app.request('/api/profile/snapshot', { headers: withToken(worker.other) })).status).toBe(200);
    expect((await app.request('/api/auth/roles', { headers: withToken(worker.other) })).status).toBe(403);
  });

  it('审计与仓管员有 page:* → 用户列表放行（page:* 覆盖 page:users）', async () => {
    const app = setup();
    const auditor = await enabledWithUsers(app, 'role.auditor');
    const allowed = await app.request('/api/auth/users', { headers: withToken(auditor.other) });
    expect(allowed.status).toBe(200);
    expect((await jsonOf<{ total: number }>(allowed)).total).toBe(2);
    expect(hasPermission(grantsOf('role.keeper'), 'page:users')).toBe(true);
  });

  it('慢通道确认：没有 config.confirm 的角色 403，经理不是 403', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const manager = await login(app, 'boss', 'boss-pass-1');
    await post(app, '/api/auth/users', { username: 'staff', password: 'staff-pass-1', roleId: 'role.worker' }, withToken(manager));
    const worker = await login(app, 'staff', 'staff-pass-1');

    const patchOf = (): PatchOp[] => [
      { op: 'replace', path: '/modules/module.putaway/enabled', value: false },
    ];
    const first = ctx!.ws.profile.propose('user:tester', patchOf(), '库工想改配置');
    const denied = await post(app, `/api/proposals/${first.proposalId}/confirm`, {}, withToken(worker));
    expect(denied.status).toBe(403);
    expect((await jsonOf<{ code: string }>(denied)).code).toBe('FORBIDDEN');
    expect(ctx!.ws.profile.getSnapshot().modules['module.putaway']?.enabled).toBe(true);

    // 库工没有 config.propose：提案入口（POST /api/profile/propose）也拦下
    const proposeByWorker = await post(app, '/api/profile/propose', { patch: patchOf(), note: '库工想提案' }, withToken(worker));
    expect(proposeByWorker.status).toBe(403);
    expect((await jsonOf<{ code: string }>(proposeByWorker)).code).toBe('FORBIDDEN');

    const second = ctx!.ws.profile.propose('user:tester', patchOf(), '经理确认');
    const allowed = await post(app, `/api/proposals/${second.proposalId}/confirm`, {}, withToken(manager));
    expect(allowed.status).not.toBe(403);
    expect(allowed.status).toBe(200);
    expect(ctx!.ws.profile.getSnapshot().modules['module.putaway']?.enabled).toBe(false);
  });

  it('仓管员能提案（config.propose）但不能确认（config.confirm）', async () => {
    const app = setup();
    const keeper = await enabledWithUsers(app, 'role.keeper');
    const propose = await post(
      app,
      '/api/profile/propose',
      { patch: [{ op: 'replace', path: '/modules/module.putaway/enabled', value: false }], note: '仓管员提案' },
      withToken(keeper.other),
    );
    expect(propose.status).toBe(201);
    const { proposalId } = await jsonOf<{ proposalId: string }>(propose);
    const confirm = await post(app, `/api/proposals/${proposalId}/confirm`, {}, withToken(keeper.other));
    expect(confirm.status).toBe(403);
  });

  it('工具端点：审计（只读）调写工具 403，库工调未授权写工具 403、调已授权的不再是 403', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const manager = await login(app, 'boss', 'boss-pass-1');
    await post(app, '/api/auth/users', { username: 'auditor', password: 'audit-pass-1', roleId: 'role.auditor' }, withToken(manager));
    await post(app, '/api/auth/users', { username: 'worker', password: 'work-pass-1', roleId: 'role.worker' }, withToken(manager));
    const auditor = await login(app, 'auditor', 'audit-pass-1');
    const worker = await login(app, 'worker', 'work-pass-1');

    const workerGrants = grantsOf('role.worker');
    const deniedTool = ctx!.ws.tools
      .list()
      .find((tool) => tool.permission === 'write' && !hasPermission(workerGrants, `tool.write:${tool.id}`));
    expect(deniedTool).toBeDefined();
    const url = `/api/tools/${deniedTool!.id}/invoke`;

    const byAuditor = await post(app, url, {}, withToken(auditor));
    expect(byAuditor.status).toBe(403);
    const byWorker = await post(app, url, {}, withToken(worker));
    expect(byWorker.status).toBe(403);
    const byManager = await post(app, url, {}, withToken(manager));
    expect(byManager.status).not.toBe(403);

    // 库工被授权的那几类写操作不再被中间件拦（业务层自己判参数）
    const allowedUrl = '/api/tools/wms.picking.create/invoke';
    expect(requiredPermission('POST', allowedUrl, ctx!)).toBe('tool.write:wms.picking.create');
    expect((await post(app, allowedUrl, {}, withToken(worker))).status).not.toBe(403);
    expect((await post(app, allowedUrl, {}, withToken(auditor))).status).toBe(403);
  });

  it('关掉 rbac 后立刻回到全放行（免登录单人作业）', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    expect((await app.request('/api/profile/snapshot')).status).toBe(401);
    setRbacEnabled(ctx!, false);
    expect(rbacEnabled(ctx!)).toBe(false);
    expect((await app.request('/api/profile/snapshot')).status).toBe(200);
    // 用户档案保留不删
    expect((await jsonOf<{ enabled: boolean }>(await app.request('/api/auth/status'))).enabled).toBe(false);
  });
});

describe('/api/auth/*：登录门与账号管理', () => {
  it('status 三态：停用 → 启用 0 用户 → 建号后 bootstrapped', async () => {
    const app = setup();
    expect(await jsonOf(await app.request('/api/auth/status'))).toEqual({
      enabled: false,
      bootstrapped: false,
      sessionTimeoutMinutes: 240,
    });

    setRbacEnabled(ctx!);
    expect(await jsonOf(await app.request('/api/auth/status'))).toEqual({
      enabled: true,
      bootstrapped: false,
      sessionTimeoutMinutes: 240,
    });

    await bootstrap(app);
    expect(await jsonOf(await app.request('/api/auth/status'))).toEqual({
      enabled: true,
      bootstrapped: true,
      sessionTimeoutMinutes: 240,
    });

    setSessionTimeout(ctx!, 30);
    expect(await jsonOf<{ sessionTimeoutMinutes: number }>(await app.request('/api/auth/status'))).toMatchObject({
      sessionTimeoutMinutes: 30,
    });
  });

  it('bootstrap 建第一个账号：roleId 被强制成仓库经理，回视图带 roleName 与 grants', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    const view = await bootstrap(app, 'boss', 'boss-pass-1');
    expect(view).toMatchObject({
      username: 'boss',
      displayName: '仓库经理',
      roleId: 'role.manager',
      roleName: '仓库经理',
      status: 'active',
    });
    expect(view.grants).toEqual(['*']);
    expect(JSON.stringify(view)).not.toContain('passwordHash');
  });

  it('bootstrap 建号时传的 roleId 被忽略；第二次 → 409 AUTH_ALREADY_BOOTSTRAPPED', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    const res = await post(app, '/api/auth/bootstrap', {
      username: 'boss',
      password: 'boss-pass-1',
      roleId: 'role.worker',
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<UserView>(res)).roleId).toBe('role.manager');

    const again = await post(app, '/api/auth/bootstrap', { username: 'boss2', password: 'boss-pass-2' });
    expect(again.status).toBe(409);
    expect((await jsonOf<{ code: string }>(again)).code).toBe('AUTH_ALREADY_BOOTSTRAPPED');
    expect(ctx!.auth.users()).toHaveLength(1);
  });

  it('bootstrap 校验口令与账号：弱口令 / 非法账号 → 400，且不建号', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    const weak = await post(app, '/api/auth/bootstrap', { username: 'boss', password: '123' });
    expect(weak.status).toBe(400);
    expect((await jsonOf<{ code: string }>(weak)).code).toBe('AUTH_WEAK_PASSWORD');

    const badName = await post(app, '/api/auth/bootstrap', { username: '有 空格', password: 'boss-pass-1' });
    expect(badName.status).toBe(400);
    expect((await jsonOf<{ code: string }>(badName)).code).toBe('AUTH_BAD_USERNAME');

    const notJson = await app.request('/api/auth/bootstrap', { method: 'POST', body: '[]', headers: json });
    expect(notJson.status).toBe(400);
    expect(ctx!.auth.users()).toHaveLength(0);
  });

  it('login 成功拿 token 与用户面；错口令 → 401', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const res = await post(app, '/api/auth/login', { username: 'BOSS', password: 'boss-pass-1' });
    expect(res.status).toBe(200);
    const data = await jsonOf<{ token: string; expiresAt: number; user: UserView }>(res);
    expect(data.token.length).toBeGreaterThan(20);
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(data.user).toMatchObject({ username: 'boss', roleId: 'role.manager', roleName: '仓库经理' });

    const wrong = await post(app, '/api/auth/login', { username: 'boss', password: 'boss-pass-2' });
    expect(wrong.status).toBe(401);
    expect((await jsonOf<{ code: string }>(wrong)).code).toBe('AUTH_BAD_CREDENTIALS');
  });

  it('GET /me：带令牌回当前用户，不带令牌 401', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const token = await login(app, 'boss', 'boss-pass-1');

    const me = await app.request('/api/auth/me', { headers: withToken(token) });
    expect(me.status).toBe(200);
    expect((await jsonOf<{ user: UserView }>(me)).user).toMatchObject({ username: 'boss', grants: ['*'] });

    const anonymous = await app.request('/api/auth/me');
    expect(anonymous.status).toBe(401);
    expect((await jsonOf<{ code: string }>(anonymous)).code).toBe('UNAUTHORIZED');
  });

  it('POST /logout：令牌作废，之后的业务请求回到 401', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const token = await login(app, 'boss', 'boss-pass-1');
    expect((await app.request('/api/profile/snapshot', { headers: withToken(token) })).status).toBe(200);

    const res = await post(app, '/api/auth/logout', {}, withToken(token));
    expect(res.status).toBe(200);
    expect(await jsonOf<{ ok: boolean; username: string | null }>(res)).toEqual({ ok: true, username: 'boss' });
    expect((await app.request('/api/profile/snapshot', { headers: withToken(token) })).status).toBe(401);
    expect((await app.request('/api/auth/me', { headers: withToken(token) })).status).toBe(401);
  });

  it('POST /password：验旧口令，改完旧令牌失效、新口令能登录', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const token = await login(app, 'boss', 'boss-pass-1');

    const wrongOld = await post(app, '/api/auth/password', { oldPassword: 'nope-123', password: 'boss-pass-2' }, withToken(token));
    expect(wrongOld.status).toBe(401);
    expect((await jsonOf<{ code: string }>(wrongOld)).code).toBe('AUTH_BAD_CREDENTIALS');

    const weak = await post(app, '/api/auth/password', { oldPassword: 'boss-pass-1', password: '123' }, withToken(token));
    expect(weak.status).toBe(400);
    expect((await jsonOf<{ code: string }>(weak)).code).toBe('AUTH_WEAK_PASSWORD');

    const ok = await post(app, '/api/auth/password', { oldPassword: 'boss-pass-1', password: 'boss-pass-2' }, withToken(token));
    expect(ok.status).toBe(200);
    const result = await jsonOf<{ ok: boolean; sessionsDropped: number }>(ok);
    expect(result.ok).toBe(true);
    expect(result.sessionsDropped).toBeGreaterThanOrEqual(1);

    // 旧令牌当场失效（顶号防护）
    expect((await app.request('/api/profile/snapshot', { headers: withToken(token) })).status).toBe(401);
    const oldLogin = await post(app, '/api/auth/login', { username: 'boss', password: 'boss-pass-1' });
    expect(oldLogin.status).toBe(401);
    const fresh = await login(app, 'boss', 'boss-pass-2');
    expect((await app.request('/api/auth/me', { headers: withToken(fresh) })).status).toBe(200);

    // 无令牌改口令 → 401
    expect((await post(app, '/api/auth/password', { oldPassword: 'boss-pass-2', password: 'boss-pass-3' })).status).toBe(401);
  });

  it('用户 CRUD：列表 / 新建 / 停用他人 / 删除；停用后登不进来', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const manager = await login(app, 'boss', 'boss-pass-1');

    const list = await app.request('/api/auth/users', { headers: withToken(manager) });
    expect(list.status).toBe(200);
    expect(await jsonOf<{ rows: UserView[]; total: number }>(list)).toMatchObject({ total: 1 });

    const created = await post(
      app,
      '/api/auth/users',
      { username: 'bob', displayName: '老 Bob', password: 'bob-pass-1', roleId: 'role.worker', node: 'n2' },
      withToken(manager),
    );
    expect(created.status).toBe(200);
    const bob = await jsonOf<UserView>(created);
    expect(bob).toMatchObject({ username: 'bob', displayName: '老 Bob', roleId: 'role.worker', roleName: '库工', node: 'n2' });

    const dup = await post(app, '/api/auth/users', { username: 'bob', password: 'bob-pass-2' }, withToken(manager));
    expect(dup.status).toBe(409);
    expect((await jsonOf<{ code: string }>(dup)).code).toBe('AUTH_USER_TAKEN');

    const badRole = await post(app, '/api/auth/users', { username: 'carl', password: 'carl-pass-1', roleId: 'role.ghost' }, withToken(manager));
    expect(badRole.status).toBe(400);

    const bobToken = await login(app, 'bob', 'bob-pass-1');
    const disabled = await patch(app, `/api/auth/users/${bob.id}`, { status: 'disabled' }, withToken(manager));
    expect(disabled.status).toBe(200);
    expect((await jsonOf<UserView>(disabled)).status).toBe('disabled');
    // 停用当场生效：已有会话作废 + 登录被拒
    expect((await app.request('/api/profile/snapshot', { headers: withToken(bobToken) })).status).toBe(401);
    const relogin = await post(app, '/api/auth/login', { username: 'bob', password: 'bob-pass-1' });
    expect(relogin.status).toBe(403);
    expect((await jsonOf<{ code: string }>(relogin)).code).toBe('AUTH_USER_DISABLED');

    const renamed = await patch(app, `/api/auth/users/${bob.id}`, { displayName: 'Bob 师傅', roleId: 'role.keeper' }, withToken(manager));
    expect(await jsonOf<UserView>(renamed)).toMatchObject({ displayName: 'Bob 师傅', roleName: '仓管员' });

    const badStatus = await patch(app, `/api/auth/users/${bob.id}`, { status: 'gone' }, withToken(manager));
    expect(badStatus.status).toBe(400);

    expect((await del(app, `/api/auth/users/${bob.id}`, withToken(manager))).status).toBe(200);
    const missing = await del(app, `/api/auth/users/${bob.id}`, withToken(manager));
    expect(missing.status).toBe(404);
    expect((await jsonOf<{ code: string }>(missing)).code).toBe('AUTH_USER_MISSING');
    expect((await jsonOf<{ total: number }>(await app.request('/api/auth/users', { headers: withToken(manager) }))).total).toBe(1);
  });

  it('不许对自己下手：AUTH_SELF_DISABLE / AUTH_SELF_DELETE', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    const me = await bootstrap(app);
    const manager = await login(app, 'boss', 'boss-pass-1');

    const selfDisable = await patch(app, `/api/auth/users/${me.id}`, { status: 'disabled' }, withToken(manager));
    expect(selfDisable.status).toBe(400);
    expect((await jsonOf<{ code: string }>(selfDisable)).code).toBe('AUTH_SELF_DISABLE');

    const selfDelete = await del(app, `/api/auth/users/${me.id}`, withToken(manager));
    expect(selfDelete.status).toBe(400);
    expect((await jsonOf<{ code: string }>(selfDelete)).code).toBe('AUTH_SELF_DELETE');

    expect(ctx!.auth.users()).toHaveLength(1);
    expect(ctx!.auth.getUser(me.id)?.status).toBe('active');
  });

  it('角色 CRUD：新建 / 改授权 / 删除；内置角色 → AUTH_ROLE_BUILTIN，在用的 → AUTH_ROLE_IN_USE', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app);
    const manager = await login(app, 'boss', 'boss-pass-1');

    const list = await app.request('/api/auth/roles', { headers: withToken(manager) });
    expect(list.status).toBe(200);
    const roles = await jsonOf<{ rows: Array<{ id: string; builtin: boolean }>; total: number }>(list);
    expect(roles.total).toBe(4);
    expect(roles.rows.every((role) => role.builtin)).toBe(true);

    const created = await post(app, '/api/auth/roles', { name: '质检员', description: '只管质检', grants: ['page:scenario', 'tool.read:*'] }, withToken(manager));
    expect(created.status).toBe(200);
    const role = await jsonOf<{ id: string; name: string; builtin: boolean; grants: string[] }>(created);
    expect(role).toMatchObject({ name: '质检员', builtin: false, grants: ['page:scenario', 'tool.read:*'] });

    const badGrants = await post(app, '/api/auth/roles', { name: '坏角色', grants: ['BAD grant'] }, withToken(manager));
    expect(badGrants.status).toBe(400);
    const notArray = await post(app, '/api/auth/roles', { name: '坏角色', grants: 'page:*' }, withToken(manager));
    expect(notArray.status).toBe(400);

    const updated = await patch(app, `/api/auth/roles/${role.id}`, { grants: ['page:*'], description: '放宽到全部页面' }, withToken(manager));
    expect(updated.status).toBe(200);
    expect(await jsonOf<{ grants: string[]; description: string }>(updated)).toMatchObject({
      grants: ['page:*'],
      description: '放宽到全部页面',
    });

    // 内置角色可以改授权，但不能删
    expect((await patch(app, '/api/auth/roles/role.worker', { grants: ['page:*'] }, withToken(manager))).status).toBe(200);
    const builtin = await del(app, '/api/auth/roles/role.manager', withToken(manager));
    expect(builtin.status).toBe(400);
    expect((await jsonOf<{ code: string }>(builtin)).code).toBe('AUTH_ROLE_BUILTIN');
    expect(ctx!.auth.getRole('role.manager')).toBeDefined();

    // 挂着用户的自建角色删不掉
    const staff = await jsonOf<UserView>(
      await post(app, '/api/auth/users', { username: 'staff', password: 'staff-pass-1', roleId: role.id }, withToken(manager)),
    );
    const inUse = await del(app, `/api/auth/roles/${role.id}`, withToken(manager));
    expect(inUse.status).toBe(400);
    expect((await jsonOf<{ code: string }>(inUse)).code).toBe('AUTH_ROLE_IN_USE');

    expect((await patch(app, `/api/auth/users/${staff.id}`, { roleId: 'role.worker' }, withToken(manager))).status).toBe(200);
    expect(await jsonOf<{ ok: boolean }>(await del(app, `/api/auth/roles/${role.id}`, withToken(manager)))).toEqual({ ok: true });
    expect(ctx!.auth.getRole(role.id)).toBeUndefined();
  });

  it('落盘模式（authPath）：重启后账号还在，不用再 bootstrap', async () => {
    const path = join(freshTmpDir(), 'users.json');
    const firstApp = setup({ authPath: path });
    expect(ctx!.auth.path).toBe(path);
    setRbacEnabled(ctx!);
    await bootstrap(firstApp);
    ctx!.close();
    ctx = undefined;

    // 「重启」：同一路径重新装配，rbac 开关与账号都读回来了
    const secondApp = setup({ authPath: path });
    setRbacEnabled(ctx!); // profile 是 :memory:，模块开关不跨进程，这里只补上开关
    const status = await jsonOf<{ enabled: boolean; bootstrapped: boolean; sessionTimeoutMinutes: number }>(
      await secondApp.request('/api/auth/status'),
    );
    expect(status).toEqual({ enabled: true, bootstrapped: true, sessionTimeoutMinutes: 240 });
    const token = await login(secondApp, 'boss', 'boss-pass-1');
    expect((await secondApp.request('/api/auth/me', { headers: withToken(token) })).status).toBe(200);
  });
});

describe('actor：谁做的每一步记进操作日志', () => {
  const slowChannelPatch = (): PatchOp[] => [
    { op: 'replace', path: '/modules/module.putaway/enabled', value: false },
  ];

  it('停用时仍是 user:local@{nodeId}（提议不落事件，确认才落账）', async () => {
    const app = setup();
    const propose = await post(app, '/api/profile/propose', { patch: slowChannelPatch(), note: '单人作业改配置' });
    expect(propose.status).toBe(201);
    const { proposalId } = await jsonOf<{ proposalId: string }>(propose);
    expect((await post(app, `/api/proposals/${proposalId}/confirm`, {})).status).toBe(200);

    const actor = `user:local@${ctx!.core.nodeId}`;
    const detail = await jsonOf<{ proposedBy: string }>(await app.request(`/api/proposals/${proposalId}`));
    expect(detail.proposedBy).toBe(actor);

    const events = ctx!.core.sync.eventsFor(ctx!.workspaceId, actor, 0).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actor === actor)).toBe(true);
  });

  it('启用并带令牌时落到 user:{username}@{nodeId}', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    await bootstrap(app, 'boss', 'boss-pass-1');
    const manager = await login(app, 'boss', 'boss-pass-1');

    const propose = await post(
      app,
      '/api/profile/propose',
      { patch: slowChannelPatch(), note: '经理改配置' },
      withToken(manager),
    );
    expect(propose.status).toBe(201);
    const { proposalId } = await jsonOf<{ proposalId: string }>(propose);
    expect((await post(app, `/api/proposals/${proposalId}/confirm`, {}, withToken(manager))).status).toBe(200);

    const actor = `user:boss@${ctx!.core.nodeId}`;
    const detail = await jsonOf<{ proposedBy: string }>(
      await app.request(`/api/proposals/${proposalId}`, { headers: withToken(manager) }),
    );
    expect(detail.proposedBy).toBe(actor);

    const events = ctx!.core.sync.eventsFor(ctx!.workspaceId, actor, 0).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actor === actor)).toBe(true);
    // 没有令牌的那条路走不通，日志里也就不会有 user:local 的账
    expect(ctx!.core.sync.eventsFor(ctx!.workspaceId, `user:local@${ctx!.core.nodeId}`, 0).events).toEqual([]);
  });

  it('启用但请求没带令牌 → 被拦在中间件，不产生 user:local 事件', async () => {
    const app = setup();
    setRbacEnabled(ctx!);
    expect((await post(app, '/api/profile/propose', { patch: slowChannelPatch(), note: 'x' })).status).toBe(401);
    expect(ctx!.core.sync.eventsFor(ctx!.workspaceId, `user:local@${ctx!.core.nodeId}`, 0).events).toEqual([]);
  });
});
