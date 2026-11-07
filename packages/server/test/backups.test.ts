import { describe, it, expect, afterEach } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationBundle } from '@one/core';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  backupFileName,
  createdAtFromName,
  isValidBackupName,
  lastBackupAtFromDir,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  resolveBackupIntervalMs,
  resolveBackupKeep,
  writeBackup,
  type BackupFile,
} from '../src/backup/backup-service.js';

/**
 * 自动备份测试（滚动保留 + 恢复闭环）：app.request 直测，落盘位用 mkdtemp。
 *
 * 覆盖：文件命名与反解、字典序即时间序、滚动清理、env 解析边界、
 * 立即备份的信封内容、恢复后投影一致且幂等、AI 配置随备份恢复、
 * 禁用面（无落盘位）、文件名穿越与坏文件的错误码。
 */

const ctxs: AppContext[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const c of ctxs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'onewms-backup-'));
  dirs.push(d);
  return d;
}

/**
 * @param disabled true = 宿主无落盘位（backupDir=null，备份整体禁用）
 * 返回的 dir 恒为字符串（禁用场景下是「不会被用到的」临时目录）。
 */
function setup(options?: {
  workspaceId?: string;
  backupDir?: string;
  keep?: number;
  aiConfigPath?: string | null;
  disabled?: boolean;
}) {
  const dir = options?.backupDir ?? newDir();
  const ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: options?.workspaceId ?? 'ws-backup',
    backupDir: options?.disabled ? null : dir,
    backupKeep: options?.keep ?? 7,
    backupIntervalMs: 0, // 测试不起定时器
    aiConfigPath: options?.aiConfigPath ?? null,
  });
  ctxs.push(ctx);
  return { ctx, app: createApp(ctx), dir };
}

const json = { 'content-type': 'application/json' };

interface ListBody {
  enabled: boolean;
  intervalMs: number;
  keep: number;
  lastBackupAt: string | null;
  backups: { name: string; createdAt: string; eventCount: number; sizeBytes: number }[];
  reason?: string;
}

/** 造一份「历史备份」（指定时刻），用于滚动清理与排序测试 */
function seed(dir: string, atMs: number, eventCount = 1): string {
  mkdirSync(dir, { recursive: true });
  return writeBackup(dir, {
    kind: BACKUP_KIND,
    backupVersion: BACKUP_VERSION,
    createdAt: new Date(atMs).toISOString(),
    bundle: { eventCount } as unknown as MigrationBundle,
  });
}

describe('备份文件命名与解析', () => {
  it('文件名 = onewms-backup-<YYYYMMDD>-<HHMMSS>-e<事件数>.json，且可反解时刻', () => {
    const dir = newDir();
    const at = Date.UTC(2026, 10, 6, 15, 34, 18);
    const name = backupFileName(new Date(at), 128);
    expect(name).toBe('onewms-backup-20261106-153418-e128.json');
    expect(isValidBackupName(name)).toBe(true);
    expect(createdAtFromName(name)).toBe('2026-11-06T15:34:18.000Z');

    const written = writeBackup(dir, {
      kind: BACKUP_KIND,
      backupVersion: BACKUP_VERSION,
      createdAt: new Date(at).toISOString(),
      bundle: { eventCount: 128 } as unknown as MigrationBundle,
    });
    expect(written).toBe(name);
    expect(readdirSync(dir)).toEqual([name]);
  });

  it('拒绝路径穿越与任意文件名', () => {
    expect(isValidBackupName('../../etc/passwd')).toBe(false);
    expect(isValidBackupName('../onewms-backup-20261106-153418-e1.json')).toBe(false);
    expect(isValidBackupName('onewms-backup-2026-11-06-e1.json')).toBe(false);
    expect(isValidBackupName('onewms-backup-20261106-153418-e1.json.bak')).toBe(false);
    expect(isValidBackupName('random.json')).toBe(false);
  });

  it('字典序 = 时间序：listBackups 新到旧，lastBackupAtFromDir 取最新', () => {
    const dir = newDir();
    const t0 = Date.UTC(2026, 0, 1);
    seed(dir, t0);
    seed(dir, t0 + 86_400_000 * 3);
    seed(dir, t0 + 86_400_000);

    const list = listBackups(dir);
    expect(list).toHaveLength(3);
    expect(list[0]!.createdAt).toBe(new Date(t0 + 86_400_000 * 3).toISOString());
    expect(list[2]!.createdAt).toBe(new Date(t0).toISOString());
    expect(lastBackupAtFromDir(dir)).toBe(t0 + 86_400_000 * 3);
    // 目录不存在 = 空（全新安装的第一次列表请求）
    expect(listBackups(join(dir, 'not-exists'))).toEqual([]);
    expect(lastBackupAtFromDir(join(dir, 'not-exists'))).toBe(0);
  });

  it('pruneBackups 只留最新 keep 份，并清掉 .tmp- 孤儿', () => {
    const dir = newDir();
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 9; i++) seed(dir, t0 + i * 1000);
    writeFileSync(join(dir, '.tmp-deadbeef'), 'half-written');
    writeFileSync(join(dir, 'not-a-backup.json'), '{}'); // 非备份命名：不动它

    const removed = pruneBackups(dir, 7);
    expect(removed).toContain('.tmp-deadbeef');
    expect(removed).toHaveLength(3); // 2 份最旧 + 1 个 tmp

    const left = listBackups(dir);
    expect(left).toHaveLength(7);
    expect(left[0]!.name).toBe(backupFileName(new Date(t0 + 8000), 1)); // 最新那份还在
    expect(left[6]!.name).toBe(backupFileName(new Date(t0 + 2000), 1)); // 最旧两份被删
    expect(readdirSync(dir)).toContain('not-a-backup.json');
  });
});

