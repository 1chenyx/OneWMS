import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearProjectionTables,
  ensureProjectionVersion,
  OneCore,
  projectionMetaKey,
  type ProjectionGroupSpec,
} from '@one/core';
import { WmsDomain, WMS_PROJECTION_GROUP, WMS_PROJECTION_VERSION } from '../src/index.js';

/**
 * WMS 投影组元数据（EXTENSIBILITY B.0）。
 *
 * 两个必须成立的性质：
 *  1. **清单完整**：clear() 照 WMS_PROJECTION_GROUP.tables 执行，漏登记一张表
 *     → 重放时旧行还在新行又插一遍 → 库存翻倍这类静默错账。所以拿 sqlite_master
 *     对着校验，新建 wms_* 表忘了登记会当场红。
 *  2. **组间隔离**：新增一组投影并 bump 它，只重建那一组，WMS 十表纹丝不动。
 *     这是「加投影不必拖着整域全量重放」的验收线。
 */

const WS = 'default';

/**
 * 额外投影组的样例：从 oplog 派生「每个 SKU 一行备注」，独占 xtra_note 表。
 * 表名刻意不带 wms_ 前缀 —— wms_* 全部属于 wms 组，是上面那条清单守卫的前提。
 */
const EXTRA_TABLE = 'xtra_note';
const EXTRA_GROUP_V1: ProjectionGroupSpec = {
  group: 'wms-extra',
  codeVersion: 1,
  tables: [{ table: EXTRA_TABLE }],
};

