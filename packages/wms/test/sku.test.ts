import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { OneCore, ToolValidationError } from '@one/core';
import {
  WmsDomain,
  SkuAlreadyExistsError,
  SkuBarcodeExistsError,
  SkuNotFoundError,
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
} from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
});

afterEach(() => {
  core.close();
});

describe('SKU：创建与更新', () => {
  it('工具创建 SKU → 事件落账 → 投影可见', async () => {
    const result = await ws.tools.invoke(
      'wms.sku.create',
      { skuCode: 'A-1001', name: 'M6 螺丝', extData: { spec: '不锈钢' } },
      'ai:test',
    );

    expect(result).toMatchObject({ skuCode: 'A-1001', name: 'M6 螺丝' });
    const sku = ws.skus.byCode('A-1001');
    expect(sku).toBeDefined();
    expect(sku!.name).toBe('M6 螺丝');
    expect(sku!.extData).toEqual({ spec: '不锈钢' });
    expect(sku!.id).toBe((result as { skuId: string }).skuId);

    // wms. 命名空间里有且仅有一条创建事件（构造期另有种子事件：字段 provide + config.change）
    const types: string[] = [];
    ws.events.forEach((e) => {
      if (e.type.startsWith('wms.')) types.push(e.type);
    });
    expect(types).toEqual(['wms.sku.created']);
  });

  it('重复编码 → 拒绝且不产生第二个事件（命令失败 ≠ 事实）', async () => {
    const baseline = ws.events.count(); // 构造期种子事件之后
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'y' }),
    ).rejects.toThrow(SkuAlreadyExistsError);

    expect(ws.skus.list()).toHaveLength(1);
    expect(ws.events.count()).toBe(baseline + 1);
  });

  it('更新名称与扩展字段（未传字段保持不变）', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: '旧名',
      extData: { spec: '塑料' },
    });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', name: '新名' });

    const sku = ws.skus.byCode('A-1')!;
    expect(sku.name).toBe('新名');
    expect(sku.extData).toEqual({ spec: '塑料' }); // extData 未传 → 保持

    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', extData: { spec: '金属' } });
    expect(ws.skus.byCode('A-1')!.extData).toEqual({ spec: '金属' });
  });

  it('更新不存在的 SKU → SkuNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.sku.update', { skuCode: 'ghost', name: 'x' }),
    ).rejects.toThrow(SkuNotFoundError);
  });

  it('参数校验：缺必填 → ToolValidationError（schema 层拦截，未进 handler）', async () => {
    await expect(ws.tools.invoke('wms.sku.create', { skuCode: 'A-1' })).rejects.toThrow(
      ToolValidationError,
    );
  });

  it('list() 暴露工具元数据（handler 不可见——AI 上下文安全）', () => {
    const metas = ws.tools.list().filter((t) => t.id.startsWith('wms.'));
    expect(metas.length).toBeGreaterThanOrEqual(6);
    for (const m of metas) {
      expect(m).not.toHaveProperty('handler');
      expect(m.description).toBeTruthy();
    }
  });
});

