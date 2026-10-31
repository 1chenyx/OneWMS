import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/**
 * 提议确认端点——人类的确认入口（REST），永不注册为 AI 工具
 * （§4.1 确认权不可委托的传输层落实：AI 经 /api/chat 走工具总线，拿不到这里）。
 */
export function proposalRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => c.json(ctx.ws.profile.listPending()))
    .get('/:id', (c) => c.json(ctx.ws.profile.getProposal(c.req.param('id'))))
    .post('/:id/confirm', async (c) => {
      const body = await c.req.json().catch(() => ({}) as { by?: string });
      // 默认确认者带节点后缀（同步通道唯一）；body.by 预留未来多用户身份
      const by = typeof body.by === 'string' && body.by ? body.by : `user:local@${ctx.core.nodeId}`;
      const result = ctx.ws.profile.confirm(c.req.param('id'), by);
      return c.json(result);
    })
    .post('/:id/reject', async (c) => {
      ctx.ws.profile.reject(c.req.param('id'));
      return c.json({ ok: true });
    });
}
