import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DataVersionError,
  MIGRATION_BUNDLE_KIND,
  MIGRATION_BUNDLE_VERSION,
  MigrationError,
  OneCore,
  SCHEMA_VERSION,
} from '@one/core';
import {
  APP_VERSION_META_KEY,
  decideUpgrade,
  downgradeMessage,
  runUpgradeGate,
} from '../src/upgrade/upgrade-gate.js';
import { isValidBackupName, listBackups, performBackup, PRE_UPGRADE_KEEP } from '../src/backup/backup-service.js';
import type { MigrationBundle } from '@one/core';

/**
 * 升级闸门（长期迭代的第一道防线）。
 *
 * 覆盖四件事：判定纯函数、升级前备份（带水位、不进滚动清理）、降级拒绝启动、
 * 以及两个「静默通过」的老地雷（表结构降级、迁移包版本硬相等）。
 */

const emptyBundle = (workspaceId = 'default'): MigrationBundle => ({
  kind: MIGRATION_BUNDLE_KIND,
  bundleVersion: MIGRATION_BUNDLE_VERSION,
  nodeId: 'test-node',
  workspaceId,
  profileVersion: 0,
  eventCount: 0,
  createdAt: new Date(0).toISOString(),
  events: [],
});

describe('decideUpgrade：五态判定', () => {
  it('没打过戳 = 全新库', () => {
    expect(decideUpgrade(null, '0.4.0')).toEqual({ kind: 'fresh' });
  });

  it('同版本重启', () => {
    expect(decideUpgrade('0.4.0', '0.4.0')).toEqual({ kind: 'same', version: '0.4.0' });
  });

  it('戳低于当前 = 升级', () => {
    expect(decideUpgrade('0.4.0', '0.6.0')).toEqual({ kind: 'upgrade', from: '0.4.0', to: '0.6.0' });
  });

  it('戳高于当前 = 降级', () => {
    expect(decideUpgrade('0.6.0', '0.4.0')).toEqual({ kind: 'downgrade', from: '0.6.0', to: '0.4.0' });
  });

  it('补丁号也算升级（0.4.0 → 0.4.1）', () => {
    expect(decideUpgrade('0.4.0', '0.4.1').kind).toBe('upgrade');
  });

  it('当前版本解析不出来 = 闸门关闭（绝不误判成降级把用户锁在门外）', () => {
    expect(decideUpgrade('0.6.0', null).kind).toBe('disabled');
  });

  it('畸形戳按全新库处理：重新打戳，不拒绝', () => {
    expect(decideUpgrade('手改过的垃圾', '0.4.0')).toEqual({ kind: 'fresh' });
  });
});

describe('降级提示是人话', () => {
  it('同时说出数据目录的版本与当前程序的版本', () => {
    const msg = downgradeMessage('0.6.0', '0.4.0');
    expect(msg).toContain('v0.6.0');
    expect(msg).toContain('v0.4.0');
    expect(msg).toContain('-pre-upgrade');
  });
});

