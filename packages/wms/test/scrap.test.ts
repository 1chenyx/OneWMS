import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  InsufficientStockError,
  ScrapExistsError,
  ScrapNoLinesError,
  ScrapNotFoundError,
  ScrapStateError,
  SkuNotFoundError,
  DEFAULT_LOCATION_ID,
  DEFAULT_BATCH_NO,
} from '../src/index.js';

/**
 * 报损单（scrap）：
 *  - 生命周期：created → confirm（逐行扣减，reason: scrap:单号）/ cancel（不动库存）
 *  - 守卫：重复 confirm/cancel 拒绝；余量不足整单拒绝
 *  - 重放一致性
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-scrap');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'L-1', name: '一号架' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, locationCode: 'L-1', batchNo: 'B1' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 5, locationCode: 'L-1' });
});

afterEach(() => {
  core.close();
});

function qty(skuCode: string, locationCode: string, batchNo = DEFAULT_BATCH_NO): number {
  const locationId =
    locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(ws.skus.byCode(skuCode)!.id, locationId, batchNo);
}

function scrapReasons(skuCode: string): string[] {
  return ws.inventory.ledgerOf(ws.skus.byCode(skuCode)!.id).map((l) => l.reason);
}

describe('创建与确认', () => {
  it('建单默认单号 + 确认扣减（reason: scrap:单号）', async () => {
    const r = (await ws.tools.invoke('wms.scrap.create', {
      lines: [
        { skuCode: 'A-1', locationCode: 'L-1', batchNo: 'B1', quantity: 3 },
        { skuCode: 'B-2', locationCode: 'L-1', quantity: 2 },
      ],
      note: '破损',
    })) as { scrapNo: string; state: string; lineCount: number };
    expect(r.scrapNo).toMatch(/^SC-\d{8}-\d{3}$/);
    expect(r.state).toBe('created');
    expect(qty('A-1', 'L-1', 'B1')).toBe(10); // 建单不动库存
    const c = (await ws.tools.invoke('wms.scrap.confirm', { scrapNo: r.scrapNo })) as { state: string };
    expect(c.state).toBe('confirmed');
    expect(qty('A-1', 'L-1', 'B1')).toBe(7);
    expect(qty('B-2', 'L-1')).toBe(3);
    expect(scrapReasons('A-1')).toContain(`scrap:${r.scrapNo}`);
  });

  it('空行 / 单号重复 / SKU 不存在拒绝', async () => {
    await expect(ws.tools.invoke('wms.scrap.create', { lines: [] })).rejects.toThrow(ScrapNoLinesError);
    await ws.tools.invoke('wms.scrap.create', { scrapNo: 'SC-1', lines: [{ skuCode: 'A-1', quantity: 1 }] });
    await expect(
      ws.tools.invoke('wms.scrap.create', { scrapNo: 'SC-1', lines: [{ skuCode: 'A-1', quantity: 1 }] }),
    ).rejects.toThrow(ScrapExistsError);
    await expect(ws.tools.invoke('wms.scrap.create', { lines: [{ skuCode: 'X-9', quantity: 1 }] })).rejects.toThrow(
      SkuNotFoundError,
    );
  });

  it('余量不足整单拒绝（另一行也不落流水）', async () => {
    const { scrapNo } = (await ws.tools.invoke('wms.scrap.create', {
      lines: [
        { skuCode: 'A-1', locationCode: 'L-1', batchNo: 'B1', quantity: 2 },
        { skuCode: 'B-2', locationCode: 'L-1', quantity: 99 },
      ],
    })) as { scrapNo: string };
    await expect(ws.tools.invoke('wms.scrap.confirm', { scrapNo })).rejects.toThrow(InsufficientStockError);
    expect(qty('A-1', 'L-1', 'B1')).toBe(10);
    expect(ws.scraps.byNo(scrapNo)!.state).toBe('created');
  });

  it('重复确认 / 确认后取消拒绝；created 取消零库存影响', async () => {
    const a = (await ws.tools.invoke('wms.scrap.create', {
      lines: [{ skuCode: 'A-1', locationCode: 'L-1', batchNo: 'B1', quantity: 1 }],
    })) as { scrapNo: string };
    const r = (await ws.tools.invoke('wms.scrap.cancel', { scrapNo: a.scrapNo })) as { state: string };
    expect(r.state).toBe('canceled');
    expect(qty('A-1', 'L-1', 'B1')).toBe(10);
    await expect(ws.tools.invoke('wms.scrap.cancel', { scrapNo: a.scrapNo })).rejects.toThrow(ScrapStateError);

    const b = (await ws.tools.invoke('wms.scrap.create', {
      lines: [{ skuCode: 'A-1', locationCode: 'L-1', batchNo: 'B1', quantity: 1 }],
    })) as { scrapNo: string };
    await ws.tools.invoke('wms.scrap.confirm', { scrapNo: b.scrapNo });
    await expect(ws.tools.invoke('wms.scrap.confirm', { scrapNo: b.scrapNo })).rejects.toThrow(ScrapStateError);
    await expect(ws.tools.invoke('wms.scrap.cancel', { scrapNo: b.scrapNo })).rejects.toThrow(ScrapStateError);
  });

  it('单据不存在拒绝', async () => {
    await expect(ws.tools.invoke('wms.scrap.confirm', { scrapNo: 'SC-404' })).rejects.toThrow(ScrapNotFoundError);
  });
});

describe('重放一致性', () => {
  it('replay 后报损投影与库存一致', async () => {
    const { scrapNo } = (await ws.tools.invoke('wms.scrap.create', {
      lines: [{ skuCode: 'A-1', locationCode: 'L-1', batchNo: 'B1', quantity: 4 }],
    })) as { scrapNo: string };
    await ws.tools.invoke('wms.scrap.confirm', { scrapNo });
    const before = ws.scraps.byNo(scrapNo)!;
    const linesBefore = ws.scraps.lines(before.id);
    ws.replay();
    const after = ws.scraps.byNo(scrapNo)!;
    expect(after).toEqual(before);
    expect(ws.scraps.lines(after.id)).toEqual(linesBefore);
    expect(qty('A-1', 'L-1', 'B1')).toBe(6);
  });
});
