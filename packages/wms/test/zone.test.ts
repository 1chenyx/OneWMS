import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, ToolValidationError, type PatchOp } from '@one/core';
import {
  ZoneAlreadyExistsError,
  ZoneDisabledError,
  ZoneKindDisabledError,
  ZoneNotFoundError,
  ZoneOccupiedError,
  ZoneUseError,
  ZoneWarehouseMismatchError,
  WmsDomain,
  listZones,
  readEnabledZoneKinds,
} from '../src/index.js';
import { allowDirectShip } from './direct-ship.js';

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

function setEnabledKinds(kinds: string[]): void {
  const settings = ws.profile.getSnapshot().modules['module.zone']?.settings;
  const op = settings && Object.hasOwn(settings, 'enabledKinds') ? 'replace' : 'add';
  const patch: PatchOp[] = [{ op, path: '/modules/module.zone/settings/enabledKinds', value: kinds }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'zone kinds');
  ws.profile.confirm(proposalId, 'user:tester');
}

const ALL_KINDS = ['receiving', 'qc', 'storage', 'picking', 'staging', 'shipping', 'return', 'defective'];

describe('启用的库区分类', () => {
  it('没配置按八种全开，空数组和杂项不会回退成全开', () => {
    expect(readEnabledZoneKinds(undefined)).toEqual(ALL_KINDS);
    expect(readEnabledZoneKinds(null)).toEqual(ALL_KINDS);
    expect(readEnabledZoneKinds('picking')).toEqual(ALL_KINDS);
    expect(readEnabledZoneKinds([])).toEqual([]);
    expect(readEnabledZoneKinds(['bulk'])).toEqual([]);
    expect(readEnabledZoneKinds(['picking', 'nope', 'storage', 'picking'])).toEqual(['storage', 'picking']);
  });
});

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

  it('分类限制收货、上架和发货；未分区和移库不受限', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'RCV', kind: 'receiving', name: '收货' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'ST', kind: 'storage', name: '存货' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK', kind: 'picking', name: '拣货' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'QC', kind: 'qc', name: '质检' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'R-01', zoneCode: 'RCV' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'S-01', zoneCode: 'ST' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'P-01', zoneCode: 'PK' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'Q-01', zoneCode: 'QC' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'Z-01', name: '散货' });

    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);
    expect(ws.events.count()).toBe(before);

    const inbound = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 4, locationCode: 'R-01' }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'received' });
    const sku = ws.skus.byCode('A-1')!;
    const at = (code: string) => ws.inventory.quantityOf(sku.id, ws.locations.byCode(code)!.id, 'DEFAULT');
    expect(at('R-01')).toBe(4);

    const loose = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'Z-01' }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: loose.orderNo, to: 'received' });
    expect(at('Z-01')).toBe(1);

    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo: inbound.orderNo,
        targets: [{ skuCode: 'A-1', fromLocationCode: 'R-01', toLocationCode: 'R-01', quantity: 1 }],
      }),
    ).rejects.toThrow(ZoneUseError);
    await ws.tools.invoke('wms.order.putaway', {
      orderNo: inbound.orderNo,
      targets: [{ skuCode: 'A-1', fromLocationCode: 'R-01', toLocationCode: 'S-01', quantity: 2 }],
    });
    expect(at('S-01')).toBe(2);

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 3, locationCode: 'P-01', reason: '补' });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'S-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
    });

    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'P-01',
      toLocationCode: 'Q-01',
      quantity: 1,
    });
    expect(at('Q-01')).toBe(1);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'Q-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);
  });

  it('退货区收客退和退供，不能当普通发货位', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'RT', kind: 'return', name: '退货' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'T-01', zoneCode: 'RT' });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-1', to: 'received' });
    allowDirectShip(ws);
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'shipped' });

    const returned = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 2, locationCode: 'T-01' }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: returned.orderNo, to: 'received' });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id, ws.locations.byCode('T-01')!.id, 'DEFAULT')).toBe(2);

    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'T-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);
    const back = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      returnOf: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'T-01' }],
    })) as { orderNo: string };
    expect(back.orderNo).toBeTruthy();
  });

  it('关掉拣货区后，旧拣货位可以收货，不能再新建拣货区', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK', kind: 'picking' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'P-01', zoneCode: 'PK' });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);

    setEnabledKinds(ALL_KINDS.filter((kind) => kind !== 'picking'));
    const received = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
    })) as { state: string };
    expect(received.state).toBe('created');

    await expect(ws.tools.invoke('wms.zone.create', { zoneCode: 'PK-2', kind: 'picking' })).rejects.toThrow(
      ZoneKindDisabledError,
    );
    const renamed = (await ws.tools.invoke('wms.zone.update', {
      zoneCode: 'PK',
      name: '旧拣货',
      kind: 'picking',
    })) as { name: string; kind: string };
    expect(renamed).toMatchObject({ name: '旧拣货', kind: 'picking' });

    await ws.tools.invoke('wms.zone.create', { zoneCode: 'ST', kind: 'storage' });
    await expect(ws.tools.invoke('wms.zone.update', { zoneCode: 'ST', kind: 'picking' })).rejects.toThrow(
      /拣货区没有启用/,
    );
  });

  it('只开拣货区时，拣货位仍不能收货，未分区可以', async () => {
    setEnabledKinds(['picking']);
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK', kind: 'picking' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'P-01', zoneCode: 'PK' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'Z-01' });
    await expect(ws.tools.invoke('wms.zone.create', { zoneCode: 'RCV', kind: 'receiving' })).rejects.toThrow(
      ZoneKindDisabledError,
    );
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);
    const loose = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'Z-01' }],
    })) as { state: string };
    expect(loose.state).toBe('created');
  });

  it('删掉启用名单后仍按八种限制；名单里全是杂项则不再限制', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK', kind: 'picking' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'P-01', zoneCode: 'PK' });
    const remove: PatchOp[] = [{ op: 'remove', path: '/modules/module.zone/settings/enabledKinds' }];
    const removed = ws.profile.propose('user:tester', remove, 'drop kinds');
    ws.profile.confirm(removed.proposalId, 'user:tester');
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
      }),
    ).rejects.toThrow(ZoneUseError);

    setEnabledKinds(['bulk']);
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
    })) as { state: string };
    expect(created.state).toBe('created');
    await expect(ws.tools.invoke('wms.zone.create', { zoneCode: 'ST', kind: 'storage' })).rejects.toThrow(
      ZoneKindDisabledError,
    );
  });

  it('关掉库区后，分类不再限制收货', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.zone.create', { zoneCode: 'PK', kind: 'picking' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'P-01', zoneCode: 'PK' });
    disableZone();
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'P-01' }],
    })) as { state: string };
    expect(created.state).toBe('created');
  });
});
