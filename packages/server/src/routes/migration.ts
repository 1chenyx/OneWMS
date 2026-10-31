import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/**
 * 迁移端点（DESIGN §1.1「配置包 + 事件重放」/ §6.4 迁移闭环，里程碑 7）。
 *
 * 导出 = 全量事件包（明文 JSON 文件——用户本地可信域）；
 * 导入 = 幂等摄入 + replayAll 全量重建 + manifest 在场性报告
 *       （缺代码的模块不阻塞：账本是事实全收，运行时行为等 manifest 注册）。
 */
export function migrationRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/export', (c) => c.json(ctx.core.migration.exportBundle(ctx.workspaceId)))
    .post('/import', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { bundle?: unknown };
      const { accepted, skipped } = ctx.core.migration.importBundle(ctx.workspaceId, body.bundle);

      // manifest 在场性报告：扫描 module.installed 事件引用的模块，对照进程 manifest 目录
      const installed = new Map<string, string>();
      ctx.ws.events.forEach((env) => {
        if (env.type === 'module.installed') {
          const p = env.payload as { id?: string; version?: string };
          if (typeof p?.id === 'string') installed.set(p.id, p.version ?? 'unknown');
        }
      });
      const known = new Set(ctx.core.exposeModuleRegistry().listManifests().map((m) => m.id));
      const missingManifests = [...installed.entries()]
        .filter(([id]) => !known.has(id))
        .map(([id, version]) => ({ id, version }));

      const replayed = accepted > 0;
      if (replayed) ctx.ws.replayAll();
      return c.json({ accepted, skipped, replayed, missingManifests });
    });
}
