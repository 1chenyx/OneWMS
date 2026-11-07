import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  SkuNotFoundError,
  StocktakeExistsError,
  StocktakeLinesUncountedError,
  StocktakeNotFoundError,
  StocktakeNotOpenError,
  StocktakeScopeViolationError,
  DEFAULT_LOCATION_ID,
  DEFAULT_BATCH_NO,
} from '../src/index.js';

/**
 * 盘点（M17）：
 *  - 快照确定性：created 时点生成账面快照行（范围内、余量>0）；重放逐字节重建
 *  - counted 覆盖语义：同桶重盘后到者胜；范围外拒绝；账面零桶补行（盘盈）
 *  - close 差异收敛：delta = 实盘 − 关单时点账面，跳过零差行；
 *    调整 = 普通 inventory.adjusted（reason: stocktake:单号）；replay 后一致
 *  - 生命周期守卫：未盘完拒关；非 created 拒 count/close/cancel；cancel 零调整
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-stocktake');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02' });
});

afterEach(() => {
  core.close();
});

/** 按编码查余量（库位/批次缺省 DEFAULT 桶） */
function qty(skuCode: string, locationCode = DEFAULT_LOCATION_ID, batchNo = DEFAULT_BATCH_NO): number {
  const skuId = ws.skus.byCode(skuCode)!.id;
  const locationId =
    locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(skuId, locationId, batchNo);
}

function skuIdOf(code: string): string {
  return ws.skus.byCode(code)!.id;
}

function stIdOf(no: string): string {
  return ws.stocktakes.byNo(no)!.id;
}

/** 明细行按 (sku, 库位, 批次) 投影为可比对象数组（排序稳定化） */
function lineTuples(no: string): [string, string, string, number, number | null][] {
  return ws.stocktakes
    .lines(stIdOf(no))
    .map((l) => {
      const skuCode = ws.skus.byId(l.skuId)?.skuCode ?? l.skuId;
      const locCode =
        l.locationId === DEFAULT_LOCATION_ID
          ? DEFAULT_LOCATION_ID
          : ws.locations.byId(l.locationId)?.locationCode ?? l.locationId;
      return [skuCode, locCode, l.batchNo, l.expectedQty, l.countedQty] as [
        string,
        string,
        string,
        number,
        number | null,
      ];
    })
    .sort((a, b) => a.join('@').localeCompare(b.join('@')));
}

/** 盘点调整流水条数（按 reason 前缀过滤） */
function stocktakeLedgerCount(no: string, skuCode: string): number {
  return ws.inventory.ledgerOf(skuIdOf(skuCode)).filter((l) => l.reason === `stocktake:${no}`).length;
}

async function seedInventory(): Promise<void> {
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B1' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, locationCode: 'A-01', batchNo: 'B1' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 7, locationCode: 'A-01' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 3, locationCode: 'B-02' });
}

describe('创建与账面快照', () => {
  it('全场盘点：生成全部余量>0 桶的快照行（expected=创建时账面）', async () => {
    await seedInventory();
    const r = (await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' })) as {
      stocktakeNo: string;
      state: string;
      lineCount: number;
    };
    expect(r.stocktakeNo).toBe('ST-1');
    expect(r.state).toBe('created');
    expect(r.lineCount).toBe(4);
    expect(ws.stocktakes.byNo('ST-1')!.locationIds).toBeNull();
    expect(lineTuples('ST-1')).toEqual([
      ['A-1', 'A-01', 'B1', 5, null],
      ['A-1', 'DEFAULT', 'B1', 10, null],
      ['B-2', 'A-01', 'DEFAULT', 7, null],
      ['B-2', 'B-02', 'DEFAULT', 3, null],
    ]);
  });

  it('范围盘点：只生成范围内库位的桶；零余量桶不入行', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 6, locationCode: 'A-01' });
    // C-03 库位无库存——范围勾选它也不产生行
    await ws.tools.invoke('wms.location.create', { locationCode: 'C-03' });
    const r = (await ws.tools.invoke('wms.stocktake.create', {
      stocktakeNo: 'ST-2',
      locationCodes: ['A-01', 'C-03'],
    })) as { lineCount: number };
    expect(r.lineCount).toBe(1);
    expect(lineTuples('ST-2')).toEqual([['A-1', 'A-01', 'DEFAULT', 6, null]]);
    const st = ws.stocktakes.byNo('ST-2')!;
    expect(st.locationIds).toHaveLength(2);
  });

  it('空范围单零行可关（零调整）', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', {
      stocktakeNo: 'ST-EMPTY',
      locationCodes: ['B-02'],
      note: '只盘 B-02',
    });
    // B-02 有 3 个 B-2——造一张真正零行的单：范围库位无库存
    await ws.tools.invoke('wms.location.create', { locationCode: 'D-04' });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-ZERO', locationCodes: ['D-04'] });
    const close = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-ZERO' })) as {
      state: string;
      adjustedLines: number;
    };
    expect(close.state).toBe('closed');
    expect(close.adjustedLines).toBe(0);
    expect(qty('B-2', 'B-02')).toBe(3); // 全场库存纹丝未动
  });

  it('单号冲突拒绝（零事件）', async () => {
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    let events = 0;
    ws.events.forEach(() => events++);
    await expect(
      ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' }),
    ).rejects.toThrow(StocktakeExistsError);
    let after = 0;
    ws.events.forEach(() => after++);
    expect(after).toBe(events);
  });

  it('范围引用不存在的库位 → 拒（LocationNotFoundError）', async () => {
    await expect(
      ws.tools.invoke('wms.stocktake.create', { locationCodes: ['X-99'] }),
    ).rejects.toThrow();
  });
});

