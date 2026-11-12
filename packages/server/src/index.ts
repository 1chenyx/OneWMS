import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createVercelLlmProvider, resolveLanguageModel } from '@one/ai';
import { createAppContext, type AppContext } from './context.js';
import { apiErrorHandler } from './errors.js';
import { readAiConfig } from './ai-config.js';
import { activeProvider, readAiCatalog, resolveAiConfigPath } from './ai-config-store.js';
import {
  lastBackupAtFromDir,
  performBackup,
  resolveBackupDir,
  resolveBackupIntervalMs,
  resolveBackupKeep,
} from './backup/backup-service.js';
import { mountStatic } from './static.js';
import { profileRoutes } from './routes/profile.js';
import { proposalRoutes } from './routes/proposals.js';
import { chatRoutes } from './routes/chat.js';
import { agentRoutes } from './routes/agents.js';
import { aiConfigRoutes } from './routes/ai-config.js';
import { memoryRoutes } from './routes/memory.js';
import { wmsRoutes } from './routes/wms.js';
import { dynRoutes } from './routes/dyn.js';
import { toolRoutes } from './routes/tools.js';
import { uiRoutes } from './routes/ui.js';
import { lanIPv4, syncRoutes } from './routes/sync.js';
import { migrationRoutes } from './routes/migration.js';
import { backupRoutes, backupSnapshot } from './routes/backups.js';
import { runSyncRound } from './sync/sync-client.js';
import { envPeers, mergePeerUrls, resolvePeersPath } from './sync/peer-store.js';

