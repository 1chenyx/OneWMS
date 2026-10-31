import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { SealedEvent } from '@one/core';
import { RelayStore } from './relay-store.js';

/**
 * 云中继 HTTP 契约（DESIGN §8.8，里程碑 7）。
 *
 * 独立 Hono 应用（`npm run start:relay` 部署到 VPS）：
 *  - 不装配 OneCore、不开数据库——「中继不碰业务数据」由依赖面保证；
 *  - 内存暂存密文（RelayStore），重启即清，节点按水位差额自动重推；
 *  - hello / events 与节点 sync 端点同构（分页/水位/指纹契约一致），
 *    push 是中继特有的写入面（节点把账本推上汇聚点）。
 *
 * 本文件只做参数解析与委托；存储语义在 RelayStore。
 */

/** push 批大小硬上限（与节点供事件分页上限一致，防滥用） */
const MAX_PUSH_BATCH = 1000;
const MAX_PAGE_LIMIT = 1000;

export function createRelayApp(opts?: { relayNodeId?: string; store?: RelayStore }): Hono {
  const store = opts?.store ?? new RelayStore();
  const relayNodeId = opts?.relayNodeId ?? `relay-${randomUUID().slice(0, 8)}`;

  const app = new Hono();

  app.get('/relay/hello', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: '缺少 workspaceId 查询参数' }, 400);
    }
    return c.json(store.hello(workspaceId, relayNodeId));
  });

  app.get('/relay/events/:actor', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: '缺少 workspaceId 查询参数' }, 400);
    }
    const fromSeq = Number(c.req.query('fromSeq'));
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: 'fromSeq 必须是非负整数' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? 500 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: `limit 必须是 1..${MAX_PAGE_LIMIT} 的整数` }, 400);
    }
    return c.json(store.eventsFor(workspaceId, c.req.param('actor'), fromSeq, limit));
  });

  app.post('/relay/push', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { workspaceId?: unknown; nodeId?: unknown; profileVersion?: unknown; sealedEvents?: unknown }
      | null;
    const { workspaceId, nodeId, profileVersion, sealedEvents } = body ?? {};
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: 'workspaceId 必须是非空字符串' }, 400);
    }
    if (typeof nodeId !== 'string' || !nodeId) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: 'nodeId 必须是非空字符串' }, 400);
    }
    if (!Array.isArray(sealedEvents) || sealedEvents.length === 0) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: 'sealedEvents 必须是非空数组' }, 400);
    }
    if (sealedEvents.length > MAX_PUSH_BATCH) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: `单批上限 ${MAX_PUSH_BATCH} 条（收到 ${sealedEvents.length}）` }, 400);
    }
    try {
      const result = store.push(
        workspaceId,
        nodeId,
        typeof profileVersion === 'number' && Number.isFinite(profileVersion) ? profileVersion : 0,
        sealedEvents as SealedEvent[],
      );
      return c.json(result);
    } catch (err) {
      // 跨工作区密文等协议违约：拒收整批（消息带原因）
      return c.json(
        { code: 'RELAY_REJECTED', message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get('/relay/directory', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json({ code: 'RELAY_BAD_REQUEST', message: '缺少 workspaceId 查询参数' }, 400);
    }
    return c.json({ nodes: store.directory(workspaceId) });
  });

  return app;
}