describe('WMS 投影组元数据', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'one-wms-pg-'));
    dbPath = join(dir, 'onewms.db');
    const core = OneCore.open(dbPath);
    const ws = WmsDomain.attach(core).workspace(WS);
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-2', name: 'y' });
    core.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reopen = () => {
    const core = OneCore.open(dbPath);
    return { core, ws: WmsDomain.attach(core).workspace(WS) };
  };

  const count = (db: ReturnType<OneCore['exposeDb']>, table: string, workspaceId = WS) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId) as { n: number }).n;

  /**
   * 把额外组挂到已打开的库上：建表 + 版本戳校验。
   * rebuild 一并返回，因为 fresh 判定只打戳不重建（首建走正常追账路径）。
   */
  const attachExtraGroup = (core: OneCore, ws: ReturnType<WmsDomain['workspace']>, codeVersion: number) => {
    const db = core.exposeDb();
    db.exec(`CREATE TABLE IF NOT EXISTS ${EXTRA_TABLE} (workspace_id TEXT NOT NULL, note TEXT NOT NULL)`);
    const rebuild = () => {
      db.transaction(() => {
        clearProjectionTables(db, WS, EXTRA_GROUP_V1.tables);
        const ins = db.prepare(`INSERT INTO ${EXTRA_TABLE} (workspace_id, note) VALUES (?, ?)`);
        ws.events.forEach((env) => {
          if (env.type === 'wms.sku.created') {
            ins.run(WS, `派生自 ${(env.payload as { skuCode?: string }).skuCode ?? '?'}`);
          }
        }, { fromLamport: -1 });
      })();
    };
    const decision = ensureProjectionVersion(db, {
      group: EXTRA_GROUP_V1.group,
      workspaceId: WS,
      codeVersion,
      rebuild,
    });
    return { decision, rebuild };
  };

  it('清单与库里的 wms_* 表一一对应（新建表忘登记会红）', () => {
    const { core } = reopen();
    try {
      const rows = core
        .exposeDb()
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wms_%'`)
        .all() as Array<{ name: string }>;
      const declared = WMS_PROJECTION_GROUP.tables.map((t) => t.table);
      expect(new Set(declared).size).toBe(declared.length); // 清单里没有重复登记
      expect([...declared].sort()).toEqual(rows.map((r) => r.name).sort());
    } finally {
      core.close();
    }
  });

  it('组名与版本号来自同一份元数据，不散落在调用点', () => {
    expect(WMS_PROJECTION_GROUP.group).toBe('wms');
    expect(WMS_PROJECTION_GROUP.codeVersion).toBe(WMS_PROJECTION_VERSION);
    expect(projectionMetaKey(WMS_PROJECTION_GROUP.group, WS)).toBe('projection.wms.default');
  });

  it('replay() 照清单清空并重放：投影回到真值，其他工作区不受牵连', async () => {
    const seed = OneCore.open(dbPath);
    await WmsDomain.attach(seed).workspace('ws-b').tools.invoke('wms.sku.create', { skuCode: 'B-1', name: 'b' });
    seed.close();

    const { core, ws } = reopen();
    try {
      const db = core.exposeDb();
      // 直接改坏投影（全库），再看 replay() 能不能把本工作区冲回真值
      db.prepare(`UPDATE wms_sku SET name = '旧语义残留' WHERE 1=1`).run();
      ws.replay();

      expect(ws.skus.byCode('A-1')!.name).toBe('x');
      expect(ws.skus.byCode('A-2')!.name).toBe('y');
      // 清完确实重放回来了，不是「清光了事」
      expect(count(db, 'wms_sku') >= 2).toBe(true);
      // 别的工作区既没被清、也没被重建：replay 只认本工作区
      expect(count(db, 'wms_sku', 'ws-b')).toBe(1);
      expect(
        (db.prepare(`SELECT name FROM wms_sku WHERE workspace_id = 'ws-b'`).get() as { name: string }).name,
      ).toBe('旧语义残留');
    } finally {
      core.close();
    }
  });

  it('新增一组并 bump：只重建新组，WMS 十表不动', () => {
    // 先把额外组建起来并打上 v1 戳（模拟上一版程序跑过）
    const first = OneCore.open(dbPath);
    const firstWs = WmsDomain.attach(first).workspace(WS);
    const seeded = attachExtraGroup(first, firstWs, 1);
    expect(seeded.decision.kind).toBe('fresh');
    seeded.rebuild(); // fresh 只打戳；首建由正常追账路径完成，这里手动跑一次
    expect(count(first.exposeDb(), EXTRA_TABLE)).toBe(2);
    first.close();

    // 再开一次：把 wms_sku 改坏但戳保持当前（不该被重建），额外组 bump 到 v2
    const { core, ws } = reopen();
    try {
      const db = core.exposeDb();
      db.prepare(`UPDATE wms_sku SET name = '不该被动' WHERE 1=1`).run();
      const { decision } = attachExtraGroup(core, ws, 2);

      expect(decision).toEqual({ kind: 'rebuild', from: 1, to: 2 });
      expect(core.getMeta(projectionMetaKey('wms-extra', WS))).toBe('2');
      expect(count(db, EXTRA_TABLE)).toBe(2); // 新组重建完成
      // WMS 组戳没落后 → 十表纹丝不动，被改坏的值原样留着
      expect(ws.skus.byCode('A-1')!.name).toBe('不该被动');
      expect(core.getMeta(projectionMetaKey('wms', WS))).toBe(String(WMS_PROJECTION_VERSION));
    } finally {
      core.close();
    }
  });

  it('反过来也成立：WMS 组 bump 不会碰额外组的表', () => {
    const first = OneCore.open(dbPath);
    attachExtraGroup(first, WmsDomain.attach(first).workspace(WS), 1).rebuild();
    first.close();

    const core = OneCore.open(dbPath);
    const db = core.exposeDb();
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('0', projectionMetaKey('wms', WS));
    db.prepare(`UPDATE ${EXTRA_TABLE} SET note = '额外组自己的数据' WHERE 1=1`).run();
    const ws = WmsDomain.attach(core).workspace(WS); // wms 组落后 → 整组重建
    try {
      expect(core.getMeta(projectionMetaKey('wms', WS))).toBe(String(WMS_PROJECTION_VERSION));
      expect(ws.skus.byCode('A-1')!.name).toBe('x');
      const notes = db.prepare(`SELECT DISTINCT note FROM ${EXTRA_TABLE}`).all() as Array<{ note: string }>;
      expect(notes).toEqual([{ note: '额外组自己的数据' }]);
    } finally {
      core.close();
    }
  });
});
