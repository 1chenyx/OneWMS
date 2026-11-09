import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  DEFAULT_LOCATION_ID,
  listSerials,
  querySerial,
  SerialAlreadyInStockError,
  SerialCountError,
  SerialDisabledError,
  SerialNotTrackedError,
  SerialRequiredError,
  SerialStockError,
  WmsDomain,
} from '../src/index.js';

/**
 * module.serial：一件一个号。库存主键仍是工作区 + SKU + 库位 + 批次。
 * 关掉模块就不能再带序列号参数，已经记下的号还在。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-serial');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
});

afterEach(() => {
  core.close();
});

function disableSerial(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.serial/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'serial test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qty(skuCode = 'A-1', locationCode = DEFAULT_LOCATION_ID): number {
  const skuId = ws.skus.byCode(skuCode)!.id;
  const locationId = locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(skuId, locationId);
}

function watermark(): number {
  let mark = -1;
  ws.events.forEach((env) => {
    mark = env.lamport;
  });
  return mark;
}

function typesAfter(mark: number): string[] {
  const types: string[] = [];
  ws.events.forEach((env) => types.push(env.type), { fromLamport: mark });
  return types;
}

describe('module.serial', () => {
  it('有库存不能改成按序列号管理；标上之后调整必须带号，号和件数一致', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 1, reason: '期初' });
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.sku.update', { skuCode: 'B-2', serialTracked: true })).rejects.toThrow(
      SerialStockError,
    );
    expect(ws.events.count()).toBe(before);
    expect(ws.skus.byCode('B-2')!.serialTracked).toBe(false);

    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    expect(ws.skus.byCode('A-1')!.serialTracked).toBe(true);

    const marked = watermark();
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1, reason: '期初' })).rejects.toThrow(
      SerialRequiredError,
    );
    expect(typesAfter(marked)).toEqual([]);

    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 1, serials: ['N-1'], reason: '期初' }),
    ).rejects.toThrow(SerialNotTrackedError);
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.5, serials: ['S-1'], reason: '期初' }),
    ).rejects.toThrow(SerialCountError);

    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 2,
      serials: ['S-1', 'S-2'],
      locationCode: 'A-01',
      reason: '期初',
    });
    expect(qty('A-1', 'A-01')).toBe(2);
    expect(listSerials(ws, { skuCode: 'A-1' })).toEqual([
      expect.objectContaining({ serialNo: 'S-1', skuCode: 'A-1', locationCode: 'A-01', status: 'in' }),
      expect.objectContaining({ serialNo: 'S-2', skuCode: 'A-1', locationCode: 'A-01', status: 'in' }),
    ]);
    expect(Object.hasOwn(listSerials(ws)[0]!, 'lpnCode')).toBe(false);

    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -1,
      serials: ['S-1'],
      locationCode: 'A-01',
      reason: '报损',
    });
    expect(qty('A-1', 'A-01')).toBe(1);
    expect(querySerial(ws, 'S-1').status).toBe('out');
    expect(querySerial(ws, 'S-2').status).toBe('in');
  });

  it('入库单先占号，收货才入库；别人不能再占同一个在库号；取消收货把号退出', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-1'] }],
    })) as { orderNo: string };
    expect(qty()).toBe(0);
    expect(ws.serials.byNo('S-1')).toBeUndefined();
    expect(ws.orders.lines(ws.orders.byNo('IN-1')!.id)[0]?.serials).toEqual(['S-1']);

    const claimed = watermark();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-1'] }],
      }),
    ).rejects.toThrow(SerialStockError);
    expect(typesAfter(claimed)).toEqual([]);

    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'received' });
    expect(qty()).toBe(1);
    expect(ws.serials.byNo('S-1')?.status).toBe('in');

    const again = watermark();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-1'] }],
      }),
    ).rejects.toThrow(SerialAlreadyInStockError);
    expect(typesAfter(again)).toEqual([]);

    const outbound = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-1'] }],
    })) as { orderNo: string };
    const second = watermark();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-1'] }],
      }),
    ).rejects.toThrow(SerialStockError);
    expect(typesAfter(second)).toEqual([]);

    await ws.tools.invoke('wms.order.transition', { orderNo: outbound.orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outbound.orderNo, to: 'shipped' });
    expect(qty()).toBe(0);
    expect(ws.serials.byNo('S-1')?.status).toBe('out');

    // 取消收货要在号还在库时做。S-1 已经被出库单发出，再取消 IN-1 会去退一个已经出库的号。
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-2',
      lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-9'] }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-2', to: 'received' });
    expect(qty()).toBe(1);
    expect(ws.serials.byNo('S-9')?.status).toBe('in');
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-2', to: 'canceled' });
    expect(qty()).toBe(0);
    expect(ws.serials.byNo('S-9')?.status).toBe('out');
    expect(ws.serials.byNo('S-1')?.status).toBe('out');
  });

  it('关掉之后不能再带序列号参数；普通调整仍可用，已入库的号还在', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1, serials: ['S-1'], reason: '期初' });
    disableSerial();

    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1, serials: ['S-2'], reason: '期初' }),
    ).rejects.toThrow(SerialDisabledError);
    await expect(ws.tools.invoke('wms.sku.update', { skuCode: 'B-2', serialTracked: true })).rejects.toThrow(
      SerialDisabledError,
    );
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1, serials: ['S-9'] }],
      }),
    ).rejects.toThrow(SerialDisabledError);
    expect(() => listSerials(ws)).toThrow(SerialDisabledError);
    expect(() => querySerial(ws, 'S-1')).toThrow(SerialDisabledError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1, reason: '期初' });
    expect(qty()).toBe(2);
    expect(ws.serials.byNo('S-1')?.status).toBe('in');
    expect(ws.skus.byCode('A-1')!.serialTracked).toBe(true);
  });

  it('上架整行带走序列号；拆开上架拒绝；拣货必须从原桶出；盘点不能改按号管理的数量', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 2, serials: ['S-1', 'S-2'] }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-1', to: 'received' });

    const split = watermark();
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo: 'IN-1',
        targets: [
          { skuCode: 'A-1', toLocationCode: 'A-01' },
          { skuCode: 'A-1', toLocationCode: 'B-02' },
        ],
      }),
    ).rejects.toThrow(SerialStockError);
    expect(typesAfter(split)).toEqual([]);
    expect(qty()).toBe(2);

    await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-1',
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    });
    expect(qty('A-1', 'A-01')).toBe(2);
    expect(qty()).toBe(0);
    expect(ws.serials.byNo('S-1')).toMatchObject({ locationId: ws.locations.byCode('A-01')!.id, status: 'in' });

    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 2, locationCode: 'A-01', serials: ['S-1', 'S-2'] }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'picking' });
    const picking = (await ws.tools.invoke('wms.picking.create', { orderNos: ['OUT-1'] })) as { pickingNo: string };
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: picking.pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      pickedQty: 2,
      locationCode: 'B-02',
    });
    const mismatch = watermark();
    await expect(ws.tools.invoke('wms.picking.close', { pickingNo: picking.pickingNo })).rejects.toThrow(
      SerialStockError,
    );
    expect(typesAfter(mismatch)).toEqual([]);

    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: picking.pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      pickedQty: 2,
      locationCode: 'A-01',
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: picking.pickingNo });
    expect(qty('A-1', 'A-01')).toBe(0);
    expect(ws.serials.byNo('S-1')?.status).toBe('out');
    expect(ws.serials.byNo('S-2')?.status).toBe('out');
  });

  it('盘点零差异可以关；改数量拒绝。重放后号和库存还在', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      serials: ['S-1'],
      locationCode: 'A-01',
      reason: '期初',
    });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-1' });
    await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-1',
      skuCode: 'A-1',
      locationCode: 'A-01',
      countedQty: 1,
    });
    await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-1' });
    expect(qty('A-1', 'A-01')).toBe(1);

    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-2' });
    await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-2',
      skuCode: 'A-1',
      locationCode: 'A-01',
      countedQty: 0,
    });
    const before = watermark();
    await expect(ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-2' })).rejects.toThrow(SerialStockError);
    expect(typesAfter(before)).toEqual([]);
    expect(ws.serials.byNo('S-1')?.status).toBe('in');

    ws.replay();
    expect(qty('A-1', 'A-01')).toBe(1);
    expect(ws.serials.byNo('S-1')).toMatchObject({ status: 'in', serialNo: 'S-1' });
    expect(ws.skus.byCode('A-1')!.serialTracked).toBe(true);
  });
});
