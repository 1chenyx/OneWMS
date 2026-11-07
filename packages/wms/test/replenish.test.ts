import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
  getReplenishment,
  PartnerKindMismatchError,
  PartnerNotFoundError,
  ReplenishDisabledError,
  ReplenishEmptyError,
  ReplenishNotShortError,
  SkuNotFoundError,
  WmsDomain,
} from '../src/index.js';

/**
 * module.replenish：按缺口开一张普通入库单。
 * 停用后不能再生成；低库存预警仍在；已经开出的单仍可收货。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-replenish');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 10 });
});

afterEach(() => {
  core.close();
});

function disableReplenish(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.replenish/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'replenish test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qty(skuCode = 'A-1'): number {
  return ws.inventory.quantityOf(ws.skus.byCode(skuCode)!.id);
}

function suggested(skuCode: string): number | undefined {
  return getReplenishment(ws).find((row) => row.skuCode === skuCode)?.suggestedQty;
}

describe('module.replenish', () => {
  it('缺口开入库单且不加库存；再开是空的；收货后库存补到安全库存', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: '期初' });
    expect(suggested('A-1')).toBe(6);

    const created = (await ws.tools.invoke('wms.replenish.create', { orderNo: 'REP-1' })) as {
      orderNo: string;
      state: string;
      lines: { skuCode: string; quantity: number }[];
    };
    expect(created).toMatchObject({
      orderNo: 'REP-1',
      state: 'created',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    const order = ws.orders.byNo('REP-1')!;
    expect(order).toMatchObject({ state: 'created', replenishment: true, note: '补货' });
    expect(ws.orders.lines(order.id)[0]).toMatchObject({
      quantity: 6,
      locationId: DEFAULT_LOCATION_ID,
      batchNo: DEFAULT_BATCH_NO,
    });
    expect(qty()).toBe(4);
    expect(suggested('A-1')).toBeUndefined();

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.replenish.create', {})).rejects.toThrow(ReplenishEmptyError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.order.transition', { orderNo: 'REP-1', to: 'received' });
    expect(ws.orders.byNo('REP-1')!.state).toBe('received');
    expect(qty()).toBe(10);
    expect(suggested('A-1')).toBeUndefined();
  });

  it('停用后新补货被拒绝且不落事件；已开出的仍可收货；普通入库不受影响', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: '期初' });
    await ws.tools.invoke('wms.replenish.create', { orderNo: 'REP-1' });
    disableReplenish();

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.replenish.create', {})).rejects.toThrow(ReplenishDisabledError);
    expect(() => getReplenishment(ws)).toThrow(ReplenishDisabledError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.order.transition', { orderNo: 'REP-1', to: 'received' });
    expect(qty()).toBe(10);

    const plain = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-PLAIN',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { state: string };
    expect(plain.state).toBe('created');
    expect(ws.orders.byNo('IN-PLAIN')!.replenishment).toBe(false);
  });

  it('预报和未收货入库占缺口；已收货和已取消不占；冻结和预占吃掉可用量', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: '期初' });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-1',
      asn: true,
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    expect(suggested('A-1')).toBe(3);

    await ws.tools.invoke('wms.sku.create', { skuCode: 'F-1', name: '已收', reorderPoint: 10 });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-F',
      lines: [{ skuCode: 'F-1', quantity: 4 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-F', to: 'received' });
    expect(qty('F-1')).toBe(4);
    expect(suggested('F-1')).toBe(6);

    await ws.tools.invoke('wms.sku.create', { skuCode: 'G-1', name: '取消', reorderPoint: 8 });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-G',
      lines: [{ skuCode: 'G-1', quantity: 8 }],
    });
    expect(suggested('G-1')).toBeUndefined();
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-G', to: 'canceled' });
    expect(suggested('G-1')).toBe(8);

    await ws.tools.invoke('wms.sku.create', { skuCode: 'H-1', name: '冻结', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'H-1', delta: 10, reason: '期初' });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'H-1', quantity: 6, reason: '质检' });
    expect(suggested('H-1')).toBe(6);

    await ws.tools.invoke('wms.sku.create', { skuCode: 'R-1', name: '预占', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'R-1', delta: 10, reason: '期初' });
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-R',
      lines: [{ skuCode: 'R-1', quantity: 6 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-R', to: 'picking' });
    expect(suggested('R-1')).toBe(6);
  });

  it('零库存按安全库存建议；停用档案排除；选码、空单、重复编码按缺口处理', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母', reorderPoint: 5 });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'C-3', name: '停用', reorderPoint: 20 });
    await ws.tools.invoke('wms.sku.archive', { skuCode: 'C-3' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'E-1', name: '够用', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'E-1', delta: 10, reason: '期初' });

    const rows = getReplenishment(ws);
    expect(rows.map((row) => row.skuCode)).toEqual(['A-1', 'B-2']);
    expect(rows.map((row) => row.suggestedQty)).toEqual([10, 5]);
    expect(rows.find((row) => row.skuCode === 'A-1')).toMatchObject({ total: 0, inboundOpen: 0 });

    await expect(ws.tools.invoke('wms.replenish.create', { skuCodes: ['Z-9'] })).rejects.toThrow(SkuNotFoundError);
    await expect(ws.tools.invoke('wms.replenish.create', { skuCodes: ['E-1'] })).rejects.toThrow(
      ReplenishNotShortError,
    );
    await expect(ws.tools.invoke('wms.replenish.create', { skuCodes: ['C-3'] })).rejects.toThrow(
      ReplenishNotShortError,
    );

    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.replenish.create', { skuCodes: [] })).rejects.toThrow(ReplenishEmptyError);
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.list('in')).toHaveLength(0);

    const one = (await ws.tools.invoke('wms.replenish.create', {
      orderNo: 'REP-B',
      skuCodes: ['B-2', 'B-2'],
    })) as { lines: { skuCode: string; quantity: number }[] };
    expect(one.lines).toEqual([{ skuCode: 'B-2', quantity: 5 }]);

    const all = (await ws.tools.invoke('wms.replenish.create', { orderNo: 'REP-ALL' })) as {
      lines: { skuCode: string; quantity: number }[];
    };
    expect(all.lines).toEqual([{ skuCode: 'A-1', quantity: 10 }]);
    expect(ws.orders.byNo('REP-ALL')!.replenishment).toBe(true);
  });

  it('重放后仍是已创建的补货单，收货前库存不变', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: '期初' });
    await ws.tools.invoke('wms.replenish.create', { orderNo: 'REP-1' });
    ws.replay();
    expect(ws.orders.byNo('REP-1')).toMatchObject({ state: 'created', replenishment: true });
    expect(qty()).toBe(4);
    await ws.tools.invoke('wms.order.transition', { orderNo: 'REP-1', to: 'received' });
    expect(qty()).toBe(10);
  });

  it('供应商写入单据；客户和未知往来单位拒绝且不开单', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: '期初' });
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', kind: 'supplier', name: '供应商' });
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });

    await expect(ws.tools.invoke('wms.replenish.create', { partnerCode: 'NOPE' })).rejects.toThrow(
      PartnerNotFoundError,
    );
    await expect(ws.tools.invoke('wms.replenish.create', { partnerCode: 'CUS-1' })).rejects.toThrow(
      PartnerKindMismatchError,
    );
    expect(ws.orders.list('in')).toHaveLength(0);

    await ws.tools.invoke('wms.replenish.create', { orderNo: 'REP-1', partnerCode: 'SUP-1' });
    expect(ws.orders.byNo('REP-1')!.partnerId).toBe(ws.partners.byCode('SUP-1')!.id);
  });
});
