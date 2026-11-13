import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, ToolValidationError, type PatchOp } from '@one/core';
import {
  ZoneAlreadyExistsError,
  ZoneDisabledError,
  ZoneNotFoundError,
  ZoneOccupiedError,
  ZoneWarehouseMismatchError,
  WmsDomain,
  listZones,
} from '../src/index.js';

/**
 * module.zone：库区是库位上的分类。
 * 库存主键仍是工作区 + SKU + 库位 + 批次。关掉模块就不能再划区。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-zone');
});

afterEach(() => {
  core.close();
});

function disableZone(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.zone/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'zone test');
  ws.profile.confirm(proposalId, 'user:tester');
}

describe('module.zone', () => {
  it('建库区、把库位划进去，清单带上分类；没写仓库时库位跟着库区', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    const created = (await ws.tools.invoke('wms.zone.create', {
      zoneCode: 'PK-1',
      name: '一层拣货',
      kind: 'picking',
      warehouseCode: 'WH-1',
    })) as { zoneCode: string; kind: string };
    expect(created).toMatchObject({ zoneCode: 'PK-1', name: '一层拣货', kind: 'picking' });

    await ws.tools.invoke('wms.zone.create', { zoneCode: 'ST-1', kind: 'storage' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', zoneCode: 'PK-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '存货架', zoneCode: 'ST-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'Z-01', name: '散货' });

    const pick = ws.zones.byCode('PK-1')!;
    const store = ws.zones.byCode('ST-1')!;
    expect(ws.locations.byCode('A-01')).toMatchObject({
      zoneId: pick.id,
      warehouseId: ws.warehouses.byCode('WH-1')!.id,
    });
    expect(ws.locations.byCode('B-02')?.zoneId).toBe(store.id);
    expect(ws.locations.byCode('B-02')?.warehouseId).toBeNull();
    expect(ws.locations.byCode('Z-01')?.zoneId).toBeNull();

    expect(listZones(ws)).toEqual([
      expect.objectContaining({
        zoneCode: 'PK-1',
        name: '一层拣货',
        kind: 'picking',
        kindLabel: '拣货区',
        warehouseCode: 'WH-1',
        locationCount: 1,
      }),
      expect.objectContaining({
        zoneCode: 'ST-1',
        kind: 'storage',
        kindLabel: '存货区',
        warehouseCode: null,
        locationCount: 1,
      }),
    ]);

    const list = (await ws.tools.invoke('wms.location.list', {})) as {
      locationCode: string;
      zoneCode?: string;
      zoneKind?: string;
      warehouseCode?: string;
    }[];
    expect(list.find((row) => row.locationCode === 'A-01')).toMatchObject({
      zoneCode: 'PK-1',
      zoneKind: 'picking',
      warehouseCode: 'WH-1',
    });
    expect(Object.hasOwn(list.find((row) => row.locationCode === 'Z-01')!, 'zoneCode')).toBe(false);
  });

  it('分类不对、重复编码、未知库区都不落事件；空编码按规则生成', async () => {
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.zone.create', { zoneCode: 'X-1', kind: 'bulk' })).rejects.toThrow(
      ToolValidationError,
    );
    await expect(ws.tools.invoke('wms.location.create', { locationCode: 'A-01', zoneCode: 'NOPE' })).rejects.toThrow(
      ZoneNotFoundError,
    );
    expect(ws.events.count()).toBe(before);
    expect(ws.zones.list()).toHaveLength(0);
    expect(ws.locations.list()).toHaveLength(0);

    const blank = (await ws.tools.invoke('wms.zone.create', { zoneCode: '  ', kind: 'receiving' })) as {
      zoneCode: string;
    };
    expect(blank.zoneCode).toBe('ZN-01');

    await expect(ws.tools.invoke('wms.zone.create', { zoneCode: 'ZN-01', kind: 'qc' })).rejects.toThrow(
      ZoneAlreadyExistsError,
    );
  });

  it('库位仓库和库区仓库不一致就拒绝；划出库区后仓库留着', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-2', name: '二号仓' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK-1', kind: 'picking', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', warehouseCode: 'WH-2' });

    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: 'A-01', zoneCode: 'PK-1' }),
    ).rejects.toThrow(ZoneWarehouseMismatchError);
    expect(ws.locations.byCode('A-01')?.zoneId).toBeNull();

    await ws.tools.invoke('wms.location.update', {
      locationCode: 'A-01',
      warehouseCode: 'WH-1',
      zoneCode: 'PK-1',
    });
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(ws.warehouses.byCode('WH-1')!.id);

    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: 'A-01', warehouseCode: 'WH-2' }),
    ).rejects.toThrow(ZoneWarehouseMismatchError);

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', zoneCode: '' });
    expect(ws.locations.byCode('A-01')?.zoneId).toBeNull();
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(ws.warehouses.byCode('WH-1')!.id);
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', warehouseCode: 'WH-2' });
    expect(ws.locations.byCode('A-01')?.warehouseId).toBe(ws.warehouses.byCode('WH-2')!.id);
  });

  it('库区里还有库位时不能改它的仓库；改分类不影响库位', async () => {
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-1', name: '一号仓' });
    await ws.tools.invoke('wms.warehouse.create', { warehouseCode: 'WH-2', name: '二号仓' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'ST-1', name: '存货', kind: 'storage', warehouseCode: 'WH-1' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', zoneCode: 'ST-1' });

    await expect(
      ws.tools.invoke('wms.zone.update', { zoneCode: 'ST-1', warehouseCode: 'WH-2' }),
    ).rejects.toThrow(ZoneOccupiedError);
    expect(ws.zones.byCode('ST-1')?.warehouseId).toBe(ws.warehouses.byCode('WH-1')!.id);

    await ws.tools.invoke('wms.zone.update', { zoneCode: 'ST-1', kind: 'picking', name: '改成拣货' });
    expect(ws.zones.byCode('ST-1')).toMatchObject({ kind: 'picking', name: '改成拣货' });
    expect(ws.locations.byCode('A-01')?.zoneId).toBe(ws.zones.byCode('ST-1')!.id);
  });

  it('关掉之后不能再划区；已经划好的库位留在原库区，改名仍可用', async () => {
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK-1', kind: 'picking', name: '拣货' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架', zoneCode: 'PK-1' });
    const zoneId = ws.locations.byCode('A-01')!.zoneId;
    disableZone();

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.zone.create', { kind: 'storage' })).rejects.toThrow(ZoneDisabledError);
    await expect(ws.tools.invoke('wms.location.create', { locationCode: 'B-02', zoneCode: 'PK-1' })).rejects.toThrow(
      ZoneDisabledError,
    );
    await expect(ws.tools.invoke('wms.location.create', { locationCode: 'C-03', zoneCode: '' })).rejects.toThrow(
      ZoneDisabledError,
    );
    await expect(ws.tools.invoke('wms.location.update', { locationCode: 'A-01', zoneCode: '' })).rejects.toThrow(
      ZoneDisabledError,
    );
    expect(() => listZones(ws)).toThrow(ZoneDisabledError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.location.create', { locationCode: 'D-04', name: '四号架' });
    expect(ws.locations.byCode('D-04')?.zoneId).toBeNull();
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '一号架改' });
    expect(ws.locations.byCode('A-01')).toMatchObject({ name: '一号架改', zoneId });
  });
});
