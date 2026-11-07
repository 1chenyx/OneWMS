import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  DEFAULT_LOCATION_ID,
  listWarehouseStock,
  listWarehouses,
  WarehouseAlreadyExistsError,
  WarehouseDisabledError,
  WarehouseNotFoundError,
  WmsDomain,
} from '../src/index.js';

/**
 * module.warehouse：仓库是库位的上一层。
 * 库存主键仍是工作区 + SKU + 库位 + 批次。关掉模块就不能再划仓。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-warehouse');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

function disableWarehouse(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.warehouse/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'warehouse test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qtyAt(locationCode: string): number {
  const skuId = ws.skus.byCode('A-1')!.id;
  const locationId =
    locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(skuId, locationId);
}

describe('module.warehouse', () => {
  it('划仓后库存出现在该仓库；未分仓和 DEFAULT 不算进去；清单只在已划仓时带仓库编码', async () => {
    const created = (await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1' })) as {
      warehouseCode: string;
      name: string;
    };
    expect(created).toMatchObject({ warehouseCode: 'WH-1', name: 'WH-1' });
    await ws.tools.invoke('wms.warehouse.update', { warehouseCode: 'WH-1', name: '一号仓' });

    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'C-03', name: '三号架', warehouseCode: '' });
    const warehouseId = ws.warehouses.byCode('WH-1')!.id;
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(warehouseId);
    expect(ws.locations.byCode('B-02')?.warehouseId).toBeNull();
    expect(ws.locations.byCode('C-03')?.warehouseId).toBeNull();

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, locationCode: 'A-01', reason: '期初' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 9, locationCode: 'B-02', reason: '期初' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2, reason: '期初' });

    const stock = listWarehouseStock(ws, 'WH-1');
    expect(stock.name).toBe('一号仓');
    expect(stock.rows).toEqual([
      expect.objectContaining({ skuCode: 'A-1', locationCode: 'A-01', batchNo: 'DEFAULT', quantity: 4 }),
    ]);
    expect(listWarehouses(ws)).toEqual([
      expect.objectContaining({ warehouseCode: 'WH-1', name: '一号仓', locationCount: 1 }),
    ]);

    const list = (await ws.tools.invoke('wms.location.list', {})) as {
      locationCode: string;
      warehouseCode?: string;
    }[];
    expect(list).toEqual([
      { locationCode: 'A-01', name: '一号架', createdAt: expect.any(String), warehouseCode: 'WH-1' },
      { locationCode: 'B-02', name: '二号架', createdAt: expect.any(String) },
      { locationCode: 'C-03', name: '三号架', createdAt: expect.any(String) },
    ]);
    expect(Object.hasOwn(list[1]!, 'warehouseCode')).toBe(false);
  });

  it('未知仓库不建库位；空仓库编码拒绝；重复编码拒绝', async () => {
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: 'A-01', warehouseCode: 'NOPE' }),
    ).rejects.toThrow(WarehouseNotFoundError);
    expect(ws.events.count()).toBe(before);
    expect(ws.locations.list()).toHaveLength(0);

    await expect(ws.tools.invoke('wms.warehouse.create', { warehouseCode: '  ' })).rejects.toThrow(/不能为空/);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    const after = ws.events.count();
    await expect(ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1' })).rejects.toThrow(
      WarehouseAlreadyExistsError,
    );
    expect(ws.events.count()).toBe(after);
  });

  it('关掉之后不能再划仓；已划的库位和库存留在原地，改名、调整、移库仍可用', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, locationCode: 'A-01', reason: '期初' });
    const warehouseId = ws.locations.byCode('A-01')!.warehouseId;
    disableWarehouse();

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-2' })).rejects.toThrow(
      WarehouseDisabledError,
    );
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: 'C-03', warehouseCode: 'WH-1' }),
    ).rejects.toThrow(WarehouseDisabledError);
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: 'D-04', warehouseCode: '' }),
    ).rejects.toThrow(WarehouseDisabledError);
    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: 'B-02', warehouseCode: 'WH-1' }),
    ).rejects.toThrow(WarehouseDisabledError);
    expect(() => listWarehouses(ws)).toThrow(WarehouseDisabledError);
    expect(() => listWarehouseStock(ws, 'WH-1')).toThrow(WarehouseDisabledError);
    expect(ws.events.count()).toBe(before);
    expect(ws.locations.byCode('C-03')).toBeUndefined();

    const plain = (await ws.tools.invoke('wms.location.create', { locationCode: 'E-05', name: '五号架' })) as {
      locationCode: string;
    };
    expect(plain.locationCode).toBe('E-05');
    expect(ws.locations.byCode('E-05')?.warehouseId).toBeNull();
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(warehouseId);

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '一号架改' });
    expect(ws.locations.byCode('A-01')).toMatchObject({ name: '一号架改', warehouseId });

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1, locationCode: 'A-01', reason: '补' });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'A-01',
      toLocationCode: 'B-02',
      quantity: 2,
    });
    expect(qtyAt('A-01')).toBe(3);
    expect(qtyAt('B-02')).toBe(2);

    const list = (await ws.tools.invoke('wms.location.list', {})) as { locationCode: string; warehouseCode?: string }[];
    expect(list.find((row) => row.locationCode === 'A-01')?.warehouseCode).toBe('WH-1');
  });

  it('划出仓库后货还在原库位，但离开仓库视图；两仓之间移库只换库位', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-2', name: '二号仓' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, locationCode: 'A-01', reason: '期初' });
    const locationId = ws.locations.byCode('A-01')!.id;
    const before = ws.events.count();
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', warehouseCode: 'WH-1' });
    const assigned: string[] = [];
    ws.events.forEach((env) => {
      if (env.lamport > 0) assigned.push(env.type);
    }, { fromLamport: before - 1 });
    expect(assigned.filter((type) => type === 'wms.inventory.adjusted')).toEqual([]);
    expect(qtyAt('A-01')).toBe(5);
    expect(listWarehouseStock(ws, 'WH-1').rows).toEqual([
      expect.objectContaining({ locationCode: 'A-01', quantity: 5 }),
    ]);

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', warehouseCode: '' });
    expect(ws.locations.byCode('A-01')?.warehouseId).toBeNull();
    expect(ws.locations.byCode('A-01')?.id).toBe(locationId);
    expect(qtyAt('A-01')).toBe(5);
    expect(listWarehouseStock(ws, 'WH-1').rows).toEqual([]);

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架', warehouseCode: 'WH-2' });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'A-01',
      toLocationCode: 'B-02',
      quantity: 5,
    });
    expect(qtyAt('A-01')).toBe(0);
    expect(qtyAt('B-02')).toBe(5);
    expect(listWarehouseStock(ws, 'WH-1').rows).toEqual([]);
    expect(listWarehouseStock(ws, 'WH-2').rows).toEqual([
      expect.objectContaining({ locationCode: 'B-02', quantity: 5 }),
    ]);
    const buckets = ws.inventory.list().map((row) => row.locationId);
    expect(buckets).not.toContain(ws.warehouses.byCode('WH-2')!.id);
  });

  it('重放后仓库、库位归属和库存都还在', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 3, locationCode: 'A-01', reason: '期初' });
    const warehouseId = ws.warehouses.byCode('WH-1')!.id;
    const locationId = ws.locations.byCode('A-01')!.id;

    ws.replay();

    expect(ws.warehouses.byCode('WH-1')).toMatchObject({ id: warehouseId, name: '一号仓' });
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(warehouseId);
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, locationId)).toBe(3);
    expect(listWarehouseStock(ws, 'WH-1').rows).toEqual([
      expect.objectContaining({ locationCode: 'A-01', quantity: 3 }),
    ]);
  });
});