describe('runUpgradeGate：打戳与升级前备份', () => {
  let dbDir: string;
  let backupDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'one-gate-'));
    backupDir = join(dbDir, 'backups');
    dbPath = join(dbDir, 'onewms.db');
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  const gate = (appVersion: string | null) => {
    const core = OneCore.open(dbPath);
    try {
      return { core, report: runUpgradeGate({ core, workspaceId: 'default', appVersion, backupDir }) };
    } catch (err) {
      core.close();
      throw err;
    }
  };

  it('全新库：打戳，不生成备份（没什么可备的）', () => {
    const { core, report } = gate('0.4.0');
    try {
      expect(report.decision.kind).toBe('fresh');
      expect(report.backupName).toBeNull();
      expect(core.getMeta(APP_VERSION_META_KEY)).toBe('0.4.0');
      expect(listBackups(backupDir)).toHaveLength(0);
    } finally {
      core.close();
    }
  });

  it('同版本重启：不打戳也不备份', () => {
    const first = gate('0.4.0');
    first.core.close();
    const { core, report } = gate('0.4.0');
    try {
      expect(report.decision).toEqual({ kind: 'same', version: '0.4.0' });
      expect(report.backupName).toBeNull();
    } finally {
      core.close();
    }
  });

  it('升级：生成带 -pre-upgrade 标记的备份，信封里记着水位与前后版本', () => {
    const first = gate('0.4.0');
    first.core.close();

    const { core, report } = gate('0.6.0');
    try {
      expect(report.decision).toEqual({ kind: 'upgrade', from: '0.4.0', to: '0.6.0' });
      expect(report.backupName).toMatch(/-pre-upgrade\.json$/);
      expect(isValidBackupName(report.backupName!)).toBe(true); // 备份页能列、能恢复、能删

      const entries = listBackups(backupDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.preUpgrade).toBe(true);

      const file = JSON.parse(
        // 直接从磁盘读回：验证的是落盘形态，不是内存对象
        readFileSync(join(backupDir, report.backupName!), 'utf-8'),
      ) as { upgrade?: { fromVersion: string | null; toVersion: string; watermarks: unknown } };
      expect(file.upgrade).toEqual({ fromVersion: '0.4.0', toVersion: '0.6.0', watermarks: {} });
      expect(core.getMeta(APP_VERSION_META_KEY)).toBe('0.6.0');
    } finally {
      core.close();
    }
  });

  it('日常滚动清理不会把升级前备份挤掉（回滚燃料必须留住）', () => {
    // 文件名只精确到秒，同一秒内连灌十次会撞名互相覆盖 —— 拨表让每份各差一天，
    // 才是真实场景（备份按天滚、升级隔更久），也才能测到清理逻辑本身。
    vi.useFakeTimers({ toFake: ['Date'] });
    let preUpgradeName = '';
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1)));
      gate('0.4.0').core.close();

      vi.setSystemTime(new Date(Date.UTC(2026, 0, 2)));
      const second = gate('0.6.0'); // 产出 1 份 pre-upgrade
      preUpgradeName = second.report.backupName!;
      second.core.close();

      // 灌满日常滚动窗口再多几份
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 3 + i)));
        performBackup({ dir: backupDir, bundle: emptyBundle(), keep: 7 });
      }
    } finally {
      vi.useRealTimers();
    }

    const entries = listBackups(backupDir);
    expect(entries.filter((e) => !e.preUpgrade)).toHaveLength(7); // 日常的照旧只留 7 份
    expect(entries.some((e) => e.name === preUpgradeName)).toBe(true); // 升级前的还在
  });

  it(`升级前备份自己也有上限（${PRE_UPGRADE_KEEP} 份），不会无限攒`, () => {
    // 连续升级 7 次：第 1 次是全新库（没东西可备），后 6 次各产出一份升级前备份
    const versions = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0'];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      versions.forEach((v, i) => {
        vi.setSystemTime(new Date(Date.UTC(2026, i, 1)));
        gate(v).core.close();
      });
    } finally {
      vi.useRealTimers();
    }

    const kept = listBackups(backupDir).filter((e) => e.preUpgrade);
    expect(kept).toHaveLength(PRE_UPGRADE_KEEP);
    // 留的是最近的几份：最早的两个升级点被挤掉了（拨表从 2026-02 起，每次升级跨一个月）
    expect(kept.map((e) => e.createdAt)).toEqual(
      [6, 5, 4, 3, 2].map((month) => new Date(Date.UTC(2026, month, 1)).toISOString()),
    );
  });

  it('降级：拒绝启动，抛的是能给用户看的人话', () => {
    const first = gate('0.6.0');
    first.core.close();

    let caught: unknown;
    try {
      gate('0.4.0');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataVersionError);
    const msg = (caught as DataVersionError).message;
    expect(msg).toContain('v0.6.0');
    expect(msg).toContain('v0.4.0');
    // 没打戳：数据目录仍记着新版本，装对程序就能开
    const core = OneCore.open(dbPath);
    try {
      expect(core.getMeta(APP_VERSION_META_KEY)).toBe('0.6.0');
    } finally {
      core.close();
    }
  });

  it('闸门关闭（版本解析不出来）：不比对、不备份、不打戳', () => {
    const first = gate('0.6.0');
    first.core.close();

    const { core, report } = gate(null); // 换程序后拿不到版本号
    try {
      expect(report.decision.kind).toBe('disabled');
      expect(report.backupName).toBeNull();
      expect(core.getMeta(APP_VERSION_META_KEY)).toBe('0.6.0'); // 戳保持原样
      expect(listBackups(backupDir)).toHaveLength(0);
    } finally {
      core.close();
    }
  });
});

describe('表结构降级拒绝（core.migrate 的老地雷）', () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'one-schema-'));
    dbPath = join(dbDir, 'onewms.db');
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('库的 user_version 比程序新 → open 直接抛错，不再静默通过', () => {
    const core = OneCore.open(dbPath);
    core.exposeDb().pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    core.close();

    let caught: unknown;
    try {
      OneCore.open(dbPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataVersionError);
    expect((caught as DataVersionError).message).toContain(`v${SCHEMA_VERSION + 1}`);
    expect((caught as DataVersionError).message).toContain(`v${SCHEMA_VERSION}`);
  });

  it('同版本重开正常', () => {
    OneCore.open(dbPath).close();
    expect(() => OneCore.open(dbPath).close()).not.toThrow();
  });
});

describe('迁移包版本改为区间校验（读旧写新）', () => {
  let dbDir: string;
  let core: OneCore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'one-bundle-'));
    core = OneCore.open(join(dbDir, 'onewms.db'));
  });

  afterEach(() => {
    core.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('当前版本照常导入', () => {
    expect(() => core.migration.importBundle('default', emptyBundle())).not.toThrow();
  });

  it('比本程序新的包被拒（并提示先升级程序）', () => {
    const bundle = { ...emptyBundle(), bundleVersion: MIGRATION_BUNDLE_VERSION + 1 };
    expect(() => core.migration.importBundle('default', bundle)).toThrow(MigrationError);
    expect(() => core.migration.importBundle('default', bundle)).toThrow(/升级本节点程序/);
  });

  it('低于读旧下界的包被拒（提示支持区间，而不是硬相等）', () => {
    const bundle = { ...emptyBundle(), bundleVersion: 0 };
    expect(() => core.migration.importBundle('default', bundle)).toThrow(/v1 ~ v1/);
  });

  it('版本不是数字也算非法', () => {
    const bundle = { ...emptyBundle(), bundleVersion: '一' as unknown as number };
    expect(() => core.migration.importBundle('default', bundle)).toThrow(MigrationError);
  });
});
