import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createVercelLlmProvider, resolveLanguageModel } from '@one/ai';
import { createAppContext, type AppContext } from './context.js';
import { apiErrorHandler } from './errors.js';
import { readAiConfig } from './ai-config.js';
import { mountStatic } from './static.js';
import { profileRoutes } from './routes/profile.js';
import { proposalRoutes } from './routes/proposals.js';
import { chatRoutes } from './routes/chat.js';
import { wmsRoutes } from './routes/wms.js';
import { syncRoutes } from './routes/sync.js';
import { keysRoutes } from './routes/keys.js';
import { migrationRoutes } from './routes/migration.js';
import { relayRoutes } from './routes/relay.js';
import { runSyncRound } from './sync/sync-client.js';
import { runRelayRound } from './relay/relay-client.js';
import { createRelayApp } from './relay/relay-app.js';
import { RelayStore } from './relay/relay-store.js';

export { createAppContext } from './context.js';
export type { AppContext } from './context.js';
export { readAiConfig } from './ai-config.js';
export { APP_DIST, mountStatic } from './static.js';
export { runSyncRound } from './sync/sync-client.js';
export type { SyncRoundResult } from './sync/sync-client.js';
export { runRelayRound } from './relay/relay-client.js';
export type { RelayRoundResult } from './relay/relay-client.js';
export { createRelayApp } from './relay/relay-app.js';
export { RelayStore } from './relay/relay-store.js';

/** 组装 Hono 应用（测试口：不起端口，app.request 直测） */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.onError(apiErrorHandler);
  app.get('/api/health', (c) => c.json({ ok: true, nodeId: ctx.core.nodeId }));
  app.route('/api/profile', profileRoutes(ctx));
  app.route('/api/proposals', proposalRoutes(ctx));
  app.route('/api/chat', chatRoutes(ctx));
  app.route('/api/sync', syncRoutes(ctx));
  app.route('/api/keys', keysRoutes(ctx));
  app.route('/api/migration', migrationRoutes(ctx));
  app.route('/api/relay', relayRoutes(ctx));
  app.route('/api', wmsRoutes(ctx));
  mountStatic(app);
  return app;
}

/** 进程入口：env → 装配 → 监听（唯一副作用汇聚点） */
export function start(): void {
  const dbPath = process.env.ONE_DB_PATH ?? 'data/onewms.db';
  const workspaceId = process.env.ONE_WORKSPACE ?? 'default';
  const port = Number(process.env.ONE_PORT ?? 3000);

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const ai = readAiConfig();
  const provider = ai ? createVercelLlmProvider(resolveLanguageModel(ai)) : undefined;
  const ctx = createAppContext({ dbPath, workspaceId, provider, model: ai?.model });
  const app = createApp(ctx);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `[one-server] http://localhost:${info.port}  workspace=${workspaceId}  db=${dbPath}  ai=${ai ? ai.model : 'off'}`,
    );
  });

  // 定时同步轮询（M5）：ONE_SYNC_PEERS 非空时启动，默认 30s 一轮
  const syncPeers = (process.env.ONE_SYNC_PEERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const syncTimer =
    syncPeers.length > 0
      ? setInterval(
          () => void syncAllPeers(ctx, syncPeers),
          Number(process.env.ONE_SYNC_INTERVAL_MS ?? 30_000),
        )
      : undefined;

  // 定时中继回合（M7）：ONE_RELAY_URL 非空时启动，默认 60s 一轮（push + pull）
  const relayUrl = (process.env.ONE_RELAY_URL ?? '').trim();
  const relayTimer = relayUrl
    ? setInterval(
        () =>
          void runRelayRound({
            relayBaseUrl: relayUrl,
            workspaceId: ctx.workspaceId,
            core: ctx.core,
            ws: ctx.ws,
          }).catch((err: unknown) => {
            console.error(
              `[one-server] 中继回合失败 relay=${relayUrl}: ${err instanceof Error ? err.message : err}`,
            );
          }),
        Number(process.env.ONE_RELAY_INTERVAL_MS ?? 60_000),
      )
    : undefined;

  const shutdown = () => {
    if (syncTimer) clearInterval(syncTimer);
    if (relayTimer) clearInterval(relayTimer);
    server.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 定时轮询：逐 peer 拉取回合，单败只记日志（下一轮自然重试） */
async function syncAllPeers(ctx: AppContext, peers: string[]): Promise<void> {
  for (const peer of peers) {
    try {
      const r = await runSyncRound({
        peerBaseUrl: peer,
        workspaceId: ctx.workspaceId,
        core: ctx.core,
        ws: ctx.ws,
      });
      if (r.status === 'synced') {
        console.log(`[one-server] 同步完成 peer=${r.peer} 拉取=${r.pulled} 接受=${r.accepted}`);
      }
    } catch (err) {
      console.error(`[one-server] 同步失败 peer=${peer}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