describe('录实盘（counted）', () => {
  it('录入实盘数；同桶重盘后到者胜；进度统计计数', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });

    const r = (await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-1',
      skuCode: 'A-1',
      batchNo: 'B1',
      countedQty: 8,
    })) as { expectedQty: number; bookQty: number };
    expect(r.expectedQty).toBe(10);
    expect(r.bookQty).toBe(10);
    expect(ws.stocktakes.stats(stIdOf('ST-1'))).toEqual({ lineCount: 4, countedCount: 1 });

    // 重盘覆盖：8 → 12（同一事件类型再落一条，投影 upsert）
    await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-1',
      skuCode: 'A-1',
      batchNo: 'B1',
      countedQty: 12,
    });
    const recounted = lineTuples('ST-1').find((t) => t[1] === DEFAULT_LOCATION_ID && t[2] === 'B1')!;
    expect(recounted).toEqual(['A-1', 'DEFAULT', 'B1', 10, 12]);
    expect(ws.stocktakes.stats(stIdOf('ST-1'))).toEqual({ lineCount: 4, countedCount: 1 });
  });

  it('盘盈桶：账面为零的桶补行（expected=录入时点现值 0）', async () => {
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-1',
      skuCode: 'B-2',
      locationCode: 'A-01',
      countedQty: 4,
    });
    // 创建时 B-2@A-01 账面为零（无行）——count 补行，expected 取现值 0
    expect(lineTuples('ST-1')).toContainEqual(['B-2', 'A-01', 'DEFAULT', 0, 4]);
    expect(ws.stocktakes.stats(stIdOf('ST-1'))).toEqual({ lineCount: 1, countedCount: 1 });
  });

  it('范围外库位拒绝（零事件）；全场不设范围约束', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-SCOPED', locationCodes: ['A-01'] });
    let events = 0;
    ws.events.forEach(() => events++);
    await expect(
      ws.tools.invoke('wms.stocktake.count', {
        stocktakeNo: 'ST-SCOPED',
        skuCode: 'B-2',
        locationCode: 'B-02',
        countedQty: 3,
      }),
    ).rejects.toThrow(StocktakeScopeViolationError);
    let after = 0;
    ws.events.forEach(() => after++);
    expect(after).toBe(events);
    // 全场单任意库位可录
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-ALL' });
    await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-ALL',
      skuCode: 'B-2',
      locationCode: 'B-02',
      countedQty: 3,
    });
  });

  it('countedQty 非法值拒绝（schema 层，零事件）；小数实盘放行；SKU 不存在拒绝', async () => {
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await expect(
      ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: -1 }),
    ).rejects.toThrow('countedQty');
    // 小数实盘（散装/称重）合法：录入后差异按 3 位小数量化
    const r = (await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-1',
      skuCode: 'A-1',
      countedQty: 1.5,
    })) as { countedQty: number };
    expect(r.countedQty).toBe(1.5);
    await expect(
      ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'X-9', countedQty: 1 }),
    ).rejects.toThrow(SkuNotFoundError);
  });

  it('不存在的盘点单 / 已关单再录 → 拒', async () => {
    await expect(
      ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-404', skuCode: 'A-1', countedQty: 1 }),
    ).rejects.toThrow(StocktakeNotFoundError);
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 0 });
    await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' });
    await expect(
      ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 1 }),
    ).rejects.toThrow(StocktakeNotOpenError);
  });
});

