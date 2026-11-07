import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 已配对同步节点的持久化位（扫码组网）。
 *
 * 0 基础用户的痛点：ONE_SYNC_PEERS 是环境变量——改一次要重启，还得知道
 * 「环境变量」是什么。这里给节点一个可写清单（dbPath 同目录的 peers.json），
 * 页面上添加/移除即刻生效，重启也在。
 *
 * 明文 JSON 与 ai-config.json 同级的本地可信域假设（§9.2 本地优先）；
 * 写法用 temp + rename 原子落盘——桌面版被硬杀不留半个文件。
 */

/** 清单文件名（dbPath 同目录；ONE_PEERS_PATH 可显式覆盖） */
export const PEERS_FILE = 'peers.json';

/** 清单结构版本（将来加字段时的迁移判据） */
export const PEERS_VERSION = 1;

export interface PeerRecord {
  /** 归一后的对端基址（http(s)://host:port，无尾斜杠）——比较与落盘一律用它 */
  url: string;
  /** 首次握手拿到的对端节点 ID（自拉防护与「已配对」真相面；握手未成功则无） */
  nodeId?: string;
  /** 配对时刻（ISO） */
  addedAt: string;
}

export interface PeerStoreFile {
  version: typeof PEERS_VERSION;
  peers: PeerRecord[];
}

/** dbPath → 清单路径；:memory: 宿主无落盘位 → null（配对仅进程内生效） */
export function resolvePeersPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_PEERS_PATH === 'string' && env.ONE_PEERS_PATH.trim()) {
    return env.ONE_PEERS_PATH;
  }
  if (dbPath === ':memory:') return null;
  return resolve(dirname(resolve(dbPath)), PEERS_FILE);
}

export type NormalizeResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * 对端地址归一（比较/落盘/请求三处共用同一结果，防「同节点两条记录」）。
 * 只认 http(s)（局域网明文可信段），host 小写，默认端口不省——省了会让
 * 「http://a:3000」与「http://a」判为两条而实际指向不同服务。
 */
export function normalizePeerUrl(raw: unknown): NormalizeResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: '对端地址不能为空' };
  }
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, message: `对端地址不合法：${text}（要形如 http://192.168.1.20:3000）` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: '对端地址必须以 http:// 或 https:// 开头' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: `对端地址缺少主机名：${text}` };
  }
  // origin 已含协议 + 小写 host + 端口，且无路径/查询/尾斜杠
  return { ok: true, url: parsed.origin };
}

/** 读清单：不存在/损坏/结构非法 → []（不阻断启动，也不让坏文件毁掉同步） */
export function readPeers(path: string | null): PeerRecord[] {
  if (path === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  if (!isPeerStoreFile(raw)) {
    console.warn(`[one-server] 同步节点清单不合法，已忽略（${path}）`);
    return [];
  }
  return raw.peers;
}

function isPeerStoreFile(raw: unknown): raw is PeerStoreFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const file = raw as { peers?: unknown };
  if (!Array.isArray(file.peers)) return false;
  return file.peers.every(
    (p) =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as PeerRecord).url === 'string' &&
      typeof (p as PeerRecord).addedAt === 'string',
  );
}

/** 写清单（覆盖式，temp + rename 原子落盘） */
export function writePeers(path: string, peers: PeerRecord[]): void {
  const file: PeerStoreFile = { version: PEERS_VERSION, peers };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, path);
}

/**
 * 落盘位为 null（:memory: 宿主）时的进程内清单——语义与文件面一致，
 * 只是不落盘。测试与内存宿主用它，路由层不必分叉。
 */
export function createPeerStore(path: string | null): PeerStore {
  let memory: PeerRecord[] = [];
  return {
    get path() {
      return path;
    },
    list: () => (path === null ? [...memory] : readPeers(path)),
    /** 同 URL 幂等更新（保留原 addedAt，刷新 nodeId）；返回归一后的记录 */
    upsert(url: string, nodeId?: string): PeerRecord {
      const peers = path === null ? memory : readPeers(path);
      const existing = peers.find((p) => p.url === url);
      const record: PeerRecord = existing ?? { url, addedAt: new Date().toISOString() };
      if (nodeId !== undefined) record.nodeId = nodeId;
      const next = [...peers.filter((p) => p.url !== url), record].sort((a, b) =>
        a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0,
      );
      if (path === null) memory = next;
      else writePeers(path, next);
      return record;
    },
    /** 移除；返回是否真的删掉了（false = 本来就没有，幂等） */
    remove(url: string): boolean {
      const peers = path === null ? memory : readPeers(path);
      const next = peers.filter((p) => p.url !== url);
      if (next.length === peers.length) return false;
      if (path === null) memory = next;
      else writePeers(path, next);
      return true;
    },
  };
}

export interface PeerStore {
  /** null = 宿主无落盘位（配对只在进程内有效） */
  readonly path: string | null;
  list(): PeerRecord[];
  upsert(url: string, nodeId?: string): PeerRecord;
  remove(url: string): boolean;
}

/** 合并多个来源并去重（store ∪ env ∪ 请求体），保持首次出现顺序 */
export function mergePeerUrls(...sources: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const raw of source ?? []) {
      const normalized = normalizePeerUrl(raw);
      if (!normalized.ok) continue; // 环境变量里的手写错值：跳过而不是炸掉整轮
      if (seen.has(normalized.url)) continue;
      seen.add(normalized.url);
      out.push(normalized.url);
    }
  }
  return out;
}

/** env ONE_SYNC_PEERS → 数组（逗号/中文逗号/换行分隔，与前端输入解析一致） */
export function envPeers(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ONE_SYNC_PEERS ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
