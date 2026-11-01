import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  InsufficientStockError,
  DEFAULT_LOCATION_ID,
  DEFAULT_BATCH_NO,
} from '../src/index.js';

/**
 * 库位维度与联动（M10）：
 *  - 库存分桶：adjust 按库位入账，query 三形态（分组 / 单组 / 按库位平铺）
 *  - 单据行库位：入库分桶上架、同单同 SKU 分库位多行、出库按行库位守卫
 *  - 移库：DEFAULT↔实体、余量守卫、同库位拒绝、transfer 流水对
 *  - replay 重建一致；老库收敛（M9 结构 → 整组 DROP 重建 → DEFAULT 桶）
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-inv-loc');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02' });
});

afterEach(() => {
  core.close();
});

/** 按编码查余量（库位缺省 DEFAULT 桶） */
function qty(skuCode: string, locationCode: string = DEFAULT_LOCATION_ID): number {
  const skuId = ws.skus.byCode(skuCode)!.id;
  const locationId =
    locationCode === DEFAULT_LOCATION_ID
      ? DEFAULT_LOCATION_ID
      : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(skuId, locationId);
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

async function createOrder(
  direction: 'in' | 'out',
  lines: { skuCode: string; quantity: number; locationCode?: string }[],
): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', { direction, lines })) as { orderNo: string };
  return r.orderNo;
}

describe('库存分桶与查询', () => {
  it('adjust 分桶入账；query 单 SKU 返回 total + byLocation 分组', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 30 });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 20,
      locationCode: 'A-01',
    });

    const g = (await ws.tools.invoke('wms.inventory.query', { skuCode: 'A-1' })) as {
      total: number;
      byLocation: {
        locationCode: string;
        locationName: string;
        quantity: number;
        batches: { batchNo: string; batchExpiryDate: string | null; quantity: number }[];
      }[];
    };
    expect(g.total).toBe(50);
    expect(g.byLocation).toEqual(
      expect.arrayContaining([
        {
          locationCode: 'DEFAULT',
          locationName: '默认库位',
          quantity: 30,
          batches: [{ batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 30 }],
        },
        {
          locationCode: 'A-01',
          locationName: '一号架',
          quantity: 20,
          batches: [{ batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 20 }],
        },
      ]),
    );
    expect(g.byLocation).toHaveLength(2);
  });

  it('query 全量清单为分组数组（按 SKU）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 30 });
    const all = (await ws.tools.invoke('wms.inventory.query', {})) as {
      skuCode: string;
      total: number;
    }[];
    expect(all).toEqual([expect.objectContaining({ skuCode: 'A-1', total: 30 })]);
  });

  it('query 按库位平铺：该库位内有哪些货（可再按 SKU 收窄）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 20,
      locationCode: 'A-01',
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'B-2',
      delta: 5,
      locationCode: 'A-01',
    });

    const rows = (await ws.tools.invoke('wms.inventory.query', { locationCode: 'A-01' })) as {
      skuCode: string;
      locationCode: string;
      quantity: number;
    }[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skuCode: 'A-1', locationCode: 'A-01', quantity: 20 }),
        expect.objectContaining({ skuCode: 'B-2', locationCode: 'A-01', quantity: 5 }),
      ]),
    );

    const narrow = (await ws.tools.invoke('wms.inventory.query', {
      skuCode: 'B-2',
      locationCode: 'A-01',
    })) as { skuCode: string; quantity: number }[];
    expect(narrow).toEqual([expect.objectContaining({ skuCode: 'B-2', quantity: 5 })]);
  });

  it('无库存 SKU 查询 → total 0 + 空 byLocation', async () => {
    const g = (await ws.tools.invoke('wms.inventory.query', { skuCode: 'A-1' })) as {
      total: number;
      byLocation: unknown[];
    };
    expect(g.total).toBe(0);
    expect(g.byLocation).toEqual([]);
  });

  it('adjust 负库存守卫按库位维度：他桶有货不救本桶', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 100,
      locationCode: 'A-01',
    });
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1 }),
    ).rejects.toThrow(InsufficientStockError); // DEFAULT 桶余量 0，A-01 的 100 不算数
  });
});