describe('env 解析', () => {
  it('ONE_BACKUP_DIR 覆盖；:memory: → null；间隔与保留份数含边界', () => {
    expect(resolveBackupDir(':memory:', {})).toBeNull();
    expect(resolveBackupDir('data/onewms.db', { ONE_BACKUP_DIR: 'D:/backups' })).toBe('D:/backups');
    expect(resolveBackupDir(':memory:', { ONE_BACKUP_DIR: 'D:/backups' })).toBe('D:/backups');
    expect(resolveBackupDir('data/onewms.db', {})).toMatch(/backups$/);

    expect(resolveBackupIntervalMs({})).toBe(86_400_000);
    expect(resolveBackupIntervalMs({ ONE_BACKUP_INTERVAL_MS: '5000' })).toBe(5000);
    expect(resolveBackupIntervalMs({ ONE_BACKUP_INTERVAL_MS: '0' })).toBe(0); // 关闭定时
    expect(resolveBackupIntervalMs({ ONE_BACKUP_INTERVAL_MS: '-5' })).toBe(0);
    expect(resolveBackupIntervalMs({ ONE_BACKUP_INTERVAL_MS: 'abc' })).toBe(0);

    expect(resolveBackupKeep({})).toBe(7);
    expect(resolveBackupKeep({ ONE_BACKUP_KEEP: '3' })).toBe(3);
    expect(resolveBackupKeep({ ONE_BACKUP_KEEP: '0' })).toBe(7); // 「保留 0 份」= 没有备份，回落缺省
  });
});

describe('POST /api/backups：立即备份', () => {
  it('写入信封文件；GET 列表回形态（enabled/keep/最近一次/大小）', async () => {
    const { app, dir } = setup({ keep: 5 });
    await app.request('/api/skus', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ skuCode: 'B-1', name: '备份物资' }),
    });

    const created = (await (await app.request('/api/backups', { method: 'POST' })).json()) as ListBody & {
      name: string;
    };
    expect(created.enabled).toBe(true);
    expect(created.keep).toBe(5);
    expect(isValidBackupName(created.name)).toBe(true);
    expect(readdirSync(dir)).toContain(created.name);

    const file = JSON.parse(readFileSync(join(dir, created.name), 'utf-8')) as BackupFile;
    expect(file.kind).toBe('onewms-backup');
    expect(file.backupVersion).toBe(1);
    expect(file.bundle.kind).toBe('onewms-migration-bundle');
    expect(file.bundle.workspaceId).toBe('ws-backup');
    expect(file.bundle.eventCount).toBe(file.bundle.events.length);
    expect(file.bundle.eventCount).toBeGreaterThan(0);
    expect(file.aiConfig).toBeUndefined(); // 未配置 AI → 不带该字段（恢复时不动现状）

    const list = (await (await app.request('/api/backups')).json()) as ListBody;
    expect(list.backups).toHaveLength(1);
    // 列表的时刻来自文件名（秒精度，字典序即时间序）——信封里的 createdAt 带毫秒
    expect(list.lastBackupAt).toBe(createdAtFromName(created.name));
    expect(file.createdAt.startsWith(list.lastBackupAt!.slice(0, 19))).toBe(true);
    expect(list.backups[0]!.sizeBytes).toBeGreaterThan(0);
    expect(list.backups[0]!.eventCount).toBe(file.bundle.eventCount);
  });

  it('超过 keep 份 → 滚动清理只留最新', async () => {
    const { app, dir } = setup({ keep: 7 });
    const t0 = Date.now() - 86_400_000 * 20;
    for (let i = 0; i < 9; i++) seed(dir, t0 + i * 1000);
    expect(listBackups(dir)).toHaveLength(9);

    const body = (await (await app.request('/api/backups', { method: 'POST' })).json()) as ListBody;
    // 9 份伪造 + 1 份新备份 = 10 → 只留 7，且新备份是最新那份
    expect(body.backups).toHaveLength(7);
    expect(listBackups(dir)).toHaveLength(7);
    expect(Date.parse(body.backups[0]!.createdAt)).toBeGreaterThan(t0 + 8000);
    expect(body.lastBackupAt).toBe(body.backups[0]!.createdAt);
  });

  it('备份含 AI 配置（页面上配过的密钥也在保险范围内）', async () => {
    const root = newDir();
    const backupDir = join(root, 'backups');
    const { app } = setup({ backupDir, aiConfigPath: join(root, 'ai-config.json') });
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'ollama', model: 'qwen3:8b' }),
    });

    const created = (await (await app.request('/api/backups', { method: 'POST' })).json()) as { name: string };
    const file = JSON.parse(readFileSync(join(backupDir, created.name), 'utf-8')) as BackupFile;
    expect(file.aiConfig?.model).toBe('qwen3:8b');
  });
});

