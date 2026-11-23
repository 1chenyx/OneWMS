import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../context.js';
import {
  AuthError,
  validatePassword,
  validateUsername,
  type PublicUser,
} from '../rbac/auth-store.js';
import { sanitizeGrants } from '../rbac/permissions.js';
import { rbacEnabled, sessionTtlMs, type AuthEnv } from '../rbac/auth-middleware.js';

/**
 * 登录与用户角色端点（module.rbac）。
 *
 * rbac 停用时这些端点全都回 `RBAC_DISABLED`——账号体系整体不在场，
 * 界面也不显示用户页（前端按 `modules['module.rbac'].enabled` 门控）。
 *
 * 例外是 `GET /status` 与 `POST /bootstrap`：
 *  - status 是登录门要先问的「现在要不要登录」，必须始终可读；
 *  - bootstrap 只在**一个用户都还没有**时可用，用来建第一个仓库经理。
 *    没有它就锁死了：启用 rbac 之后谁也登不进来。建完立即失效。
 */

/** 出接口用的用户面：带角色名，省得前端再拼一次 */
interface UserView extends PublicUser {
  roleName: string;
  grants: string[];
}

function requireEnabled(ctx: AppContext, c: Context) {
  if (rbacEnabled(ctx)) return null;
  return c.json(
    { code: 'RBAC_DISABLED', message: '用户与角色模块没启用，当前是免登录单人模式' },
    409,
  );
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed = (await c.req.json().catch(() => null)) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthError('BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function str(raw: unknown, max: number): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new AuthError('BAD_REQUEST', '字段必须是字符串');
  const value = Array.from(raw.trim()).slice(0, max).join('');
  return value;
}

export function authRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const view = (user: PublicUser): UserView => {
    const role = ctx.auth.getRole(user.roleId);
    return { ...user, roleName: role?.name ?? user.roleId, grants: role ? [...role.grants] : [] };
  };

  const run = async (c: Context, fn: () => unknown | Promise<unknown>) => {
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ code: err.code, message: err.message }, err.status as 400);
      }
      throw err;
    }
  };

  /** 登录门第一问：要不要登录、能不能自助建第一个账号 */
  app.get('/status', (c) =>
    c.json({
      enabled: rbacEnabled(ctx),
      bootstrapped: ctx.auth.users().length > 0,
      sessionTimeoutMinutes: Math.round(sessionTtlMs(ctx) / 60_000),
    }),
  );

  app.post('/bootstrap', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    if (ctx.auth.users().length > 0) {
      return c.json({ code: 'AUTH_ALREADY_BOOTSTRAPPED', message: '已经有用户了，请让管理员建账号' }, 409);
    }
    return run(c, async () => {
      const raw = await body(c);
      const created = ctx.auth.createUser({
        username: validateUsername(raw.username),
        displayName: str(raw.displayName, 60),
        // 第一个账号必须是仓库经理：只有它有 config.confirm，
        // 否则没人能确认「把 rbac 再关掉」这条提案，等于把自己锁在门外。
        roleId: 'role.manager',
        password: validatePassword(raw.password),
        node: str(raw.node, 80),
      });
      return view(created);
    });
  });

  app.post('/login', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return run(c, async () => {
      const raw = await body(c);
      const username = validateUsername(raw.username);
      const password = validatePassword(String(raw.password ?? ''));
      const result = ctx.auth.login(username, password, sessionTtlMs(ctx));
      return { token: result.token, expiresAt: result.expiresAt, user: view(result.user) };
    });
  });

  app.post('/logout', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const user = c.get('authUser');
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (token) ctx.auth.logout(token);
    return c.json({ ok: true, username: user?.username ?? null });
  });

  app.get('/me', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const user = c.get('authUser');
    if (!user) return c.json({ code: 'UNAUTHORIZED', message: '请先登录' }, 401);
    return c.json({ user: view(user) });
  });

  app.post('/password', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const current = c.get('authUser');
    if (!current) return c.json({ code: 'UNAUTHORIZED', message: '请先登录' }, 401);
    return run(c, async () => {
      const raw = await body(c);
      const oldPassword = validatePassword(String(raw.oldPassword ?? ''));
      const newPassword = validatePassword(raw.password);
      const stored = ctx.auth.findByUsername(current.username);
      if (!stored) throw new AuthError('AUTH_USER_MISSING', '用户不存在', 404);
      // 改自己的口令要先验旧的，否则捡到别人没锁屏的浏览器就能顶号
      ctx.auth.login(current.username, oldPassword, sessionTtlMs(ctx));
      ctx.auth.updateUser(stored.id, { password: newPassword });
      const dropped = ctx.auth.logoutUser(stored.id);
      return { ok: true, sessionsDropped: dropped };
    });
  });

  app.get('/users', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return c.json({ rows: ctx.auth.users().map(view), total: ctx.auth.users().length });
  });

  app.post('/users', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return run(c, async () => {
      const raw = await body(c);
      const created = ctx.auth.createUser({
        username: validateUsername(raw.username),
        displayName: str(raw.displayName, 60),
        roleId: str(raw.roleId, 80) ?? 'role.worker',
        password: validatePassword(raw.password),
        node: str(raw.node, 80),
      });
      return view(created);
    });
  });

  app.patch('/users/:id', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const id = c.req.param('id');
    const actor = c.get('authUser');
    return run(c, async () => {
      const raw = await body(c);
      const status = raw.status === undefined ? undefined : str(raw.status, 20);
      if (status !== undefined && status !== 'active' && status !== 'disabled') {
        throw new AuthError('BAD_REQUEST', 'status 只能是 active 或 disabled');
      }
      // 不许把自己停用：停用了就没人能再登进来改回去（唯一的仓库经理尤其如此）
      if (status === 'disabled' && actor?.id === id) {
        throw new AuthError('AUTH_SELF_DISABLE', '不能停用自己正在用的账号');
      }
      const updated = ctx.auth.updateUser(id, {
        ...(raw.displayName === undefined ? {} : { displayName: str(raw.displayName, 60) }),
        ...(raw.roleId === undefined ? {} : { roleId: str(raw.roleId, 80)! }),
        ...(raw.node === undefined ? {} : { node: str(raw.node, 80) }),
        ...(status === undefined ? {} : { status: status as 'active' | 'disabled' }),
        ...(raw.password === undefined ? {} : { password: validatePassword(raw.password) }),
      });
      return view(updated);
    });
  });

  app.delete('/users/:id', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const id = c.req.param('id');
    const actor = c.get('authUser');
    if (actor?.id === id) {
      return c.json({ code: 'AUTH_SELF_DELETE', message: '不能删掉自己正在用的账号' }, 400);
    }
    if (!ctx.auth.removeUser(id)) {
      return c.json({ code: 'AUTH_USER_MISSING', message: '用户不存在' }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/roles', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return c.json({ rows: ctx.auth.roles(), total: ctx.auth.roles().length });
  });

  app.post('/roles', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return run(c, async () => {
      const raw = await body(c);
      const grants = sanitizeGrants(raw.grants);
      if (grants === undefined) throw new AuthError('BAD_REQUEST', 'grants 必须是合法的权限模式数组');
      return ctx.auth.createRole({
        name: str(raw.name, 60) ?? '',
        description: str(raw.description, 300),
        grants,
      });
    });
  });

  app.patch('/roles/:id', async (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    const id = c.req.param('id');
    return run(c, async () => {
      const raw = await body(c);
      const grants = raw.grants === undefined ? undefined : sanitizeGrants(raw.grants);
      if (grants === undefined && raw.grants !== undefined) {
        throw new AuthError('BAD_REQUEST', 'grants 必须是合法的权限模式数组');
      }
      return ctx.auth.updateRole(id, {
        ...(raw.name === undefined ? {} : { name: str(raw.name, 60) ?? '' }),
        ...(raw.description === undefined ? {} : { description: str(raw.description, 300) ?? '' }),
        ...(grants === undefined ? {} : { grants }),
      });
    });
  });

  app.delete('/roles/:id', (c) => {
    const blocked = requireEnabled(ctx, c);
    if (blocked) return blocked;
    return run(c, () => {
      const removed = ctx.auth.removeRole(c.req.param('id'));
      if (!removed) throw new AuthError('AUTH_ROLE_BUILTIN', '内置角色不能删，可以改它的授权', 400);
      return { ok: true };
    });
  });

  return app;
}
