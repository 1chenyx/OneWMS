import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MigrationBundle } from '@one/core';
import type { AiProviderConfig } from '@one/ai';

/**
 * 自动备份（滚动保留）——0 基础用户的最后一道保险。
 *
 * 备份 = 迁移包（全量事件）+ AI 配置文件，装进单个 JSON 信封落盘。
 * 选它而不是拷 .db 文件：导出走的是同一条 better-sqlite3 连接，读到的是
 * 一致快照，不依赖 WAL checkpoint；桌面版被硬杀也不会留下半个数据库。
 *
 * 文件名自带时间戳与事件数（`onewms-backup-20261106-153418-e128.json`）：
 *  - 字典序 = 时间序 → 滚动清理只需排序截断；
 *  - 列表接口 readdir + stat 即可，不用解析可能上百 MB 的 JSON。
 *
 * 写入用 temp + rename 原子落盘，清理时顺带扫掉 `.tmp-*` 孤儿——进程被
 * 硬杀最坏残留一个临时文件，已完成的备份永不损坏。
 */

/** 备份信封标识与版本（导入端的结构校验位） */
export const BACKUP_KIND = 'onewms-backup';
export const BACKUP_VERSION = 1;

/** 缺省目录名（dbPath 同目录下；ONE_BACKUP_DIR 可显式覆盖） */
export const BACKUP_DIR_NAME = 'backups';

/** 缺省滚动间隔：一天一次（ONE_BACKUP_INTERVAL_MS=0 关闭自动备份） */
export const DEFAULT_BACKUP_INTERVAL_MS = 86_400_000;

/** 缺省保留份数（ONE_BACKUP_KEEP，最小 1） */
export const DEFAULT_BACKUP_KEEP = 7;

/** 单个备份文件（信封 = 元信息 + 迁移包 + 可选 AI 配置） */
export interface BackupFile {
  kind: typeof BACKUP_KIND;
  backupVersion: typeof BACKUP_VERSION;
  /** ISO 时刻（UTC） */
  createdAt: string;
  /** 迁移包原样内嵌——恢复零转换，直接喂 importBundle */
  bundle: MigrationBundle;
  /**
   * AI 配置（含明文 apiKey——备份文件属本地可信域，与迁移包同级）。
   * 备份时未配置则无此字段：恢复时不动现有 AI 配置，防「恢复数据顺带把 AI 关掉」。
   */
  aiConfig?: AiProviderConfig;
}

/** 列表项（不解析文件内容——全部信息来自文件名与 stat） */
export interface BackupEntry {
  name: string;
  /** ISO 时刻（从文件名解析） */
  createdAt: string;
  eventCount: number;
  sizeBytes: number;
}

/** 文件名正则：`onewms-backup-<YYYYMMDD>-<HHMMSS>-e<事件数>.json`（也是路径穿越的唯一防线） */
const NAME_RE = /^onewms-backup-(\d{8})-(\d{6})-e(\d+)\.json$/;

/** dbPath → 备份目录；:memory: 宿主无落盘位 → null（备份整体禁用） */
export function resolveBackupDir(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_BACKUP_DIR === 'string' && env.ONE_BACKUP_DIR.trim()) {
    return env.ONE_BACKUP_DIR.trim();
  }
  if (dbPath === ':memory:') return null;
  return resolve(join(dirname(resolve(dbPath)), BACKUP_DIR_NAME));
}

/** env → 自动备份间隔（毫秒）；<=0 或非法 = 关闭 */
export function resolveBackupIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ONE_BACKUP_INTERVAL_MS ?? DEFAULT_BACKUP_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/** env → 保留份数（最小 1——「保留 0 份」等于没有备份） */
export function resolveBackupKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ONE_BACKUP_KEEP ?? DEFAULT_BACKUP_KEEP);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BACKUP_KEEP;
  return Math.floor(raw);
}