describe('条码管理（M18）', () => {
  function countEvents(): number {
    let n = 0;
    ws.events.forEach(() => n++);
    return n;
  }

  it('创建带条码 → 投影可见（含两端空白 trim 规整）', async () => {
    const r = await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1001',
      name: '螺丝',
      barcode: ' 6901234567892 ',
    });
    expect(r).toMatchObject({ barcode: '6901234567892' });

    const sku = ws.skus.byBarcode('6901234567892')!;
    expect(sku.skuCode).toBe('A-1001');
    expect(ws.skus.byCode('A-1001')!.barcode).toBe('6901234567892');
  });

  it('条码同库唯一：他人占用 → 拒且零事件', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: 'x',
      barcode: '6901',
    });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: 'y', barcode: '6901' }),
    ).rejects.toThrow(SkuBarcodeExistsError);
    expect(ws.skus.list()).toHaveLength(1);
    expect(countEvents()).toBe(before);

    // 抢码：update 换绑他人条码同样拒绝
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: 'y' });
    await expect(
      ws.tools.invoke('wms.sku.update', { skuCode: 'B-2', barcode: '6901' }),
    ).rejects.toThrow(/6901 已被 SKU A-1 使用/);
    expect(ws.skus.byCode('B-2')!.barcode).toBeNull();
  });

  it('多个 SKU 不带条码共存（SQLite 多 NULL 不冲突）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: 'y' });
    expect(ws.skus.list().every((s) => s.barcode === null)).toBe(true);
  });

  it('更新条码：显式传才改，未传保持；自己重复声明同码放行', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', barcode: '6901' });

    // 未传 barcode → 保持
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', name: '新名' });
    expect(ws.skus.byCode('A-1')!.barcode).toBe('6901');

    // 显式传 → 换绑
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: '6902' });
    expect(ws.skus.byCode('A-1')!.barcode).toBe('6902');
    expect(ws.skus.byBarcode('6901')).toBeUndefined();

    // 自己声明自己的（新）条码 → 放行（占用者即自身）
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: '6902' });
    expect(ws.skus.byCode('A-1')!.barcode).toBe('6902');
  });

  it('空白条码 → TOOL_REJECTED（不落事件；不设置条码应不传该字段）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'B-1', name: 'y', barcode: '   ' }),
    ).rejects.toThrow(/barcode/);
    await expect(
      ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: ' ' }),
    ).rejects.toThrow(/barcode/);
    expect(countEvents()).toBe(before);
    expect(ws.skus.list()).toHaveLength(1);
  });

  it('wms.sku.resolve：条码 → SKU（幂等读，零事件）', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1001',
      name: '螺丝',
      barcode: '6901234567892',
    });
    const before = countEvents();

    const r = await ws.tools.invoke('wms.sku.resolve', { barcode: '6901234567892' });
    expect(r).toMatchObject({ skuCode: 'A-1001', name: '螺丝', barcode: '6901234567892' });

    // 未登记条码 → SkuNotFoundError
    await expect(ws.tools.invoke('wms.sku.resolve', { barcode: 'unknown' })).rejects.toThrow(
      SkuNotFoundError,
    );
    expect(countEvents()).toBe(before);
  });

  it('replay() 重建后条码保留（事件是唯一真相）', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: 'x',
      barcode: '6901',
    });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: '6902' });
    ws.replay();
    expect(ws.skus.byCode('A-1')!.barcode).toBe('6902');
    expect(ws.skus.byBarcode('6902')!.skuCode).toBe('A-1');
  });

  it('老库收敛：M17 结构（wms_sku 无 barcode 列）文件库重开 → 投影整组重建，老 SKU 条码为 NULL', async () => {
    const file = join(tmpdir(), `onewms-m18-conv-${randomUUID()}.db`);
    try {
      // ① 用当前代码在文件库跑出 M17 时代的业务事实（事件进 oplog）
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('ws-sku-conv');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
        core1.close();
      }
      // ② 裸 SQL 模拟 M17 表结构：wms_sku 整表重建为无 barcode 列的形态。
      //    不能 DROP COLUMN——列被 UNIQUE(workspace_id, barcode) 表约束引用，
      //    SQLite 拒删；改名→建 M17 形态新表→搬数→删旧表，检测特征列随之消失。
      {
        const db = new Database(file);
        try {
          db.exec(`
            ALTER TABLE wms_sku RENAME TO wms_sku_legacy;
            CREATE TABLE wms_sku (
              id           TEXT NOT NULL PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              sku_code     TEXT NOT NULL,
              name         TEXT NOT NULL,
              ext_data     TEXT NOT NULL DEFAULT '{}',
              created_at   TEXT NOT NULL,
              updated_at   TEXT NOT NULL,
              UNIQUE (workspace_id, sku_code)
            );
            INSERT INTO wms_sku (id, workspace_id, sku_code, name, ext_data, created_at, updated_at)
              SELECT id, workspace_id, sku_code, name, ext_data, created_at, updated_at FROM wms_sku_legacy;
            DROP TABLE wms_sku_legacy;
          `);
        } finally {
          db.close();
        }
      }
      // ③ 重开：migrateWms 检测列缺失 → 八张投影整组 DROP → sync() 全量重建；
      //    老事件无条码 → 投影 barcode 收敛 NULL；条码工具在收敛后的库上照常可用
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('ws-sku-conv');
        const sku = w2.skus.byCode('A-1')!;
        expect(sku.barcode).toBeNull();
        expect(w2.inventory.quantityOf(sku.id, DEFAULT_LOCATION_ID, DEFAULT_BATCH_NO)).toBe(10);

        await w2.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: '6901234567892' });
        const r = await w2.tools.invoke('wms.sku.resolve', { barcode: '6901234567892' });
        expect(r).toMatchObject({ skuCode: 'A-1' });
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('安全库存与低库存预警（M20）', () => {
  it('create 带 reorderPoint（缺省 0）；update 显式传才改、传 0 关闭', async () => {
    const r = (await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: '螺丝',
      reorderPoint: 50,
    })) as { reorderPoint: number };
    expect(r.reorderPoint).toBe(50);
    expect(ws.skus.byCode('A-1')!.reorderPoint).toBe(50);

    // 缺省 0
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
    expect(ws.skus.byCode('B-2')!.reorderPoint).toBe(0);

    // update 未传保持
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', name: '螺丝加硬' });
    expect(ws.skus.byCode('A-1')!.reorderPoint).toBe(50);

    // update 改值 / 传 0 关闭
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', reorderPoint: 80 });
    expect(ws.skus.byCode('A-1')!.reorderPoint).toBe(80);
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', reorderPoint: 0 });
    expect(ws.skus.byCode('A-1')!.reorderPoint).toBe(0);

    // 负数 schema 拒
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'C-3', name: 'x', reorderPoint: -1 }),
    ).rejects.toThrow('参数 reorderPoint 不能小于 0');
  });

  it('lowstock：低于阈值列出（缺口降序）；0 不参与；充足不列；纯读零事件', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 20 });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母', reorderPoint: 5 });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'C-3', name: '垫片' }); // 无阈值
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 }); // 缺 15
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 10 }); // 充足
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'C-3', delta: 1 }); // 无阈值有货不列

    const before = ws.events.count();
    const rows = (await ws.tools.invoke('wms.inventory.lowstock', {})) as Array<{
      skuCode: string;
      total: number;
      available: number;
      reorderPoint: number;
      shortage: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skuCode: 'A-1',
      total: 5,
      held: 0,
      available: 5,
      reorderPoint: 20,
      shortage: 15,
    });
    expect(ws.events.count()).toBe(before); // 纯读零事件

    // skuCode 过滤：充足 SKU 返回空数组（确认单品预警状态）
    const ok = (await ws.tools.invoke('wms.inventory.lowstock', { skuCode: 'B-2' })) as unknown[];
    expect(ok).toHaveLength(0);
  });

  it('lowstock：冻结吃掉可用量触发预警（M19 同一口径）；入库后解除', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 20 });
    // 余量 20 ≥ 阈值 10：不预警
    expect(await ws.tools.invoke('wms.inventory.lowstock', {})).toHaveLength(0);

    // 冻结 15 → 可用 5 < 10：预警（物理余量仍 20）
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 15 });
    const rows = (await ws.tools.invoke('wms.inventory.lowstock', {})) as Array<{
      available: number;
      shortage: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ available: 5, shortage: 5 });

    // 补货 10 → 可用 15 ≥ 10：解除
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    expect(await ws.tools.invoke('wms.inventory.lowstock', {})).toHaveLength(0);
  });

  it('replay() 重建后 reorderPoint 保留', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', reorderPoint: 30 });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', reorderPoint: 40 });
    ws.replay();
    expect(ws.skus.byCode('A-1')!.reorderPoint).toBe(40);
  });

  it('老库收敛：M19 结构（有 barcode 无 reorder_point 列）文件库重开 → 第三道检测重建，事件携带值完整恢复', async () => {
    const file = join(tmpdir(), `onewms-m20-conv-${randomUUID()}.db`);
    try {
      // ① 用当前代码跑出业务事实
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('ws-m20-conv');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 50 });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
        core1.close();
      }
      // ② 裸 SQL 模拟 M19 表结构：wms_sku 有 barcode 无 reorder_point（改表搬数）
      {
        const db = new Database(file);
        try {
          db.exec(`
            ALTER TABLE wms_sku RENAME TO wms_sku_legacy;
            CREATE TABLE wms_sku (
              id           TEXT NOT NULL PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              sku_code     TEXT NOT NULL,
              barcode      TEXT,
              name         TEXT NOT NULL,
              ext_data     TEXT NOT NULL DEFAULT '{}',
              created_at   TEXT NOT NULL,
              updated_at   TEXT NOT NULL,
              UNIQUE (workspace_id, sku_code),
              UNIQUE (workspace_id, barcode)
            );
            INSERT INTO wms_sku (id, workspace_id, sku_code, barcode, name, ext_data, created_at, updated_at)
              SELECT id, workspace_id, sku_code, barcode, name, ext_data, created_at, updated_at FROM wms_sku_legacy;
            DROP TABLE wms_sku_legacy;
          `);
        } finally {
          db.close();
        }
      }
      // ③ 重开：第三道检测（缺 reorder_point）→ 九张投影整组 DROP 重建；
      //    事件里有 reorderPoint=50 → 重建后完整恢复（不是收敛 0——事件是真相）
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('ws-m20-conv');
        const sku = w2.skus.byCode('A-1')!;
        expect(sku.reorderPoint).toBe(50);
        expect(w2.inventory.quantityOf(sku.id, DEFAULT_LOCATION_ID, DEFAULT_BATCH_NO)).toBe(10);
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('SKU 单位（A3）', () => {
  it('create 带 unit（含 trim）；缺省 null；update 显式传才改、空串清空', async () => {
    const r = (await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: '散装螺丝',
      unit: ' kg ',
    })) as { unit: string | null };
    expect(r.unit).toBe('kg');
    expect(ws.skus.byCode('A-1')!.unit).toBe('kg');

    // 缺省 null
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: 'x' });
    expect(ws.skus.byCode('B-2')!.unit).toBeNull();

    // update 未传保持 / 传值改 / 空串清空
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', name: '改名' });
    expect(ws.skus.byCode('A-1')!.unit).toBe('kg');
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', unit: 'g' });
    expect(ws.skus.byCode('A-1')!.unit).toBe('g');
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', unit: '   ' });
    expect(ws.skus.byCode('A-1')!.unit).toBeNull();
  });

  it('replay() 重建后 unit 保留（事件是唯一真相）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', unit: '箱' });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', unit: '包' });
    ws.replay();
    expect(ws.skus.byCode('A-1')!.unit).toBe('包');
  });

  it('老库收敛：A2 前结构（无 status/unit 列）文件库重开 → 投影重建，status 收敛 active、unit 为 NULL', async () => {
    const file = join(tmpdir(), `onewms-a23-conv-${randomUUID()}.db`);
    try {
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('ws-a23-conv');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 3 });
        core1.close();
      }
      // 裸 SQL 模拟 A2 前表结构：有 reorder_point 无 status/unit
      {
        const db = new Database(file);
        try {
          db.exec(`
            ALTER TABLE wms_sku RENAME TO wms_sku_legacy;
            CREATE TABLE wms_sku (
              id            TEXT NOT NULL PRIMARY KEY,
              workspace_id  TEXT NOT NULL,
              sku_code      TEXT NOT NULL,
              barcode       TEXT,
              name          TEXT NOT NULL,
              reorder_point INTEGER NOT NULL DEFAULT 0,
              ext_data      TEXT NOT NULL DEFAULT '{}',
              created_at    TEXT NOT NULL,
              updated_at    TEXT NOT NULL,
              UNIQUE (workspace_id, sku_code),
              UNIQUE (workspace_id, barcode)
            );
            INSERT INTO wms_sku (id, workspace_id, sku_code, barcode, name, reorder_point, ext_data, created_at, updated_at)
            SELECT id, workspace_id, sku_code, barcode, name, reorder_point, ext_data, created_at, updated_at FROM wms_sku_legacy;
            DROP TABLE wms_sku_legacy;
          `);
        } finally {
          db.close();
        }
      }
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('ws-a23-conv');
        const sku = w2.skus.byCode('A-1')!;
        expect(sku.status ?? 'active').toBe('active');
        expect(sku.unit).toBeNull();
        expect(w2.inventory.quantityOf(sku.id, DEFAULT_LOCATION_ID, DEFAULT_BATCH_NO)).toBe(3);
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('SKU 软停用（A2）', () => {
  function countWmsEvents(): number {
    let n = 0;
    ws.events.forEach((e) => {
      if (e.type.startsWith('wms.')) n++;
    });
    return n;
  }

  it('archive → status=archived + 事件落账；unarchive 恢复；重放收敛', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '建错的档' });
    const before = countWmsEvents();

    const r = (await ws.tools.invoke('wms.sku.archive', { skuCode: 'A-1' })) as {
      status: string;
    };
    expect(r.status).toBe('archived');
    expect(ws.skus.byCode('A-1')!.status).toBe('archived');
    expect(countWmsEvents()).toBe(before + 1);

    await ws.tools.invoke('wms.sku.unarchive', { skuCode: 'A-1' });
    expect(ws.skus.byCode('A-1')!.status).toBe('active');

    ws.replay();
    expect(ws.skus.byCode('A-1')!.status).toBe('active'); // 重放收敛到最新状态
  });

  it('重复停用/重复启用 → 幂等零事件', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.sku.archive', { skuCode: 'A-1' });
    const before = countWmsEvents();
    await ws.tools.invoke('wms.sku.archive', { skuCode: 'A-1' }); // 已停用
    expect(countWmsEvents()).toBe(before);

    await ws.tools.invoke('wms.sku.unarchive', { skuCode: 'A-1' });
    const afterUnarchive = countWmsEvents();
    await ws.tools.invoke('wms.sku.unarchive', { skuCode: 'A-1' }); // 已启用
    expect(countWmsEvents()).toBe(afterUnarchive);
  });

  it('不存在的 SKU → SkuNotFoundError', async () => {
    await expect(ws.tools.invoke('wms.sku.archive', { skuCode: 'ghost' })).rejects.toThrow(
      SkuNotFoundError,
    );
    await expect(ws.tools.invoke('wms.sku.unarchive', { skuCode: 'ghost' })).rejects.toThrow(
      SkuNotFoundError,
    );
  });

  it('软停用语义：停用档退出低库存预警，但存量照常可扣、可扫（无操作拦截）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 3 }); // 可用 3 < 10 → 预警
    expect(await ws.tools.invoke('wms.inventory.lowstock', {})).toHaveLength(1);

    await ws.tools.invoke('wms.sku.archive', { skuCode: 'A-1' });
    expect(await ws.tools.invoke('wms.inventory.lowstock', {})).toHaveLength(0); // 退出预警

    // 存量照常可扣（软停用不拦操作）
    const r = (await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -3 })) as {
      quantity: number;
    };
    expect(r.quantity).toBe(0);

    // 条码照常可解析（扫码定位语义）
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', barcode: '6901' });
    const resolved = await ws.tools.invoke('wms.sku.resolve', { barcode: '6901' });
    expect(resolved).toMatchObject({ skuCode: 'A-1' });
  });

  it('停用档退出效期预警（expiring 不列 archived）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: 'y' });
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      batchNo: 'B1',
      batchExpiryDate: soon,
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'B-2',
      delta: 5,
      batchNo: 'B1',
      batchExpiryDate: soon,
    });
    expect(await ws.tools.invoke('wms.inventory.expiring', { days: 30 })).toHaveLength(2);

    await ws.tools.invoke('wms.sku.archive', { skuCode: 'A-1' });
    const rows = (await ws.tools.invoke('wms.inventory.expiring', { days: 30 })) as Array<{
      skuCode: string;
    }>;
    expect(rows.map((r) => r.skuCode)).toEqual(['B-2']);
  });
});
