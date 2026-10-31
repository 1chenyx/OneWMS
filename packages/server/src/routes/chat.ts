import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/**
 * POST /api/chat —— AI 快通道入口（v1 非流式：agent.run 跑完一次性返回）。
 * 对话历史仅前端展示、不回传（单轮任务式，与 agent.ts 既有语义一致）。
 */
export function chatRoutes(ctx: AppContext): Hono {
  return new Hono().post('/', async (c) => {
    if (!ctx.agent) {
      return c.json(
        { code: 'AI_NOT_CONFIGURED', message: '未配置 AI（需设置 ONE_AI_MODEL 等环境变量）' },
        503,
      );
    }
    const body = await c.req.json().catch(() => ({}) as { message?: unknown });
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return c.json({ code: 'BAD_REQUEST', message: 'message 不能为空' }, 400);
    }
    const result = await ctx.agent.run(message);
    return c.json(result);
  });
}
