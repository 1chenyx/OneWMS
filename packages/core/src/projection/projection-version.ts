import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DataVersionError } from '../errors.js';

/**
 * 投影版本戳 —— 「改了派生规则就 bump 版本号，下次启动自动整组重建」。
 *
 * 为什么需要它：投影是缓存，oplog 才是真相（§8）。缓存的正确性取决于
 * 「生成它的那套 reducer」与「现在这套 reducer」是否一致。表结构能靠
 * ALTER/CREATE IF NOT EXISTS 前滚，但**派生语义的变化在表结构上不留痕迹**——
 * 拆一张表、改一个聚合口径、把某字段从「快照」改成「累计」，SQL 全都能跑通，
 * 只是算出来的数是错的。旧办法是每次改动都手写一段 `pragma table_info` 探测
 * 去 DROP 受影响的表（见 wms/db/migrations.ts 的老库收敛段），忘写一处就静默错账。
 *
 * 版本戳把这层纪律从「记得写探测代码」降级成「记得改一个数字」，并且数字就写在
 * 你要改的那个投影文件里（WMS_PROJECTION_VERSION / MEMORY_PROJECTION_VERSION /
 * CORE_PROJECTION_VERSION）。判定与重建全自动，不需要迁移脚本。
 *
 * 粒度：**投影组 × 工作区**。一个域的所有投影共用一个版本号——组内整建，
 * 不搞逐表版本。理由是投影之间互相依赖（单据 → 库存 → 批次），单独重建一张
 * 会得到跨表不一致的中间态；而全量重放本来就是幂等的自检路径，成本可接受。
 *
 * 戳存在 meta 表（key = `projection.<group>.<workspaceId>`）。meta 是全局单值表、
 * 无工作区维度，所以工作区编码进键名——多工作区同库时各算各的。
 */

/** meta 表里的键前缀；完整键见 projectionMetaKey() */
export const PROJECTION_META_PREFIX = 'projection.';

export function projectionMetaKey(group: string, workspaceId: string): string {
  return `${PROJECTION_META_PREFIX}${group}.${workspaceId}`;
}

export type ProjectionVersionDecision =
  /** 库里没戳：全新库，或本机制上线之前的老库 */
  | { kind: 'fresh' }
  /** 戳 == 代码版本：什么都不用做 */
  | { kind: 'current'; version: number }
  /** 戳 < 代码版本：投影是旧语义算出来的，必须整组重建 */
  | { kind: 'rebuild'; from: number; to: number }
  /** 戳 > 代码版本：库被更新版本的程序重建过，当前程序的派生规则对不上 */
  | { kind: 'ahead'; from: number; to: number };

/**
 * 纯函数判定。
 *
 * 畸形戳（手改过、非整数、负数、空串）按 fresh 处理：读不懂的值拦下来没有意义，
 * 还会把用户锁在门外。与 upgrade-gate 的 decideUpgrade 同一条纪律。
 *
 * 用正则而不是 `Number(s)` 判合法性：`Number('') === 0`、`Number(' ') === 0`，
 * 空戳会被当成「版本 0」触发一次无谓的全量重建。
 */
const VERSION_RE = /^\d+$/;

export function decideProjectionVersion(stamped: string | null, codeVersion: number): ProjectionVersionDecision {
  if (stamped === null || !VERSION_RE.test(stamped)) return { kind: 'fresh' };
  const n = Number(stamped);
  if (n === codeVersion) return { kind: 'current', version: n };
  return n < codeVersion
    ? { kind: 'rebuild', from: n, to: codeVersion }
    : { kind: 'ahead', from: n, to: codeVersion };
}

/** 投影版本超前时给用户看的话（与表结构降级、app 版本降级同一套口径） */
export function projectionAheadMessage(group: string, from: number, to: number): string {
  return (
    `此数据目录的「${group}」投影由更新版本的 OneWMS 重建过（投影版本 v${from}），` +
    `而当前程序只到 v${to}。旧程序的派生规则与新投影对不上，硬开只会悄悄算错账目，因此拒绝启动。\n` +
    `解决办法：安装更新版本的 OneWMS；\n` +
    `若确实要继续使用当前版本，请先用新版本从「升级前备份」恢复数据，再启动本程序。`
  );
}

/**
 * 校验并在需要时重建一组投影。**在各域工作区门面的构造期、首次追账之前调用**。
 *
 * 顺序纪律：先 rebuild 再打戳。反过来（先打戳后重建）一旦重建失败，库里就留下
 * 一个「宣称是新的、其实是旧的」的戳——从此再也不会重建，静默错账。现在这样
 * 最多是重放两次（幂等，只是慢一点），与 upgrade-gate「备份成功才打戳」同理。
 *
 * rebuild 由各域传自己的 replay()：它自带事务、自带清空 + 游标复位 + 全量重放，
 * core 不该知道领域投影长什么样（领域隔离铁律）。
 */
export function ensureProjectionVersion(
  db: SqliteDatabase,
  options: {
    group: string;
    workspaceId: string;
    codeVersion: number;
    /** 整组重建（= 该域的 replay()）；只在 rebuild 判定下被调用一次 */
    rebuild: () => void;
  },
): ProjectionVersionDecision {
  const { group, workspaceId, codeVersion, rebuild } = options;
  const key = projectionMetaKey(group, workspaceId);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  const decision = decideProjectionVersion(row?.value ?? null, codeVersion);

  if (decision.kind === 'ahead') {
    throw new DataVersionError(projectionAheadMessage(group, decision.from, decision.to));
  }
  if (decision.kind === 'current') return decision;

  // fresh 只打戳不重建：全新库没东西可建；本机制上线之前的老库，其收敛仍由
  // 各域 migrate 期的结构探测负责（现状不变，不给升级日增加一次全量重放的风险）。
  // 从今往后改派生语义只需 bump 版本号 —— 那条路径一定会走 rebuild。
  if (decision.kind === 'rebuild') rebuild();

  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(codeVersion));
  return decision;
}
