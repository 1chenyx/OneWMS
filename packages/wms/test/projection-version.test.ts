import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_PROJECTION_VERSION,
  DataVersionError,
  OneCore,
  projectionMetaKey,
} from '@one/core';
import { WmsDomain, WMS_PROJECTION_VERSION } from '../src/index.js';

/**
 * 投影版本戳的领域端到端验证（层 1 存在的理由）。
 *
 * 要证明的不是「replay() 能重建投影」——那早就有测试了。要证明的是：
 * **改了派生语义之后，用户什么都不知道、什么都不用做，重开程序就自动重建**。
 * 所以每个用例都走「落盘库 → 关闭 → 篡改/回拨戳 → 重开」这条真实路径，
 * 并且必须有一个「戳没落后就不重建」的对照用例，否则无法区分
 * 「版本戳触发的重建」和「重开时 sync 顺手洗掉的」。
 */

const WS = 'default';
const wmsKey = projectionMetaKey('wms', WS);
const coreKey = projectionMetaKey('core', WS);

describe('投影版本戳：落后就整组重建', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'one-wms-pv-'));
    dbPath = join(dir, 'onewms.db');
    // 建库 + 走一次命令通道，让 oplog 里有真相、投影里有派生结果
    const core = OneCore.open(dbPath);
    const ws = WmsDomain.attach(core).workspace(WS);
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', extData: { spec: 'M6' } });
    core.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** 绕过命令通道直接改库（模拟损坏/旧语义残留），可选把某组戳回拨 */
  const tamper = (updates: string[], stamps: Array<[string, string]> = []) => {
    const core = OneCore.open(dbPath);
    const db = core.exposeDb();
    for (const sql of updates) db.prepare(sql).run();
    for (const [key, value] of stamps) {
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
    }
    core.close();
  };

  const reopen = () => {
    const core = OneCore.open(dbPath);
    return { core, ws: WmsDomain.attach(core).workspace(WS) };
  };

  it('首次打开就打上了两组戳（内核组 + 领域组），版本 = 代码里的常量', () => {
    const { core, ws } = reopen();
    try {
      expect(ws.skus.byCode('A-1')!.name).toBe('x');
      expect(core.getMeta(wmsKey)).toBe(String(WMS_PROJECTION_VERSION));
      expect(core.getMeta(coreKey)).toBe(String(CORE_PROJECTION_VERSION));
    } finally {
      core.close();
    }
  });

  it('领域组戳落后 → 重开自动重建 wms 投影，被改坏的数据冲回真值', async () => {
    tamper([`UPDATE wms_sku SET name = '旧语义残留' WHERE 1=1`], [[wmsKey, '0']]);

    const { core, ws } = reopen();
    try {
      // 没有任何人写迁移脚本、没有任何人调 replay()：只是重开了程序
      expect(ws.skus.byCode('A-1')!.name).toBe('x');
      expect(core.getMeta(wmsKey)).toBe(String(WMS_PROJECTION_VERSION)); // 重建后戳追上
    } finally {
      core.close();
    }
  });

  it('对照：戳没落后 → 不重建，篡改原样留着（证明上面那次重建确实是版本戳触发的）', async () => {
    tamper([`UPDATE wms_sku SET name = '旧语义残留' WHERE 1=1`]);

    const { core, ws } = reopen();
    try {
      expect(ws.skus.byCode('A-1')!.name).toBe('旧语义残留');
      expect(core.getMeta(wmsKey)).toBe(String(WMS_PROJECTION_VERSION));
    } finally {
      core.close();
    }
  });

  it('内核组戳落后 → 重开自动重建 field_registry，与领域组互不牵连', async () => {
    // 只回拨内核组的戳：领域组保持当前版本，不该被重建
    tamper(
      [`UPDATE field_registry SET visible = 0 WHERE 1=1`, `UPDATE wms_sku SET name = '不该被动' WHERE 1=1`],
      [[coreKey, '0']],
    );

    const { core, ws } = reopen();
    try {
      expect(ws.fields.get('sku', 'spec')!.visible).toBe(true); // 内核投影被重建
      expect(core.getMeta(coreKey)).toBe(String(CORE_PROJECTION_VERSION));
      expect(ws.skus.byCode('A-1')!.name).toBe('不该被动'); // 领域组戳没落后 → 没动
      expect(core.getMeta(wmsKey)).toBe(String(WMS_PROJECTION_VERSION));
    } finally {
      core.close();
    }
  });

  it('戳超前（库被更新版本重建过）→ 拒绝打开工作区，抛人话且不改动戳', () => {
    tamper([], [[wmsKey, String(WMS_PROJECTION_VERSION + 1)]]);

    const core = OneCore.open(dbPath);
    let caught: unknown;
    try {
      WmsDomain.attach(core).workspace(WS);
    } catch (err) {
      caught = err;
    } finally {
      // 戳必须原样留着：用户装回新版本程序就能正常打开
      expect(core.getMeta(wmsKey)).toBe(String(WMS_PROJECTION_VERSION + 1));
      core.close();
    }

    expect(caught).toBeInstanceOf(DataVersionError);
    const msg = (caught as DataVersionError).message;
    expect(msg).toContain(`v${WMS_PROJECTION_VERSION + 1}`);
    expect(msg).toContain(`v${WMS_PROJECTION_VERSION}`);
    expect(msg).toContain('wms');
  });

  it('多工作区：只回拨 ws-a 的戳，ws-b 不受影响', async () => {
    const seed = OneCore.open(dbPath);
    const domain = WmsDomain.attach(seed);
    domain.workspace('ws-a');
    await domain.workspace('ws-b').tools.invoke('wms.sku.create', { skuCode: 'B-1', name: 'b' });
    seed.close();

    const t = OneCore.open(dbPath);
    t.exposeDb()
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run('0', projectionMetaKey('wms', 'ws-a'));
    t.close();

    const core = OneCore.open(dbPath);
    try {
      const d = WmsDomain.attach(core);
      d.workspace('ws-a'); // 落后 → 重建
      d.workspace('ws-b'); // 当前 → 不动
      expect(core.getMeta(projectionMetaKey('wms', 'ws-a'))).toBe(String(WMS_PROJECTION_VERSION));
      expect(core.getMeta(projectionMetaKey('wms', 'ws-b'))).toBe(String(WMS_PROJECTION_VERSION));
      expect(d.workspace('ws-b').skus.byCode('B-1')!.name).toBe('b');
    } finally {
      core.close();
    }
  });
});
