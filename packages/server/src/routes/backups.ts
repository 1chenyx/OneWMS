import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { readAiConfigFile, writeAiConfigFile } from '../ai-config-store.js';
import {
  deleteBackup,
  isValidBackupName,
  listBackups,
  performBackup,
  readBackup,
  type BackupEntry,
} from '../backup/backup-service.js';

/**
 * 自动备份端点（滚动保留）——0 基础用户不用记「导出迁移包」这个动作。
 *
 *  - GET    /              备份清单 + 策略（enabled/intervalMs/keep/最近一次）；
 *  - POST   /              立即备份一份（与定时轮同一动作，含滚动清理）；
 *  - POST   /:name/restore 恢复：importBundle 幂等落账 + 投影重建（运行中生效，不重启）；
 *  - DELETE /:name         删除一份。
 *
 * 恢复走的就是迁移导入管线（eventId 查重）——重复恢复零新事件，
 * 「点错了再点一次」不会把数据搞坏，这是给不敢点按钮的用户的底气。
 *
 * 禁用面（:memory: 宿主或 ONE_BACKUP_DIR 不可用）：GET 照常 200 报
 * enabled:false（页面要能显示原因），写操作 503 BACKUP_DISABLED。
 */

interface BackupListBody {
  enabled: boolean;
  intervalMs: number;
  keep: number;
  /** 最近一次备份的 ISO 时刻；从未备份 → null */
  lastBackupAt: string | null;
  /** 新到旧 */
  backups: BackupEntry[];
  /** 禁用原因（enabled=false 时给页面显示） */
  reason?: string;
}

function listBody(ctx: AppContext): BackupListBody {
  const dir = ctx.backupDir;
  if (dir === null) {
    return {
      enabled: false,
      intervalMs: ctx.backupIntervalMs,
      keep: ctx.backupKeep,
      lastBackupAt: null,
      backups: [],
      reason: '当前宿主没有可写的数据目录（内存库），自动备份已关闭',
    };
  }
  const backups = listBackups(dir);
  return {
    enabled: true,
    intervalMs: ctx.backupIntervalMs,
    keep: ctx.backupKeep,
    lastBackupAt: backups[0]?.createdAt ?? null,
    backups,
  };
}

/** 备份内容 = 迁移包 + AI 配置文件（未配置则不带该字段）——端点与定时轮共用 */
export function backupSnapshot(ctx: AppContext) {
  const aiConfig = ctx.aiConfigPath ? readAiConfigFile(ctx.aiConfigPath) : undefined;
  return {
    bundle: ctx.core.migration.exportBundle(ctx.workspaceId),
    ...(aiConfig ? { aiConfig } : {}),
  };
}

export function backupRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => c.json(listBody(ctx)))
    .post('/', (c) => {
      if (ctx.backupDir === null) {
        return c.json({ code: 'BACKUP_DISABLED', message: listBody(ctx).reason }, 503);
      }
      const { name, removed } = performBackup({
        dir: ctx.backupDir,
        keep: ctx.backupKeep,
        ...backupSnapshot(ctx),
      });
      if (removed.length > 0) {
        console.log(`[one-server] 备份滚动清理：删除 ${removed.length} 份（保留最新 ${ctx.backupKeep} 份）`);
      }
      return c.json({ name, ...listBody(ctx) });
    })
    .post('/:name/restore', (c) => {
      if (ctx.backupDir === null) {
        return c.json({ code: 'BACKUP_DISABLED', message: listBody(ctx).reason }, 503);
      }
      const name = c.req.param('name');
      if (!isValidBackupName(name)) {
        return c.json({ code: 'BACKUP_NAME_INVALID', message: '备份文件名不合法' }, 400);
      }
      if (!existsSync(join(ctx.backupDir, name))) {
        return c.json({ code: 'BACKUP_NOT_FOUND', message: `备份不存在：${name}` }, 404);
      }
      const file = readBackup(ctx.backupDir, name);
      if (file === null) {
        return c.json({ code: 'BACKUP_INVALID', message: '备份文件已损坏或不是 OneWMS 备份' }, 400);
      }

      // 迁移导入管线：幂等摄入（eventId 查重）——bundle 自身不合法会抛 MIGRATION_ERROR
      const { accepted, skipped } = ctx.core.migration.importBundle(ctx.workspaceId, file.bundle);
      const replayed = accepted > 0;
      if (replayed) {
        ctx.ws.replayAll();
        ctx.memory.replay(); // 记忆投影一并重建
      }

      // AI 配置：备份里有才恢复（没有就保持现状——恢复数据不该顺手关掉 AI）
      let aiConfigRestored = false;
      if (file.aiConfig && ctx.aiConfigPath !== null) {
        writeAiConfigFile(ctx.aiConfigPath, file.aiConfig);
        ctx.applyAiConfig(file.aiConfig, 'file');
        aiConfigRestored = true;
      }
      return c.json({ accepted, skipped, replayed, aiConfigRestored });
    })
    .delete('/:name', (c) => {
      if (ctx.backupDir === null) {
        return c.json({ code: 'BACKUP_DISABLED', message: listBody(ctx).reason }, 503);
      }
      const name = c.req.param('name');
      if (!isValidBackupName(name)) {
        return c.json({ code: 'BACKUP_NAME_INVALID', message: '备份文件名不合法' }, 400);
      }
      if (!existsSync(join(ctx.backupDir, name))) {
        return c.json({ code: 'BACKUP_NOT_FOUND', message: `备份不存在：${name}` }, 404);
      }
      deleteBackup(ctx.backupDir, name);
      return c.json(listBody(ctx));
    });
}
