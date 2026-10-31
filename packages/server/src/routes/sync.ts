import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { runSyncRound, type SyncRoundResult } from '../sync/sync-client.js';

/**
 * 同步端点（拉模型，协议见 ARCHITECTURE.md「同步回合」）：
 *  - GET  /hello          握手：nodeId / workspaceId / profileVersion / 水位 / 计数；
 *  - GET  /events/:actor  按 actor 区间供事件（fromSeq 闭起点，默认 500/页）；
 *  - POST /run            手动触发一轮拉取（body.peers ?? env ONE_SYNC_PEERS）。
 * 本文件只做参数解析与委托；账本操作在 core.sync，传输编排在 sync-client。
 */

/** 供事件分页的硬上限（防恶意/误配的大页请求） */
const MAX_PAGE_LIMIT = 1000;

export function syncRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/hello', (c) => c.json(ctx.core.sync.handshake(ctx.workspaceId)))
    .get('/events/:actor', (c) => {
      const fromSeq = Number(c.req.query('fromSeq'));
      if (!Number.isInteger(fromSeq) || fromSeq < 0) {
        return c.json({ code: 'SYNC_BAD_REQUEST', message: 'fromSeq 必须是非负整数' }, 400);
      }
      const limitRaw = c.req.query('limit');
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)) {
        return c.json(
          { code: 'SYNC_BAD_REQUEST', message: `limit 必须是 1..${MAX_PAGE_LIMIT} 的整数` },
          400,
        );
      }
      return c.json(ctx.core.sync.eventsFor(ctx.workspaceId, c.req.param('actor'), fromSeq, limit));
    })
    .post('/run', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { peers?: unknown };
      const raw = body.peers ?? process.env.ONE_SYNC_PEERS ?? [];
      const peers = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (peers.length === 0) {
        return c.json(
          { code: 'SYNC_NO_PEERS', message: '未配置同步节点（body.peers 或 ONE_SYNC_PEERS）' },
          400,
        );
      }

      const results: SyncRoundResult[] = [];
      for (const peer of peers) {
        try {
          results.push(
            await runSyncRound({
              peerBaseUrl: peer,
              workspaceId: ctx.workspaceId,
              core: ctx.core,
              ws: ctx.ws,
            }),
          );
        } catch (err) {
          // 单败不炸整轮：error 结果带 message，其余 peer 照常
          results.push({
            peer,
            status: 'error',
            pulled: 0,
            accepted: 0,
            skipped: 0,
            replayed: false,
            plan: [],
            theirProfileVersion: 0,
            myProfileVersion: 0,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return c.json({ results });
    });
}