describe('单据行库位联动', () => {
  it('入库行带库位 → received 分桶上架，adjustedLines 携带库位', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 100, locationCode: 'A-01' },
      { skuCode: 'A-1', quantity: 50 }, // 缺省 DEFAULT
      { skuCode: 'B-2', quantity: 30, locationCode: 'A-01' },
    ]);
    const r = (await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' })) as {
      adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
    };
    expect(r.adjustedLines).toEqual(
      expect.arrayContaining([
        { skuCode: 'A-1', locationCode: 'A-01', batchNo: 'DEFAULT', delta: 100 },
        { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: 50 },
        { skuCode: 'B-2', locationCode: 'A-01', batchNo: 'DEFAULT', delta: 30 },
      ]),
    );
    expect(qty('A-1', 'A-01')).toBe(100);
    expect(qty('A-1')).toBe(50);
    expect(qty('B-2', 'A-01')).toBe(30);
  });

  it('同单同 SKU 分库位多行允许；同 SKU 同库位重复拒绝', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 10, locationCode: 'A-01' },
      { skuCode: 'A-1', quantity: 20, locationCode: 'B-02' },
    ]);
    expect(ws.orders.lines(ws.orders.byNo(no)!.id)).toHaveLength(2);

    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [
          { skuCode: 'A-1', quantity: 10, locationCode: 'A-01' },
          { skuCode: 'A-1', quantity: 20, locationCode: 'A-01' },
        ],
      }),
    ).rejects.toThrow(/重复/);
    expect(countEvents()).toBe(before);
  });

  it('出库按行库位守卫：他库位有货但行库位不足 → 拒绝且零事件', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 100,
      locationCode: 'A-01',
    }); // DEFAULT 桶余量 0
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 40 }]); // 行库位 = DEFAULT
    const before = countEvents();

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.byNo(no)!.state).toBe('created');
    expect(countEvents()).toBe(before);
  });

  it('出库行带库位 → 正常预检与扣减', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 100,
      locationCode: 'A-01',
    });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 40, locationCode: 'A-01' }]);

    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'shipped' });
    expect(qty('A-1', 'A-01')).toBe(60);
    expect(qty('A-1')).toBe(0);
  });
});

describe('移库', () => {
  it('DEFAULT → 实体库位：双流水 transfer、返回值带两端余量', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });
    const r = (await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      toLocationCode: 'A-01',
      quantity: 30,
    })) as { from: string; to: string; quantity: number; fromBalance: number; toBalance: number };
    expect(r).toMatchObject({
      from: 'DEFAULT',
      to: 'A-01',
      quantity: 30,
      fromBalance: 20,
      toBalance: 30,
    });
    expect(qty('A-1')).toBe(20);
    expect(qty('A-1', 'A-01')).toBe(30);

    const ledger = ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id);
    const transfers = ledger.filter((l) => l.reason === 'transfer');
    expect(transfers).toHaveLength(2);
    expect(transfers.map((l) => l.delta).sort()).toEqual([-30, 30]);
    // SKU 总量不变（分桶守恒）
    const total = ledger.reduce((a, l) => a + l.delta, 0);
    expect(total).toBe(50);
  });

  it('实体 → 实体库位移库', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 100,
      locationCode: 'A-01',
    });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'A-01',
      toLocationCode: 'B-02',
      quantity: 40,
    });
    expect(qty('A-1', 'A-01')).toBe(60);
    expect(qty('A-1', 'B-02')).toBe(40);
  });

  it('移库到未建库位 → 拒绝且零事件', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.inventory.move', {
        skuCode: 'A-1',
        toLocationCode: 'C-99',
        quantity: 10,
      }),
    ).rejects.toThrow(/库位不存在/);
    expect(countEvents()).toBe(before);
  });

  it('源库位余量不足 → 拒绝且零事件（他桶有货不救）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 100,
      locationCode: 'A-01',
    });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.inventory.move', {
        skuCode: 'A-1',
        toLocationCode: 'B-02',
        quantity: 10,
      }), // 源 = DEFAULT（余量 0），A-01 的 100 不算数
    ).rejects.toThrow(InsufficientStockError);
    expect(countEvents()).toBe(before);
  });

  it('源与目标相同 → 拒绝', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });
    await expect(
      ws.tools.invoke('wms.inventory.move', {
        skuCode: 'A-1',
        fromLocationCode: 'DEFAULT',
        toLocationCode: 'DEFAULT',
        quantity: 10,
      }),
    ).rejects.toThrow(/相同/);
  });

  it('移库数量非正整数 → 拒绝（schema 层 minimum: 1 先于 handler 守卫）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });
    await expect(
      ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 0 }),
    ).rejects.toThrow(/不能小于 1/);
  });
});

