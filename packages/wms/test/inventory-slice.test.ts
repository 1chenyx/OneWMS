import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  listInventorySlices,
  LocationNotFoundError,
  WarehouseDisabledError,
  WmsDomain,
} from '../src/index.js';

/**
 * 库存页的分维度查询：同一批桶，按 SKU / 库位 / 批次 / 仓库加总。
 * 只含实物余量。零余量不列出。仓库是库位的上一层，未分仓含 DEFAULT。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-slice');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', unit: '个' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
  await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-2', name: '二号仓' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架', warehouseCode: 'WH-2' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'Z-09', name: '散货' });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: 4,
    locationCode: 'A-01',
    batchNo: 'B1',
    batchExpiryDate: '2027-06-01',
    reason: '期初',
  });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: 6,
    locationCode: 'A-01',
    batchNo: 'B2',
    batchExpiryDate: '2027-07-01',
    reason: '期初',
  });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: 9,
    locationCode: 'B-02',
    reason: '期初',
  });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2, reason: '期初' });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'B-2',
    delta: 1,
    locationCode: 'Z-09',
    batchNo: 'B1',
    batchExpiryDate: '2027-08-01',
    reason: '期初',
  });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: 3,
    locationCode: 'A-01',
    batchNo: 'B-ZERO',
    reason: '期初',
  });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: -3,
    locationCode: 'A-01',
    batchNo: 'B-ZERO',
    reason: '清空',
  });
  await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 1, reason: '隔离' });
});

afterEach(() => {
  core.close();
});

function page(view: 'sku' | 'location' | 'batch' | 'warehouse', extra: Record<string, unknown> = {}) {
  return listInventorySlices(ws, { view, limit: 50, offset: 0, ...extra });
}

describe('listInventorySlices', () => {
  it('按库位把同一库位的批次加总，展开仍是各批次；零余量不出现', () => {
    const rows = page('location').rows;
    const a01 = rows.find((row) => row.skuCode === 'A-1' && row.locationCode === 'A-01');
    expect(a01).toMatchObject({ locationName: '一号架', quantity: 10, unit: '个' });
    expect(a01?.details.map((detail) => [detail.batchNo, detail.quantity])).toEqual([
      ['B1', 4],
      ['B2', 6],
    ]);
    expect(rows.some((row) => row.details.some((detail) => detail.batchNo === 'B-ZERO'))).toBe(false);
    expect(rows.map((row) => `${row.locationCode}:${row.skuCode}`)).toEqual([
      'A-01:A-1',
      'B-02:A-1',
      'DEFAULT:A-1',
      'Z-09:B-2',
    ]);
  });

  it('按批次跨库位加总，效期取该批已登记的日期', () => {
    const b1 = page('batch').rows.filter((row) => row.batchNo === 'B1');
    expect(b1).toEqual([
      expect.objectContaining({
        skuCode: 'A-1',
        batchExpiryDate: '2027-06-01',
        quantity: 4,
        details: [expect.objectContaining({ locationCode: 'A-01', quantity: 4 })],
      }),
      expect.objectContaining({
        skuCode: 'B-2',
        batchExpiryDate: '2027-08-01',
        quantity: 1,
      }),
    ]);
    const loose = page('batch').rows.find((row) => row.skuCode === 'A-1' && row.batchNo === 'DEFAULT');
    expect(loose?.quantity).toBe(11);
    expect(loose?.details.map((detail) => detail.locationCode)).toEqual(['B-02', 'DEFAULT']);
  });

  it('按仓库把已划仓的库位加总，未分仓和 DEFAULT 单独一档，冻结不扣余量', () => {
    const rows = page('warehouse').rows;
    expect(rows.map((row) => [row.warehouseCode, row.skuCode, row.quantity])).toEqual([
      ['WH-1', 'A-1', 10],
      ['WH-2', 'A-1', 9],
      [null, 'A-1', 2],
      [null, 'B-2', 1],
    ]);
    expect(rows[0]).toMatchObject({ warehouseName: '一号仓' });
    expect(rows[2]).toMatchObject({ warehouseName: '未分仓', warehouseCode: null });
    expect(rows[2]?.details).toEqual([
      expect.objectContaining({ locationCode: 'DEFAULT', locationName: '默认库位', batchNo: 'DEFAULT', quantity: 2 }),
    ]);
    expect(rows[0]?.quantity).toBe(10);
  });

  it('筛选是并且关系；按 SKU 筛到库位后只剩该库位的实物合计', () => {
    const atA01 = page('sku', { locationCode: 'A-01', batchNo: 'B1' });
    expect(atA01.rows).toEqual([
      expect.objectContaining({
        skuCode: 'A-1',
        quantity: 4,
        details: [expect.objectContaining({ batchNo: 'B1', quantity: 4 })],
      }),
    ]);
    expect(atA01.rows[0]).not.toHaveProperty('held');

    const named = page('location', { q: '螺母' });
    expect(named.rows.map((row) => row.skuCode)).toEqual(['B-2']);

    const wh1 = page('warehouse', { warehouseId: ws.warehouses.byCode('WH-1')!.id });
    expect(wh1.rows.map((row) => row.skuCode)).toEqual(['A-1']);
    expect(wh1.rows[0]?.quantity).toBe(10);

    const loose = page('location', { warehouseId: null });
    expect(loose.rows.map((row) => row.locationCode).sort()).toEqual(['DEFAULT', 'Z-09']);
  });

  it('分页按排序后的行切，未知库位拒绝，关掉多仓后不能按仓库查', () => {
    const first = listInventorySlices(ws, { view: 'location', limit: 1, offset: 0 });
    expect(first.total).toBe(4);
    expect(first.hasMore).toBe(true);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.locationCode).toBe('A-01');

    expect(() => page('location', { locationCode: 'NOPE' })).toThrow(LocationNotFoundError);

    const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.warehouse/enabled', value: false }];
    const { proposalId } = ws.profile.propose('user:tester', patch, 'slice test');
    ws.profile.confirm(proposalId, 'user:tester');
    expect(() => page('warehouse')).toThrow(WarehouseDisabledError);
    expect(() => page('location', { warehouseId: null })).toThrow(WarehouseDisabledError);
    expect(page('location').rows).toHaveLength(4);
  });
});
