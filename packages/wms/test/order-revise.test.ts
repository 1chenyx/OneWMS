import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.partner.create', { partnerCode: 'S-1', kind: 'supplier', name: '华东供应商' });
});

afterEach(() => {
  core.close();
});

describe('修订出入库单', () => {
  it('未入账的入库单可以改备注、往来单位和明细', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
      note: '原备注',
    })) as { orderNo: string };

    await ws.tools.invoke('wms.order.revise', {
      orderNo: created.orderNo,
      note: '改过的备注',
      partnerCode: 'S-1',
      lines: [
        { skuCode: 'A-1', quantity: 4, batchNo: 'B-1', batchExpiryDate: '2027-01-01' },
        { skuCode: 'B-2', quantity: 2 },
      ],
    });

    const order = ws.orders.byNo(created.orderNo)!;
    expect(order.note).toBe('改过的备注');
    expect(order.state).toBe('created');
    expect(order.partnerId).toBe(ws.partners.byCode('S-1')!.id);
    const lines = ws.orders.lines(order.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ quantity: 4, batchNo: 'B-1', batchExpiryDate: '2027-01-01' });
    expect(lines[1]).toMatchObject({ quantity: 2, batchNo: 'DEFAULT' });
  });

  it('直接入库不能写预计到货日；预报单可以改', async () => {
    const direct = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    await expect(
      ws.tools.invoke('wms.order.revise', { orderNo: direct.orderNo, expectedAt: '2026-12-01' }),
    ).rejects.toThrow(/预计到货日|不能改/);

    const asn = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      asn: true,
      expectedAt: '2026-12-01',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.revise', { orderNo: asn.orderNo, expectedAt: '2026-12-15' });
    expect(ws.orders.byNo(asn.orderNo)!.expectedAt).toBe('2026-12-15');
    expect(ws.orders.byNo(asn.orderNo)!.state).toBe('announced');
  });

  it('收货之后不能改明细，备注仍可改；完成后连备注也不行', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      note: '收货前',
      lines: [{ skuCode: 'A-1', quantity: 8 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'received' });

    await expect(
      ws.tools.invoke('wms.order.revise', {
        orderNo: created.orderNo,
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/已经收货入账/);
    await ws.tools.invoke('wms.order.revise', { orderNo: created.orderNo, note: '收货后补了一句' });
    expect(ws.orders.byNo(created.orderNo)!.note).toBe('收货后补了一句');
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.quantity).toBe(8);

    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'done' });
    await expect(
      ws.tools.invoke('wms.order.revise', { orderNo: created.orderNo, note: '想再改' }),
    ).rejects.toThrow(/已结束/);
  });

  it('出库进入拣货后不能改明细，备注仍可改', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, reason: '期初' });
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 2 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'picking' });

    await expect(
      ws.tools.invoke('wms.order.revise', {
        orderNo: created.orderNo,
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/拣货占用或已经发货/);
    await ws.tools.invoke('wms.order.revise', { orderNo: created.orderNo, note: '拣货备注' });
    expect(ws.orders.byNo(created.orderNo)!.note).toBe('拣货备注');
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.quantity).toBe(2);
  });
});