describe('关单差异收敛（close）', () => {
  it('差异调整=实盘−关单时点账面：盘亏扣减、盘盈补录、零差跳过；reason 可追溯', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', batchNo: 'B1', countedQty: 8 }); // 亏 2
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', locationCode: 'A-01', batchNo: 'B1', countedQty: 5 }); // 平
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'A-01', countedQty: 9 }); // 盈 2
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'B-02', countedQty: 3 }); // 平

    const r = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' })) as {
      state: string;
      totalLines: number;
      adjustedLines: number;
      adjustments: { skuCode: string; locationCode: string; batchNo: string; countedQty: number; bookQty: number; delta: number }[];
    };
    expect(r.state).toBe('closed');
    expect(r.totalLines).toBe(4);
    expect(r.adjustedLines).toBe(2);
    expect(r.adjustments).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'B1', expectedQty: 10, countedQty: 8, bookQty: 10, delta: -2 },
      { skuCode: 'B-2', locationCode: 'A-01', batchNo: 'DEFAULT', expectedQty: 7, countedQty: 9, bookQty: 7, delta: 2 },
    ]);
    // 库存收敛到实盘数
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(8);
    expect(qty('A-1', 'A-01', 'B1')).toBe(5);
    expect(qty('B-2', 'A-01')).toBe(9);
    expect(qty('B-2', 'B-02')).toBe(3);
    // 零差行不落调整流水；有差行落 inventory.adjusted（reason=stocktake:单号）
    expect(stocktakeLedgerCount('ST-1', 'A-1')).toBe(1);
    expect(stocktakeLedgerCount('ST-1', 'B-2')).toBe(1);
    const led = ws.inventory.ledgerOf(skuIdOf('A-1')).find((l) => l.reason === 'stocktake:ST-1')!;
    expect(led.delta).toBe(-2);
    expect(led.locationId).toBe(DEFAULT_LOCATION_ID);
  });

  it('未盘完拒关（零事件零调整）', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', batchNo: 'B1', countedQty: 10 });
    let events = 0;
    ws.events.forEach(() => events++);
    await expect(ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' })).rejects.toThrow(
      StocktakeLinesUncountedError,
    );
    let after = 0;
    ws.events.forEach(() => after++);
    expect(after).toBe(events);
    expect(ws.stocktakes.byNo('ST-1')!.state).toBe('created');
    // 全部录完（含 0）后可关
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', locationCode: 'A-01', batchNo: 'B1', countedQty: 5 });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'A-01', countedQty: 7 });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'B-02', countedQty: 3 });
    const r = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' })) as { state: string };
    expect(r.state).toBe('closed');
  });

  it('盘点期间库存有动：差异按关单时点现值收敛', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 10 });
    // 录完后又入库 5（账面 15，实盘还是 10）→ 关单时点 delta = 10 − 15 = −5
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
    const r = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' })) as {
      adjustments: { delta: number; bookQty: number }[];
    };
    expect(r.adjustments).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', expectedQty: 10, countedQty: 10, bookQty: 15, delta: -5 },
    ]);
    expect(qty('A-1')).toBe(10);
  });
});

describe('取消（cancel）与生命周期守卫', () => {
  it('cancel：状态收敛 canceled、库存零调整、流水零新增', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', batchNo: 'B1', countedQty: 99 });
    let events = 0;
    ws.events.forEach(() => events++);
    const r = (await ws.tools.invoke('wms.stocktake.cancel', { stocktakeNo: 'ST-1' })) as { state: string };
    expect(r.state).toBe('canceled');
    let after = 0;
    ws.events.forEach(() => after++);
    expect(after).toBe(events + 1); // 只多一条 state_changed
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(10); // 账面未动
    expect(stocktakeLedgerCount('ST-1', 'A-1')).toBe(0);
    // 已录的实盘数保留（仅作记录）
    const kept = lineTuples('ST-1').find((t) => t[1] === DEFAULT_LOCATION_ID && t[2] === 'B1')!;
    expect(kept[4]).toBe(99);
  });

  it('close/cancel 只对 created 开放；已终态的单不可再操作', async () => {
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.cancel', { stocktakeNo: 'ST-1' });
    await expect(ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' })).rejects.toThrow(
      StocktakeNotOpenError,
    );
    await expect(ws.tools.invoke('wms.stocktake.cancel', { stocktakeNo: 'ST-1' })).rejects.toThrow(
      StocktakeNotOpenError,
    );
    await expect(ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-404' })).rejects.toThrow(
      StocktakeNotFoundError,
    );
  });
});

