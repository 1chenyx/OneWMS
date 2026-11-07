import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  AsnDirectionError,
  AsnDisabledError,
  AsnExpectedAtError,
  AsnWithReturnError,
  PartialNotOnPostError,
  WmsDomain,
} from '../src/index.js';

/**
 * module.asn：入库可以先预报，到货再收货。不传 asn 仍是直接入库。
 * 停用后不能再开预报；已经预报的仍可收货或取消。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-asn');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

function disableAsn(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.asn/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'asn test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qty(): number {
  return ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id);
}

describe('module.asn', () => {
  it('预报不加库存，收货才加；不带 asn 仍从已创建直接收货', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-1',
      asn: true,
      expectedAt: '2026-11-20',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string; state: string };
    expect(created.state).toBe('announced');
    expect(ws.orders.byNo('ASN-1')).toMatchObject({ state: 'announced', expectedAt: '2026-11-20' });
    expect(qty()).toBe(0);

    await ws.tools.invoke('wms.order.transition', { orderNo: 'ASN-1', to: 'received' });
    expect(ws.orders.byNo('ASN-1')!.state).toBe('received');
    expect(qty()).toBe(10);

    const direct = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 2 }],
    })) as { orderNo: string; state: string };
    expect(direct.state).toBe('created');
    expect(ws.orders.byNo(direct.orderNo)!.expectedAt).toBeNull();
    await ws.tools.invoke('wms.order.transition', { orderNo: direct.orderNo, to: 'received' });
    expect(qty()).toBe(12);
  });

  it('取消预报不动库存；短收按实数加库存；取消转移不能带实数', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-CANCEL',
      asn: true,
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    });
    await expect(
      ws.tools.invoke('wms.order.transition', {
        orderNo: 'ASN-CANCEL',
        to: 'canceled',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(PartialNotOnPostError);
    await ws.tools.invoke('wms.order.transition', { orderNo: 'ASN-CANCEL', to: 'canceled' });
    expect(ws.orders.byNo('ASN-CANCEL')!.state).toBe('canceled');
    expect(qty()).toBe(0);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-SHORT',
      asn: true,
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: 'ASN-SHORT',
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 4 }],
    });
    expect(qty()).toBe(4);
    expect(ws.orders.lines(ws.orders.byNo('ASN-SHORT')!.id)[0]!.fulfilledQty).toBe(4);
  });

  it('停用后新预报被拒绝且不落事件；已预报的仍可收货；不带参数仍可直接入库', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-1',
      asn: true,
      expectedAt: '2026-12-01',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    disableAsn();
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        asn: true,
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnDisabledError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        expectedAt: '2026-12-02',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnDisabledError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.order.transition', { orderNo: 'ASN-1', to: 'received' });
    expect(qty()).toBe(3);

    const plain = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { state: string };
    expect(plain.state).toBe('created');
  });

  it('出库、退货、非法日期、只填日期不开预报，都拒绝', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        asn: true,
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnDirectionError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        asn: true,
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnWithReturnError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        expectedAt: '2026-11-20',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnExpectedAtError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        asn: true,
        expectedAt: '2026-02-31',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(AsnExpectedAtError);
    expect(ws.orders.list()).toHaveLength(0);
  });

  it('重放后预报状态和预计到货日还在', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'ASN-1',
      asn: true,
      expectedAt: '2026-11-20',
      lines: [{ skuCode: 'A-1', quantity: 2 }],
    });
    ws.replay();
    expect(ws.orders.byNo('ASN-1')).toMatchObject({ state: 'announced', expectedAt: '2026-11-20' });
    expect(qty()).toBe(0);
  });
});
