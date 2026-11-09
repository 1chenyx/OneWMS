import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  DEFAULT_LOCATION_ID,
  listLpns,
  LpnAlreadyExistsError,
  LpnDisabledError,
  LpnPackedError,
  lpnStock,
  WmsDomain,
} from '../src/index.js';

/**
 * module.lpn：托盘占用已有库位桶，不是新的库存键。
 * 关掉之后不能再装托，已经装上的占用不再拦截数量调整。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-lpn');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: 5,
    locationCode: 'A-01',
    reason: '期初',
  });
});

afterEach(() => {
  core.close();
});

function disableLpn(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.lpn/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'lpn test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qty(locationCode: string, skuCode = 'A-1'): number {
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

describe('module.lpn', () => {
  it('装托不改库存；超装拒绝；卸下后再整托移库', async () => {
    await ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-1', locationCode: 'A-01' });
    const before = watermark();
    await ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 3 });
    const packedTypes = typesAfter(before);
    expect(packedTypes).toEqual(['wms.lpn.packed']);
    expect(qty('A-01')).toBe(5);
    expect(lpnStock(ws, 'P-1').lines).toEqual([{ skuCode: 'A-1', batchNo: 'DEFAULT', quantity: 3 }]);

    const over = watermark();
    await expect(ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 3 })).rejects.toThrow(
      LpnPackedError,
    );
    expect(typesAfter(over)).toEqual([]);

    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -3, locationCode: 'A-01', reason: '报损' }),
    ).rejects.toThrow(LpnPackedError);
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -2, locationCode: 'A-01', reason: '报损' });
    expect(qty('A-01')).toBe(3);

    await ws.tools.invoke('wms.lpn.unpack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 1 });
    expect(lpnStock(ws, 'P-1').lines).toEqual([{ skuCode: 'A-1', batchNo: 'DEFAULT', quantity: 2 }]);
    expect(qty('A-01')).toBe(3);

    await ws.tools.invoke('wms.lpn.move', { lpnCode: 'P-1', toLocationCode: 'B-02' });
    expect(qty('A-01')).toBe(1);
    expect(qty('B-02')).toBe(2);
    expect(lpnStock(ws, 'P-1').locationCode).toBe('B-02');
    expect(listLpns(ws)).toEqual([expect.objectContaining({ lpnCode: 'P-1', locationCode: 'B-02', lineCount: 1 })]);
  });

  it('重复编码拒绝；关掉之后不能装托，但可以按数量把占用过的货调走', async () => {
    await ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-1', locationCode: 'A-01' });
    const dup = ws.events.count();
    await expect(ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-1' })).rejects.toThrow(LpnAlreadyExistsError);
    expect(ws.events.count()).toBe(dup);
    await ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 4 });
    disableLpn();

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-2' })).rejects.toThrow(LpnDisabledError);
    await expect(ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 1 })).rejects.toThrow(
      LpnDisabledError,
    );
    await expect(ws.tools.invoke('wms.lpn.move', { lpnCode: 'P-1', toLocationCode: 'B-02' })).rejects.toThrow(
      LpnDisabledError,
    );
    expect(() => listLpns(ws)).toThrow(LpnDisabledError);
    expect(() => lpnStock(ws, 'P-1')).toThrow(LpnDisabledError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -5, locationCode: 'A-01', reason: '清掉' });
    expect(qty('A-01')).toBe(0);
    expect(ws.lpns.byCode('P-1')).toBeTruthy();
    expect(ws.lpns.lines(ws.lpns.byCode('P-1')!.id)[0]?.quantity).toBe(4);
  });

  it('序列号跟着托盘走；重放后托盘、行和库存还在', async () => {
    // 有库存的 A-1 不能再改成按序列号管理，序列件用一张空 SKU。
    await ws.tools.invoke('wms.sku.create', { skuCode: 'S-9', name: '序列件', serialTracked: true });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'S-9',
      delta: 2,
      serials: ['S-1', 'S-2'],
      locationCode: 'A-01',
      reason: '期初',
    });
    await ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-1', locationCode: 'A-01' });
    await ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'S-9', quantity: 2, serials: ['S-1', 'S-2'] });
    expect(ws.serials.byNo('S-1')?.lpnId).toBe(ws.lpns.byCode('P-1')!.id);
    expect(qty('A-01', 'S-9')).toBe(2);
    expect(qty('A-01')).toBe(5);

    await expect(
      ws.tools.invoke('wms.inventory.move', {
        skuCode: 'S-9',
        fromLocationCode: 'A-01',
        toLocationCode: 'B-02',
        quantity: 2,
        serials: ['S-1', 'S-2'],
      }),
    ).rejects.toThrow(LpnPackedError);

    await ws.tools.invoke('wms.lpn.move', { lpnCode: 'P-1', toLocationCode: 'B-02' });
    expect(qty('A-01', 'S-9')).toBe(0);
    expect(qty('B-02', 'S-9')).toBe(2);
    expect(qty('A-01')).toBe(5);
    expect(ws.serials.byNo('S-1')).toMatchObject({
      locationId: ws.locations.byCode('B-02')!.id,
      lpnId: ws.lpns.byCode('P-1')!.id,
      status: 'in',
    });

    ws.replay();
    expect(qty('A-01', 'S-9')).toBe(0);
    expect(qty('B-02', 'S-9')).toBe(2);
    expect(qty('A-01')).toBe(5);
    expect(lpnStock(ws, 'P-1')).toMatchObject({
      locationCode: 'B-02',
      lines: [{ skuCode: 'S-9', batchNo: 'DEFAULT', quantity: 2 }],
    });
    expect(ws.serials.byNo('S-2')?.status).toBe('in');
  });
});