export function isValidBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Date → 文件名（UTC 紧凑时刻，字典序即时间序） */
export function backupFileName(createdAt: Date, eventCount: number): string {
  const iso = createdAt.toISOString(); // 2026-11-06T15:34:18.123Z
  const day = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `onewms-backup-${day}-${time}-e${eventCount}.json`;
}

/** 文件名 → ISO 时刻；不合法 → undefined */
export function createdAtFromName(name: string): string | undefined {
  const m = NAME_RE.exec(name);
  if (!m) return undefined;
  const [, day, time] = m;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
}

/** 列目录（新到旧）；目录不存在 → 空数组。非备份命名的文件一律忽略。 */
export function listBackups(dir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const createdAt = createdAtFromName(name);
    if (!createdAt) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(join(dir, name)).size;
    } catch {
      continue; // 列目录与 stat 之间被删掉：跳过即可
    }
    entries.push({ name, createdAt, eventCount: Number(m[3]), sizeBytes });
  }
  // 文件名字典序 = 时间序；倒序即「新到旧」
  entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return entries;
}

/** 目录内最近一次备份的时刻（毫秒）；无备份 → 0（定时器据此判断「启动即补」还是「等下一轮」） */
export function lastBackupAtFromDir(dir: string): number {
  const latest = listBackups(dir)[0];
  if (!latest) return 0;
  const t = Date.parse(latest.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 写一份备份（原子落盘：temp + rename）。
 * 同名（同一秒内两次备份）时 rename 覆盖——内容更新，不报错。
 */
export function writeBackup(dir: string, file: BackupFile): string {
  mkdirSync(dir, { recursive: true });
  const name = backupFileName(new Date(file.createdAt), file.bundle.eventCount);
  const finalPath = join(dir, name);
  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmpPath, finalPath);
  return name;
}

/** 一次完整备份动作（写入 + 滚动清理）——定时轮与「立即备份」端点共用 */
export function performBackup(options: {
  dir: string;
  bundle: MigrationBundle;
  aiConfig?: AiProviderConfig;
  keep: number;
}): { name: string; removed: string[] } {
  const createdAt = new Date().toISOString();
  const name = writeBackup(options.dir, {
    kind: BACKUP_KIND,
    backupVersion: BACKUP_VERSION,
    createdAt,
    bundle: options.bundle,
    ...(options.aiConfig ? { aiConfig: options.aiConfig } : {}),
  });
  return { name, removed: pruneBackups(options.dir, options.keep) };
}

/**
 * 滚动清理：只留最新 keep 份；顺带删掉 `.tmp-*` 孤儿（硬杀残留）。
 * 返回被删的文件名（日志与测试用）。
 */
export function pruneBackups(dir: string, keep: number): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name.startsWith('.tmp-')) {
      try {
        rmSync(join(dir, name));
        removed.push(name);
      } catch {
        // 删不掉不影响备份正确性
      }
    }
  }
  const keepCount = Math.max(1, keep);
  for (const entry of listBackups(dir).slice(keepCount)) {
    try {
      rmSync(join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // 已被外部删除等：忽略
    }
  }
  return removed;
}

/** 读一份备份；不存在/JSON 损坏/信封不合法 → null（调用方区分 404 与 400） */
export function readBackup(dir: string, name: string): BackupFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, name), 'utf-8'));
  } catch {
    return null;
  }
  if (!isBackupFile(raw)) return null;
  return raw;
}

/** 信封结构校验（bundle 自身的合法性交给 importBundle——它有完整的错误文案） */
export function isBackupFile(raw: unknown): raw is BackupFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const f = raw as Partial<BackupFile>;
  if (f.kind !== BACKUP_KIND || f.backupVersion !== BACKUP_VERSION) return false;
  if (typeof f.createdAt !== 'string') return false;
  return f.bundle !== null && typeof f.bundle === 'object';
}

export function deleteBackup(dir: string, name: string): void {
  rmSync(join(dir, name));
}
