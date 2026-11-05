import { Hono } from 'hono';
import { AI_MODULE_ID, readAgentDefs } from '@one/ai';
import type { AppContext } from '../context.js';

/**
 * AI 助手管理端点（M16）：
 *  - GET /api/agents：定义清单（readAgentDefs——配置面或内置兜底）+
 *    工具总线目录（元数据；管理页勾选授权的数据源）；
 *  - POST /api/agents/propose：以「人操作」actor 走工具总线 profile.propose，
 *    patch 整体 replace /modules/core.ai/settings/agents——与 AI 经 chat 的
 *    提议同一条慢通道（propose → confirm），确认权在人类（§4.1）。
 *
 * 权限收敛点（v2 生长点）：v1 本地单用户直接放行；引入角色/多用户后，
 * 「配置 AI」是高权限动作，此处按 actor 身份收敛（allowedRoles 的消费方）。
 */
export function agentRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) =>
      c.json({
        agents: readAgentDefs(ctx.ws),
        tools: ctx.ws.tools.list().map(({ id, label, description, permission }) => ({
          id,
          label,
          description,
          permission,
        })),
      }),
    )
    .post('/propose', async (c) => {
      const body = await c.req.json().catch(() => ({}) as { agents?: unknown; note?: unknown });
      if (!Array.isArray(body.agents)) {
        return c.json({ code: 'BAD_REQUEST', message: 'agents 必须是数组' }, 400);
      }
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : '更新 AI 助手定义';
      // 与管理页其他写操作同模式（wms.ts）：人操作走 user:local actor，
      // 经工具总线（护栏 + 审计免费）；与 AI 通道的 actor=ai:{id} 审计可辨
      const result = await ctx.ws.tools.invoke(
        'profile.propose',
        {
          patch: [{ op: 'replace', path: `/modules/${AI_MODULE_ID}/settings/agents`, value: body.agents }],
          note,
        },
        `user:local@${ctx.core.nodeId}`,
      );
      return c.json(result, 201);
    });
}
