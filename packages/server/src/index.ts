import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createVercelLlmProvider, resolveLanguageModel } from '@one/ai';
import { createAppContext, type AppContext } from './context.js';
import { apiErrorHandler } from './errors.js';
import { readAiConfig } from './ai-config.js';
import { readAiConfigFile, resolveAiConfigPath } from './ai-config-store.js';
import { mountStatic } from './static.js';
import { profileRoutes } from './routes/profile.js';
import { proposalRoutes } from './routes/proposals.js';
import { chatRoutes } from './routes/chat.js';
import { agentRoutes } from './routes/agents.js';
import { aiConfigRoutes } from './routes/ai-config.js';
import { memoryRoutes } from './routes/memory.js';
import { wmsRoutes } from './routes/wms.js';
import { syncRoutes } from './routes/sync.js';
import { migrationRoutes } from './routes/migration.js';
import { runSyncRound } from './sync/sync-client.js';

export { createAppContext } from './context.js';
export type { AppContext } from './context.js';
export { readAiConfig } from './ai-config.js';
export { APP_DIST, mountStatic } from './static.js';
export { runMemoryExtraction, scheduleMemoryExtraction } from './memory-hook.js';
export { runSyncRound } from './sync/sync-client.js';
export type { SyncRoundResult } from './sync/sync-client.js';

/** 组装 Hono 应用（测试口：不起端口，app.request 直测） */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.onError(apiErrorHandler);
  app.get('/api/health', (c) => c.json({ ok: true, nodeId: ctx.core.nodeId }));
  app.route('/api/profile', profileRoutes(ctx));
  app.route('/api/proposals', proposalRoutes(ctx));
  app.route('/api/chat', chatRoutes(ctx));
  app.route('/api/agents', agentRoutes(ctx));
  app.route('/api/ai-config', aiConfigRoutes(ctx));
  app.route('/api/memory', memoryRoutes(ctx));
  app.route('/api/sync', syncRoutes(ctx));
  app.route('/api/migration', migrationRoutes(ctx));
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
  // AI 配置优先级（M17）：配置页保存的文件 > 启动环境变量；两者皆无 = AI 关闭。
  const aiConfigPath = resolveAiConfigPath(dbPath);
  const fileAi = aiConfigPath ? readAiConfigFile(aiConfigPath) : undefined;
  const envAi = readAiConfig();
  const ai = fileAi ?? envAi;
  const provider = ai ? createVercelLlmProvider(resolveLanguageModel(ai)) : undefined;
  const ctx = createAppContext({
    dbPath,
    workspaceId,
    provider,
    aiConfig: ai,
    aiConfigPath,
    aiConfigSource: fileAi ? 'file' : envAi ? 'env' : 'none',
    aiConfigEnv: envAi,
  });
  const app = createApp(ctx);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `[one-server] http://localhost:${info.port}  workspace=${workspaceId}  db=${dbPath}  ai=${ai ? ai.model : 'off'}${fileAi ? '（页面配置）' : ''}`,
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

  const shutdown = () => {
    if (syncTimer) clearInterval(syncTimer);
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
        memory: ctx.memory,
      });
      if (r.status === 'synced') {
        console.log(`[one-server] 同步完成 peer=${r.peer} 拉取=${r.pulled} 接受=${r.accepted}`);
      }
    } catch (err) {
      console.error(`[one-server] 同步失败 peer=${peer}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