export { createAppContext } from './context.js';
export type { AppContext } from './context.js';
export { readAiConfig } from './ai-config.js';
export { APP_DIST, mountStatic } from './static.js';
export { runMemoryExtraction, scheduleMemoryExtraction } from './memory-hook.js';
export type { ExtractionStats } from './memory-hook.js';
export { runMemoryConsolidation } from './memory-consolidate.js';
export type { ConsolidationStats } from './memory-consolidate.js';
export { runSyncRound } from './sync/sync-client.js';
export type { SyncRoundResult } from './sync/sync-client.js';
export {
  APP_VERSION_META_KEY,
  decideUpgrade,
  downgradeMessage,
  resolveAppVersion,
  runUpgradeGate,
} from './upgrade/upgrade-gate.js';
export type { GateDecision, UpgradeGateReport } from './upgrade/upgrade-gate.js';
export { ConfirmGate, ConfirmTokenError, CONFIRM_TOKEN_TTL_MS } from './tool-confirm.js';
export type { PendingWrite } from './tool-confirm.js';

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
  app.route('/api/backups', backupRoutes(ctx));
  app.route('/api/dyn', dynRoutes(ctx)); // 声明式实体记录端点（B.3）：先于 /api 挂，避免被兜底路由吃掉
  app.route('/api/tools', toolRoutes(ctx)); // 通用工具调用 + 写操作二次确认（B.5）
  app.route('/api/ui', uiRoutes(ctx)); // SDUI 页面清单（B.6）：同样先于 /api 兜底挂
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
  const aiCatalog = aiConfigPath ? readAiCatalog(aiConfigPath) : undefined;
  const fileAi = aiCatalog ? activeProvider(aiCatalog) : undefined;
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
    aiCatalog,
    backupDir: resolveBackupDir(dbPath),
    backupIntervalMs: resolveBackupIntervalMs(),
    backupKeep: resolveBackupKeep(),
    peersPath: resolvePeersPath(dbPath),
  });
  const app = createApp(ctx);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    ctx.listeningPort = info.port; // 记端口：/api/sync/lan-address 要拼出「对端能访问的我」
    console.log(
      `[one-server] http://localhost:${info.port}  workspace=${workspaceId}  db=${dbPath}  ai=${ai ? ai.model : 'off'}${fileAi ? '（页面配置）' : ''}`,
    );
    console.log(
      ctx.backupDir === null
        ? '[one-server] 自动备份：关闭（当前宿主无可写数据目录）'
        : `[one-server] 自动备份：${ctx.backupDir}  间隔=${ctx.backupIntervalMs === 0 ? '仅手动' : `${Math.round(ctx.backupIntervalMs / 3_600_000)} 小时`}  保留=${ctx.backupKeep} 份`,
    );
    const gate = ctx.upgradeGate;
    console.log(
      gate.decision.kind === 'upgrade'
        ? `[one-server] 升级闸门：v${gate.decision.from} → v${gate.decision.to}，升级前备份 ${gate.backupName ?? `未生成（${gate.backupSkippedReason ?? '原因未知'}）`}`
        : gate.decision.kind === 'fresh'
          ? `[one-server] 升级闸门：全新数据目录，已记版本 v${gate.appVersion}`
          : gate.decision.kind === 'disabled'
            ? `[one-server] 升级闸门：关闭（${gate.decision.reason}）——不做版本比对，也不生成升级前备份`
            : `[one-server] 升级闸门：版本未变（v${gate.decision.kind === 'same' ? gate.decision.version : gate.appVersion}）`,
    );
    const ip = lanIPv4();
    console.log(
      ip === null
        ? '[one-server] 局域网地址：未发现（另一台设备无法连过来同步）'
        : `[one-server] 局域网地址：http://${ip}:${info.port}  ← 另一台设备「添加节点」填这个（也可在设置页扫二维码）`,
    );
  });

  const stopBackupTimer = startBackupTimer(ctx);

  // 定时同步轮询（M5 + 扫码组网）：常驻，每 tick 动态合并「已配对清单 ∪ env」。
  // 无条件启动是关键——否则运行中从页面添加的第一个节点永远不会被轮询到。
  const syncTimer = setInterval(
    () => void syncAllPeers(ctx),
    Number(process.env.ONE_SYNC_INTERVAL_MS ?? 30_000),
  );

  const shutdown = () => {
    clearInterval(syncTimer);
    stopBackupTimer?.();
    server.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 定时轮询：每 tick 现算 peer 集合（页面加的节点下一轮就参与，无需重启），
 * 逐 peer 拉取回合，单败只记日志（下一轮自然重试）；空集合直接跳过。
 */
async function syncAllPeers(ctx: AppContext): Promise<void> {
  const peers = mergePeerUrls(
    ctx.peers.list().map((p) => p.url),
    envPeers(),
  );
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

/**
 * 自动备份定时器（滚动保留）。
 *
 * 首轮延迟按「上次备份时刻 + 间隔」算，而不是无脑等一个完整间隔：
 *  - 目录里已有备份且未到期 → 只等剩下的时间（一天内反复重启不反复备份）；
 *  - 已过期（桌面版隔了一夜才开机）→ 立即补一份；
 *  - 全新库（目录里没备份）→ 等一个完整间隔（此刻也没什么可丢的）。
 * 单轮失败只记日志、下一轮自然重试——备份不该把服务带崩。
 */
function startBackupTimer(ctx: AppContext): (() => void) | undefined {
  if (ctx.backupDir === null || ctx.backupIntervalMs <= 0) return undefined;
  const interval = ctx.backupIntervalMs;
  const last = lastBackupAtFromDir(ctx.backupDir);
  const delay = last === 0 ? interval : Math.max(0, last + interval - Date.now());
  let repeat: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    runBackupOnce(ctx);
    repeat = setInterval(() => runBackupOnce(ctx), interval);
  }, delay);
  return () => {
    clearTimeout(first);
    if (repeat) clearInterval(repeat);
  };
}

function runBackupOnce(ctx: AppContext): void {
  if (ctx.backupDir === null) return;
  try {
    const { name, removed } = performBackup({
      dir: ctx.backupDir,
      keep: ctx.backupKeep,
      ...backupSnapshot(ctx),
    });
    console.log(
      `[one-server] 自动备份完成 ${name}${removed.length > 0 ? `（滚动删除 ${removed.length} 份，保留最新 ${ctx.backupKeep} 份）` : ''}`,
    );
  } catch (err) {
    console.error(`[one-server] 自动备份失败：${err instanceof Error ? err.message : err}`);
  }
}
