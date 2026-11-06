import { Hono } from 'hono';
import { readMemorySettings, type MemoryScope } from '@one/memory';
import type { AppContext } from '../context.js';

/**
 * AI 记忆管理端点（读写分治，契约同 wms.ts / agents.ts）：
 *  - GET  /                  读 = 直查记忆投影 + 当前生效设置（含兜底窄化值）；
 *  - POST /                  写 = 经工具总线 memory.save（护栏 + 审计免费）；
 *  - POST /:id/forget        写 = 经工具总线 memory.forget；
 *  - POST /settings/propose  设置改动走慢通道（profile.propose → 人工确认，
 *                            与 AI/助手定义同一条通道——配置变更铁律）。
 * 人操作 actor = user:local@{nodeId}（source 推导为 'manual'，与 AI 通道审计可辨）。
 */

/** 人操作界面的 actor（带节点后缀：审计可辨「人做的」，且同步通道节点唯一） */
function actorOf(ctx: AppContext): string {
  return `user:local@${ctx.core.nodeId}`;
}

export function memoryRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => {
      const q = c.req.query('scope');
      const scope: MemoryScope | undefined = q === 'personal' || q === 'project' ? q : undefined;
      ctx.memory.sync(); // 读前追账（同步/后台提取可能落后投影）
      return c.json({
        memories: ctx.memory.memory.list(scope),
        settings: readMemorySettings(ctx.memory),
      });
    })
    .post('/', async (c) => {
      const body = await c.req.json().catch(() => ({}) as { scope?: unknown; content?: unknown });
      return c.json(
        await ctx.ws.tools.invoke(
          'memory.save',
          { scope: body.scope, content: body.content },
          actorOf(ctx),
        ),
        201,
      );
    })
    .post('/:id/forget', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'memory.forget',
          { memoryId: c.req.param('id') },
          actorOf(ctx),
        ),
      ),
    )
    .post('/settings/propose', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        autoMemory?: unknown;
        maxMemoryItems?: unknown;
        note?: unknown;
      };
      // 只 patch 显式提供的键（autoMemory / maxMemoryItems 二选一或同时）
      const patch: { op: 'replace'; path: string; value: unknown }[] = [];
      if (body.autoMemory !== undefined) {
        if (typeof body.autoMemory !== 'boolean') {
          return c.json({ code: 'BAD_REQUEST', message: 'autoMemory 必须是布尔值' }, 400);
        }
        patch.push({ op: 'replace', path: '/modules/core.memory/settings/autoMemory', value: body.autoMemory });
      }
      if (body.maxMemoryItems !== undefined) {
        if (typeof body.maxMemoryItems !== 'number' || !Number.isInteger(body.maxMemoryItems) || body.maxMemoryItems < 1) {
          return c.json({ code: 'BAD_REQUEST', message: 'maxMemoryItems 必须是 ≥1 的整数' }, 400);
        }
        patch.push({
          op: 'replace',
          path: '/modules/core.memory/settings/maxMemoryItems',
          value: body.maxMemoryItems,
        });
      }
      if (patch.length === 0) {
        return c.json(
          { code: 'BAD_REQUEST', message: '至少提供 autoMemory 或 maxMemoryItems 之一' },
          400,
        );
      }
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : '更新 AI 记忆设置';
      const result = await ctx.ws.tools.invoke(
        'profile.propose',
        { patch, note },
        actorOf(ctx),
      );
      return c.json(result, 201);
    });
}