describe('追账与老库收敛', () => {
  it('replay() 重建后分桶余量、流水与库位一致', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });
    const no = await createOrder('in', [{ skuCode: 'A-1', quantity: 30, locationCode: 'A-01' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'DEFAULT',
      toLocationCode: 'B-02',
      quantity: 20,
    });
    expect(qty('A-1')).toBe(30);
    expect(qty('A-1', 'A-01')).toBe(30);
    expect(qty('A-1', 'B-02')).toBe(20);

    ws.replay();
    expect(qty('A-1')).toBe(30);
    expect(qty('A-1', 'A-01')).toBe(30);
    expect(qty('A-1', 'B-02')).toBe(20);
    expect(ws.locations.list().map((l) => l.locationCode)).toEqual(['A-01', 'B-02']);
    expect(ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id)).toHaveLength(4); // 期初 + 收货 + 移库两条
  });

  it('老库收敛：M9 结构（库位/批次列皆无）直升 M11 → 整组 DROP 重建，老流水落 DEFAULT 桶', async () => {
    const file = join(tmpdir(), `onewms-m11-conv-loc-${randomUUID()}.db`);
    try {
      // ① 用当前代码在文件库跑出 M9 时代的业务事实（事件进 oplog）
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('w');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 8, reason: '期初' });
        const r = (await w1.tools.invoke('wms.order.create', {
          direction: 'in',
          lines: [{ skuCode: 'A-1', quantity: 5 }],
        })) as { orderNo: string };
        await w1.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
        core1.close();
      }
      // ② 降级为 M9 结构：流水表去掉库位与批次列（M9 真结构两维皆无；迁移检测
      //    的特征列是 batch_no——location_id 一起删模拟的是 M9 → M11 直升路径）
      {
        const db = new Database(file);
        db.exec(`
          ALTER TABLE wms_inventory_ledger DROP COLUMN location_id;
          ALTER TABLE wms_inventory_ledger DROP COLUMN batch_no;
          ALTER TABLE wms_inventory_ledger DROP COLUMN batch_expiry_date;
        `);
        db.close();
      }
      // ③ 重开：migrateWms 检测 batch_no 缺失 → 六张投影整组 DROP → sync() 全量重建；
      //    老事件无库位/批次 → 兜底 DEFAULT 桶；单据行同样重建（M9→M11 与 M10→M11
      //    两条升级路径共用同一道检测——batch.test.ts 覆盖 M10 路径）
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('w');
        const skuId = w2.skus.byCode('A-1')!.id;
        expect(w2.inventory.quantityOf(skuId, DEFAULT_LOCATION_ID)).toBe(13);
        const ledger = w2.inventory.ledgerOf(skuId);
        expect(ledger).toHaveLength(2); // 期初 + order:received
        expect(ledger.every((l) => l.locationId === DEFAULT_LOCATION_ID)).toBe(true);
        expect(ledger.every((l) => l.batchNo === DEFAULT_BATCH_NO)).toBe(true);
        const order = w2.orders.list('in')[0];
        const lines = w2.orders.lines(order.id);
        expect(lines).toHaveLength(1);
        expect(lines[0].locationId).toBe(DEFAULT_LOCATION_ID);
        expect(lines[0].batchNo).toBe(DEFAULT_BATCH_NO);
        expect(lines[0].quantity).toBe(5);
        // 新库位/批次工具在收敛后的库上照常可用
        await w2.tools.invoke('wms.location.create', { locationCode: 'A-01' });
        await w2.tools.invoke('wms.inventory.move', {
          skuCode: 'A-1',
          toLocationCode: 'A-01',
          quantity: 13,
        });
        expect(w2.inventory.quantityOf(skuId, DEFAULT_LOCATION_ID)).toBe(0);
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});
