import { createRequire } from 'node:module';
import { compareSemver, DataVersionError, type OneCore } from '@one/core';
import type { AiProviderConfig } from '@one/ai';
import { performPreUpgradeBackup } from '../backup/backup-service.js';
import type { AiConfigCatalog } from '../ai-config-store.js';

/**
 * 升级闸门 —— 长期迭代下「用户更新出问题」的第一道防线。
 *
 * 系统会一直改：表结构会变、流程会变、投影会重建。用户那边的数据目录却
 * 是活的、只有一份。闸门在启动装配期做三件事：
 *
 *  1. **比对**：程序版本 vs 数据目录里记的版本（meta.app_version）。
 *     表结构版本（pragma user_version）的降级拒绝在 core migrate() 里，
 *     那里更早、且拿不到 meta（还没建表就可能炸）——两处合起来才是完整的门。
 *  2. **升级 → 先备份**：带 -pre-upgrade 标记 + 各 actor 水位 (seq, lamport)，
 *     不进日常滚动清理。这份包是回滚的全部原料：截断水位之后的事件再重放，
 *     旧代码看到的世界完全自洽。
 *  3. **降级 → 拒绝启动**：旧程序打开新数据不会报错，只会静默写坏投影
 *     （表在、语义变了）。宁可拦住并说人话，也不要让用户三天后发现账不对。
 *
 * 打戳时机：备份成功之后。备份失败（磁盘满等）则**不打戳**——下次启动会
 * 再判为升级、再试一次备份，同时本次照常放行（不能因为保险柜打不开就不让进屋）。
 */

/** meta 表里记录「最后一次打开这个数据目录的程序版本」的键 */
export const APP_VERSION_META_KEY = 'app_version';

const require = createRequire(import.meta.url);

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * 当前程序版本的单一来源；解析不出来返回 null（= 闸门关闭）。
 *
 * 优先级：桌面壳注入的 ONE_APP_VERSION（= Cargo.toml / tauri.conf.json 的版本，
 * 也就是用户在「关于」和安装包上看到的那个）> @one/server 自己的 package.json。
 * 后者兜底是给裸跑 node dist/main.js 的开发/服务端场景。
 *
 * 解析失败必须返回 null 而不是 '0.0.0' 之类的哨兵：哨兵会被判成「降级」，
 * 把用户锁在门外——闸门宁可关掉，也不能误伤。
 */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const injected = env.ONE_APP_VERSION?.trim();
  if (injected) return injected;
  try {
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null; // 打包产物里没带上 package.json（资源裁剪等）
  }
}

/** 闸门判定结果（from/to 只在 upgrade/downgrade 上有值） */
export type GateDecision =
  /** 拿不到当前程序版本：闸门整体关闭，什么都不做也不打戳 */
  | { kind: 'disabled'; reason: string }
  /** 数据目录从没被打过戳：全新安装，或闸门上线之前的老库 */
  | { kind: 'fresh' }
  /** 同版本重启：什么都不做 */
  | { kind: 'same'; version: string }
  | { kind: 'upgrade'; from: string; to: string }
  | { kind: 'downgrade'; from: string; to: string };

/**
 * 纯函数判定：戳（可能没有/可能畸形）× 当前版本 → 五态。
 *
 * 畸形戳（手改过、老版本写的非 semver）按 fresh 处理：重新打戳，
 * 不做备份也不拒绝——拦一个读不懂的字符串没有意义，还会把用户锁在门外。
 */
export function decideUpgrade(stamped: string | null, current: string | null): GateDecision {
  if (current === null) return { kind: 'disabled', reason: '未解析出当前程序版本' };
  if (stamped === null || !SEMVER_RE.test(stamped)) return { kind: 'fresh' };
  const cmp = compareSemver(stamped, current);
  if (cmp === 0) return { kind: 'same', version: current };
  if (cmp < 0) return { kind: 'upgrade', from: stamped, to: current };
  return { kind: 'downgrade', from: stamped, to: current };
}

/** 降级时给用户看的话（不是堆栈——是能让非技术用户下一步做什么） */
export function downgradeMessage(from: string, to: string): string {
  return (
    `此数据目录被 OneWMS v${from} 使用过，而当前程序是 v${to}。` +
    `旧版本程序打不开新版本写下的数据（表结构与流程语义可能已经变化，硬开只会悄悄写坏账目），因此拒绝启动。\n` +
    `解决办法：安装 v${from} 或更新的 OneWMS；\n` +
    `若确实要退回 v${to}，请先用新版本从「升级前备份」（backups 目录里文件名带 -pre-upgrade 的那份）恢复数据，再启动本程序。`
  );
}

export interface UpgradeGateReport {
  readonly decision: GateDecision;
  /** null = 闸门关闭（未解析出程序版本） */
  readonly appVersion: string | null;
  /** 升级前备份的文件名；未产生（同版本/全新库/无落盘位/备份失败）→ null */
  readonly backupName: string | null;
  /** 备份为什么没做成（backupName 为 null 且本应备份时才有值，用于日志） */
  readonly backupSkippedReason?: string;
}

/**
 * 跑闸门。必须在领域装配（WmsDomain.attach / modules.install）**之前**调用：
 * 那一刻的账本水位就是「旧版本的最后状态」，新代码一条事件都还没落。
 */
export function runUpgradeGate(options: {
  core: OneCore;
  workspaceId: string;
  appVersion: string | null;
  /** null = 宿主无落盘位（内存库），备份整体禁用 */
  backupDir: string | null;
  aiConfig?: AiProviderConfig;
  aiCatalog?: AiConfigCatalog;
}): UpgradeGateReport {
  const { core, workspaceId, appVersion, backupDir } = options;
  const decision = decideUpgrade(core.getMeta(APP_VERSION_META_KEY), appVersion);

  if (decision.kind === 'downgrade') {
    throw new DataVersionError(downgradeMessage(decision.from, decision.to));
  }
  if (appVersion === null || decision.kind === 'disabled' || decision.kind === 'same') {
    return { decision, appVersion, backupName: null };
  }

  // fresh 也走这里：全新库没什么可备的，但要打戳，否则下次启动还算 fresh
  let backupName: string | null = null;
  let backupSkippedReason: string | undefined;
  /** 本次没做成备份、但也不该因此卡住打戳（= 备份根本不是必需的） */
  const backupNotNeeded = decision.kind === 'fresh' || backupDir === null;
  if (decision.kind === 'upgrade') {
    if (backupDir === null) {
      backupSkippedReason = '宿主无可写数据目录（内存库），跳过升级前备份';
    } else {
      try {
        const result = performPreUpgradeBackup({
          dir: backupDir,
          bundle: core.migration.exportBundle(workspaceId),
          ...(options.aiConfig ? { aiConfig: options.aiConfig } : {}),
          ...(options.aiCatalog ? { aiCatalog: options.aiCatalog } : {}),
          upgrade: {
            fromVersion: decision.from,
            toVersion: decision.to,
            // 水位在导出之后取也无妨：exportBundle 只读不写，两者之间没有事件产生
            watermarks: core.workspace(workspaceId).events.watermarks(),
          },
        });
        backupName = result.name;
      } catch (err) {
        backupSkippedReason = `升级前备份失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // 备份没做成就不打戳：下次启动仍判为升级，会再试一次（保险柜没锁上，不假装锁了）
  if (backupName !== null || backupNotNeeded) {
    core.setMeta(APP_VERSION_META_KEY, appVersion);
  }

  return {
    decision,
    appVersion,
    backupName,
    ...(backupSkippedReason ? { backupSkippedReason } : {}),
  };
}