describe('POST /api/backups/:name/restore：恢复闭环', () => {
  it('备份 → 新节点恢复：SKU/库存一致；重复恢复幂等', async () => {
    const backupDir = join(newDir(), 'backups');
    const src = setup({ workspaceId: 'ws-restore', backupDir });
    await src.app.request('/api/skus', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ skuCode: 'R-1', name: '恢复物资' }),
    });
    await src.app.request('/api/inventory/adjust', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ skuCode: 'R-1', delta: 7, reason: '期初' }),
    });
    const created = (await (await src.app.request('/api/backups', { method: 'POST' })).json()) as { name: string };
    const bundle = (JSON.parse(readFileSync(join(backupDir, created.name), 'utf-8')) as BackupFile).bundle;

    // 新节点（空库）共用备份目录 → 恢复
    const dst = setup({ workspaceId: 'ws-restore', backupDir });
    const res = await dst.app.request(`/api/backups/${created.name}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as {
      accepted: number;
      skipped: number;
      replayed: boolean;
      aiConfigRestored: boolean;
    };
    expect(r.accepted).toBe(bundle.eventCount);
    expect(r.replayed).toBe(true);
    expect(r.aiConfigRestored).toBe(false); // 备份里没有 AI 配置 → 不动现状

    const skus = (await (await dst.app.request('/api/skus')).json()) as { skuCode: string }[];
    expect(skus.map((s) => s.skuCode)).toContain('R-1');
    const inv = (await (await dst.app.request('/api/inventory')).json()) as { skuCode: string; quantity: number }[];
    expect(inv.find((i) => i.skuCode === 'R-1')!.quantity).toBe(7);

    // 幂等：再恢复一次零新事件、不重建投影（点错了再点一次不会搞坏数据）
    const again = (await (await dst.app.request(`/api/backups/${created.name}/restore`, { method: 'POST' })).json()) as {
      accepted: number;
      replayed: boolean;
    };
    expect(again.accepted).toBe(0);
    expect(again.replayed).toBe(false);
  });

  it('恢复带 AI 配置的备份 → 落盘 + provider 热更（无需重启）', async () => {
    const root = newDir();
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true }); // 真实宿主的 db 目录由 start() 建好
    const src = setup({ workspaceId: 'ws-ai', backupDir: srcDir, aiConfigPath: join(srcDir, 'ai-config.json') });
    await src.app.request('/api/ai-config/profiles', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        vendorId: 'deepseek',
        label: 'DeepSeek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-backup',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }),
    });
    const created = (await (await src.app.request('/api/backups', { method: 'POST' })).json()) as { name: string };
    const envelope = JSON.parse(readFileSync(join(srcDir, created.name), 'utf-8')) as BackupFile;
    expect(envelope.aiConfig?.model).toBe('deepseek-chat');
    expect(envelope.aiCatalog?.profiles).toHaveLength(2);

    // 换机场景：备份拷到新节点的备份目录，新节点从未配过 AI
    const dstDir = join(root, 'dst');
    const dst = setup({ workspaceId: 'ws-ai', backupDir: dstDir, aiConfigPath: join(dstDir, 'ai-config.json') });
    expect(dst.ctx.provider).toBeUndefined();
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(join(srcDir, created.name), join(dstDir, created.name));

    const r = (await (await dst.app.request(`/api/backups/${created.name}/restore`, { method: 'POST' })).json()) as {
      aiConfigRestored: boolean;
    };
    expect(r.aiConfigRestored).toBe(true);
    expect(dst.ctx.provider).toBeDefined();
    expect(dst.ctx.aiConfig?.model).toBe('deepseek-chat');
    expect(dst.ctx.aiConfigSource).toBe('file');
    expect(dst.ctx.aiCatalog.profiles.map((item) => item.model).sort()).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    const saved = JSON.parse(readFileSync(join(dstDir, 'ai-config.json'), 'utf-8')) as {
      version: number;
      activeId: string | null;
      profiles: { id: string; model: string; apiKey?: string }[];
    };
    expect(saved.version).toBe(2);
    const active = saved.profiles.find((item) => item.id === saved.activeId);
    expect(active?.apiKey).toBe('sk-backup');
    expect(saved.profiles.every((item) => item.apiKey === 'sk-backup')).toBe(true);
  });

  it('错误面：文件名穿越 400 / 不存在 404 / 坏文件 400 / 跨工作区 400', async () => {
    const { app, dir } = setup({ workspaceId: 'ws-err' });

    const traversal = await app.request('/api/backups/..%2F..%2Fsecret.json/restore', { method: 'POST' });
    expect(traversal.status).toBe(400);
    expect(((await traversal.json()) as { code: string }).code).toBe('BACKUP_NAME_INVALID');

    const missing = await app.request('/api/backups/onewms-backup-20261106-153418-e1.json/restore', {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('BACKUP_NOT_FOUND');

    const broken = 'onewms-backup-20261106-153418-e1.json';
    writeFileSync(join(dir, broken), '{ 这不是 JSON');
    const brokenRes = await app.request(`/api/backups/${broken}/restore`, { method: 'POST' });
    expect(brokenRes.status).toBe(400);
    expect(((await brokenRes.json()) as { code: string }).code).toBe('BACKUP_INVALID');

    // 信封合法但工作区不一致 → 交给迁移管线的中文错误（不吞不改）
    const cross: BackupFile = {
      kind: BACKUP_KIND,
      backupVersion: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      bundle: {
        kind: 'onewms-migration-bundle',
        bundleVersion: 1,
        nodeId: 'node-x',
        workspaceId: 'ws-other',
        profileVersion: 0,
        eventCount: 0,
        createdAt: new Date().toISOString(),
        events: [],
      } as unknown as MigrationBundle,
    };
    const crossName = 'onewms-backup-20261106-153419-e0.json';
    writeFileSync(join(dir, crossName), JSON.stringify(cross));
    const crossRes = await app.request(`/api/backups/${crossName}/restore`, { method: 'POST' });
    expect(crossRes.status).toBe(400);
    const crossBody = (await crossRes.json()) as { code: string; message: string };
    expect(crossBody.code).toBe('MIGRATION_ERROR');
    expect(crossBody.message).toContain('工作区不一致');
  });

  it('DELETE：删除一份并回新列表；重复删 404；非法名 400', async () => {
    const { app, dir } = setup();
    const created = (await (await app.request('/api/backups', { method: 'POST' })).json()) as { name: string };

    const del = await app.request(`/api/backups/${created.name}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as ListBody).backups).toHaveLength(0);
    expect(readdirSync(dir)).not.toContain(created.name);

    const again = await app.request(`/api/backups/${created.name}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    const bad = await app.request('/api/backups/nope.json', { method: 'DELETE' });
    expect(bad.status).toBe(400);
  });
});

describe('禁用面（宿主无落盘位）', () => {
  it('GET 200 报 enabled:false + 原因；POST/restore/DELETE 503 BACKUP_DISABLED', async () => {
    const { app } = setup({ disabled: true });

    const list = (await (await app.request('/api/backups')).json()) as ListBody;
    expect(list.enabled).toBe(false);
    expect(list.backups).toEqual([]);
    expect(list.lastBackupAt).toBeNull();
    expect(list.reason).toBeTruthy();

    const responses = await Promise.all([
      app.request('/api/backups', { method: 'POST' }),
      app.request('/api/backups/onewms-backup-20261106-153418-e1.json/restore', { method: 'POST' }),
      app.request('/api/backups/onewms-backup-20261106-153418-e1.json', { method: 'DELETE' }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('BACKUP_DISABLED');
    }
  });
});
