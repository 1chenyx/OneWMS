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
