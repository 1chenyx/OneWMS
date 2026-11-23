import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../context.js';
import { DEFAULT_SESSION_TIMEOUT_MINUTES, type PublicUser } from './auth-store.js';
import { hasPermission } from './permissions.js';

/**
 * 鉴权中间件（module.rbac）。
 *
 * **停用即整体放行**：rbac 默认停用，此时单人本地作业免登录，行为和从前一模一样。
 * 只有 profile 里 `modules['module.rbac'].enabled === true` 才拦。
 *
 * 拦的范围只有 `/api/*`，静态资源（含登录页自己）永远放行，否则界面打不开。
 * `/api/sync`（节点间拉取，靠 workspaceId 握手）和 `/api/integrations`
 * （外部系统 webhook，各自带自己的密钥）也不拦——这两条不是人在浏览器里点的。
 *
 * 权限判定分两档：
 *  - 「要登录」：绝大多数端点。登录了就放行，具体能不能改由业务层与工具白名单管。
 *  - 「要某项权限」：配置慢通道、工具调用、用户与角色管理这几处按权限对象点名。
 *
 * `report.export` 不在这里点名——导出是浏览器里点按钮生成文件，没有独立端点，
 * 由前端按权限藏按钮。
 */

export type AuthEnv = { Variables: { authUser: PublicUser | undefined } };

/** rbac 模块是否启用（未安装 / 已停用都算 false） */
export function rbacEnabled(ctx: AppContext): boolean {
  return ctx.ws.profile.getSnapshot().modules['module.rbac']?.enabled === true;
}

/** 会话滑动过期窗口（毫秒），读 module.rbac 的 sessionTimeoutMinutes */
export function sessionTtlMs(ctx: AppContext): number {
  const raw = ctx.ws.profile.getSnapshot().modules['module.rbac']?.settings?.sessionTimeoutMinutes;
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
      ? Math.floor(raw)
      : DEFAULT_SESSION_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/** 不需要登录就能访问的路径前缀 */
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/connection',
  '/api/sync',
  '/api/integrations',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/bootstrap',
] as const;

export function isPublicPath(path: string): boolean {
  if (!path.startsWith('/api/')) return true; // 静态资源与 SPA 入口
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * 这个请求点名要哪项权限；null = 只要登录。
 * 顺序即优先级：先匹配到先算。
 */
export function requiredPermission(method: string, path: string, ctx: AppContext): string | null {
  if (path.startsWith('/api/auth/users') || path.startsWith('/api/auth/roles')) return 'page:users';

  // 提案入口在 profile 路由下（POST /api/profile/propose），拍板在 proposals 路由下。
  // 确认与否决都是「决定慢通道走向」的动作，一律要 config.confirm。
  if (path === '/api/profile/propose' || path === '/api/profile/propose/') {
    return 'config.propose';
  }
  if (path.startsWith('/api/proposals')) {
    if (method !== 'POST') return null;
    return /\/(confirm|reject)\/?$/.test(path) ? 'config.confirm' : 'config.propose';
  }

  const tool = /^\/api\/tools\/([^/]+)\/(invoke|confirm)\/?$/.exec(path);
  if (tool) {
    const toolId = decodeURIComponent(tool[1]!);
    const declared = ctx.ws.tools.list().find((item) => item.id === toolId);
    // 工具不在总线上（模块没装 / id 打错）时不给权限名——让端点自己回 404
    if (!declared) return null;
    return declared.permission === 'write' ? `tool.write:${toolId}` : `tool.read:${toolId}`;
  }

  return null;
}

export function bearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

export function authGuard(ctx: AppContext): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set('authUser', undefined);
    if (!rbacEnabled(ctx)) return next();
    const path = c.req.path;
    if (isPublicPath(path)) return next();

    const token = bearerToken(c.req.header('authorization'));
    const found = token ? ctx.auth.session(token, sessionTtlMs(ctx)) : undefined;
    if (!found) {
      return c.json({ code: 'UNAUTHORIZED', message: '请先登录' }, 401);
    }
    c.set('authUser', found.user);

    const permission = requiredPermission(c.req.method, path, ctx);
    if (permission !== null) {
      const role = ctx.auth.getRole(found.user.roleId);
      const grants = role?.grants ?? [];
      if (!hasPermission(grants, permission)) {
        return c.json({ code: 'FORBIDDEN', message: `没有权限：${permission}` }, 403);
      }
    }
    return next();
  };
}
