import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/**
 * GET /api/profile/snapshot —— Profile 快照（确认界面的「现状」数据源）。
 * POST /api/profile/propose（M21）—— 设置页「流程与模块」的慢通道入口：
 * 经工具总线走 profile.propose（校验管线 + 影响报告免费），actor=user:local。
 * 与 AI 的提议同一队列（GET /api/proposals 待确认列表）；confirm/reject
 * 走 /api/proposals/:id/confirm|reject——确认权在用户，永不注册为工具（§4.1）。
 */
export function profileRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/snapshot', (c) => c.json(ctx.ws.profile.getSnapshot()))
    .post('/propose', async (c) => {
      const body = (await c.req.json()) as { patch?: unknown; note?: string };
      return c.json(
        await ctx.ws.tools.invoke(
          'profile.propose',
          { patch: body.patch, note: body.note },
          `user:local@${ctx.core.nodeId}`,
        ),
        201,
      );
    });
}