describe('重放确定性（事件是唯一真相）', () => {
  it('replay() 后：主表状态/明细快照/实盘数/库存逐字节重建', async () => {
    await seedInventory();
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', batchNo: 'B1', countedQty: 8 });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', locationCode: 'A-01', batchNo: 'B1', countedQty: 6 });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'A-01', countedQty: 7 });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'B-2', locationCode: 'B-02', countedQty: 2 });
    await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' });

    const beforeLines = lineTuples('ST-1');
    const beforeState = ws.stocktakes.byNo('ST-1')!.state;
    const beforeQty = [qty('A-1', 'DEFAULT', 'B1'), qty('A-1', 'A-01', 'B1'), qty('B-2', 'A-01'), qty('B-2', 'B-02')];
    const beforeLedger = ws.inventory.ledgerOf(skuIdOf('A-1')).map((l) => [l.reason, l.delta]);

    ws.replay();

    expect(ws.stocktakes.byNo('ST-1')!.state).toBe(beforeState);
    expect(lineTuples('ST-1')).toEqual(beforeLines);
    expect([qty('A-1', 'DEFAULT', 'B1'), qty('A-1', 'A-01', 'B1'), qty('B-2', 'A-01'), qty('B-2', 'B-02')]).toEqual(
      beforeQty,
    );
    expect(ws.inventory.ledgerOf(skuIdOf('A-1')).map((l) => [l.reason, l.delta])).toEqual(beforeLedger);
  });

  it('重放中盘点线快照独立于关单调整（created 事件先于 adjusted 应用）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 10 });
    await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' });
    expect(qty('A-1')).toBe(10);
    ws.replay();
    // 快照行 expected=10 不受关单流水影响；canceled 单同理保留记录
    expect(lineTuples('ST-1')).toEqual([['A-1', 'DEFAULT', 'DEFAULT', 10, 10]]);
  });

  it('文件库重开（新进程绑定同库）：投影从 oplog 全量追账重建', async () => {
    const { randomUUID } = await import('node:crypto');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rmSync } = await import('node:fs');
    const file = join(tmpdir(), `onewms-m17-${randomUUID()}.db`);
    try {
      {
        const c1 = OneCore.open(file);
        const d1 = WmsDomain.attach(c1);
        const w1 = d1.workspace('ws-file');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
        await w1.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
        await w1.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 9 });
        await w1.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' });
        c1.close();
      }
      {
        const c2 = OneCore.open(file);
        const d2 = WmsDomain.attach(c2);
        const w2 = d2.workspace('ws-file');
        expect(w2.stocktakes.byNo('ST-1')!.state).toBe('closed');
        const skuId = w2.skus.byCode('A-1')!.id;
        expect(w2.inventory.quantityOf(skuId, DEFAULT_LOCATION_ID, DEFAULT_BATCH_NO)).toBe(9);
        expect(w2.stocktakes.stats(w2.stocktakes.byNo('ST-1')!.id)).toEqual({ lineCount: 1, countedCount: 1 });
        c2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('查询（query）', () => {
  it('无参=清单+进度；带单号=明细（账面/实盘/差异）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1', note: '月度盘点' });
    await ws.tools.invoke('wms.stocktake.count', { stocktakeNo: 'ST-1', skuCode: 'A-1', countedQty: 12 });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-2', locationCodes: ['A-01'] });

    const list = (await ws.tools.invoke('wms.stocktake.query', {})) as {
      stocktakeNo: string;
      state: string;
      scope: string[] | '全场';
      lineCount: number;
      countedCount: number;
    }[];
    expect(list).toHaveLength(2);
    const st1 = list.find((l) => l.stocktakeNo === 'ST-1')!;
    expect(st1.scope).toBe('全场');
    expect(st1.lineCount).toBe(1);
    expect(st1.countedCount).toBe(1);
    const st2 = list.find((l) => l.stocktakeNo === 'ST-2')!;
    expect(st2.scope).toEqual(['A-01']);

    const detail = (await ws.tools.invoke('wms.stocktake.query', { stocktakeNo: 'ST-1' })) as {
      state: string;
      note: string;
      lines: { skuCode: string; locationCode: string; batchNo: string; expectedQty: number; countedQty: number | null; bookQty: number; delta: number | null }[];
    };
    expect(detail.note).toBe('月度盘点');
    expect(detail.lines).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', expectedQty: 10, countedQty: 12, bookQty: 10, delta: 2 },
    ]);
  });
});
