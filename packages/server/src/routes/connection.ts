import { Hono } from 'hono';
import { normalizePlatformBaseUrl } from '../connection/connection-store.js';
import type { AppContext } from '../context.js';

/**
 * 连接方式只留在本机。平台模式下其余 /api 会被转发，这条不能跟着走，
 * 否则界面改不回局域网。
 *
 * GET  /api/connection  当前 mode 与平台根地址
 * PUT  /api/connection  { mode: 'lan' | 'platform', platformBaseUrl? }
 */
export function connectionRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => c.json(ctx.connection.view()))
    .put('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { mode?: unknown; platformBaseUrl?: unknown } | null;
      if (body === null || typeof body !== 'object') {
        return c.json({ code: 'BAD_REQUEST', message: '连接设置不是对象' }, 400);
      }
      if (body.mode !== 'lan' && body.mode !== 'platform') {
        return c.json({ code: 'BAD_REQUEST', message: 'mode 只能是 lan 或 platform' }, 400);
      }
      let platformBaseUrl = ctx.connection.current().platformBaseUrl;
      const hasUrl = typeof body.platformBaseUrl === 'string' && body.platformBaseUrl.trim() !== '';
      if (body.mode === 'platform' || hasUrl) {
        const parsed = normalizePlatformBaseUrl(body.platformBaseUrl);
        if (!parsed.ok) return c.json({ code: 'CONNECTION_BAD_URL', message: parsed.message }, 400);
        platformBaseUrl = parsed.url;
      }
      if (body.mode === 'platform' && !platformBaseUrl) {
        return c.json({ code: 'CONNECTION_BAD_URL', message: '连接平台要填写平台根地址' }, 400);
      }
      return c.json(ctx.connection.set({ mode: body.mode, platformBaseUrl }));
    });
}
