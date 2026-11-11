import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  PartialDisabledError,
  PartialNotOnPostError,
  PartialQtyExceededError,
  WmsDomain,
} from '../src/index.js';
import { allowDirectShip } from './direct-ship.js';

/**
 * module.partial：收货/发货可以少入账。不传实数时仍按订单数量。
 * 停用后不能改少。冲销按已入账数量，不按订单数量。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-partial');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

function disablePartial(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.partial/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'partial test');
  ws.profile.confirm(proposalId, 'user:tester');
}

describe('module.partial', () => {
  it('短收按实数加库存，订单数量仍在；不传实数则整单入账', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-SHORT',
      lines: [
        { skuCode: 'A-1', quantity: 10 },
        { skuCode: 'B-2', quantity: 4 },
      ],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', {
      orderNo: created.orderNo,
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    const skuA = ws.skus.byCode('A-1')!;
    const skuB = ws.skus.byCode('B-2')!;
    expect(ws.inventory.quantityOf(skuA.id)).toBe(6);
    expect(ws.inventory.quantityOf(skuB.id)).toBe(4);
    const lines = ws.orders.lines(ws.orders.byNo(created.orderNo)!.id);
    expect(lines.find((l) => l.skuId === skuA.id)).toMatchObject({ quantity: 10, fulfilledQty: 6 });
    expect(lines.find((l) => l.skuId === skuB.id)).toMatchObject({ quantity: 4, fulfilledQty: null });

    const full = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 2 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: full.orderNo, to: 'received' });
    expect(ws.inventory.quantityOf(skuA.id)).toBe(8);
    expect(ws.orders.lines(ws.orders.byNo(full.orderNo)!.id)[0]!.fulfilledQty).toBeNull();
  });

  it('短收后再取消，只扣回已入账的数量', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', {
      orderNo: created.orderNo,
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'canceled' });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.fulfilledQty).toBe(0);
  });

  it('实收为零不写库存流水；取消也不扣库存', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    const before = ws.events.count();
    await ws.tools.invoke('wms.order.transition', {
      orderNo: created.orderNo,
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 0 }],
    });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);
    expect(ws.orders.byNo(created.orderNo)!.state).toBe('received');
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.fulfilledQty).toBe(0);
    const added = ws.events.count() - before;
    expect(added).toBe(1);
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'canceled' });
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);
  });

  it('停用后不能改少，整单收货仍然按订单数量', async () => {
    disablePartial();
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.transition', {
        orderNo: created.orderNo,
        to: 'received',
        lines: [{ skuCode: 'A-1', quantity: 6 }],
      }),
    ).rejects.toThrow(PartialDisabledError);
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.byNo(created.orderNo)!.state).toBe('created');

    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'received' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
  });

  it('实发少于订单数量，取消按已发数量加回', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'picking' });
    allowDirectShip(ws);
    await ws.tools.invoke('wms.order.transition', {
      orderNo: created.orderNo,
      to: 'shipped',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(7);
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.fulfilledQty).toBe(-3);
    await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'canceled' });
    expect(ws.inventory.quantityOf(sku.id)).toBe(10);
  });

  it('实数大于订单数量被拒绝；不动库存的转移不能带实数', async () => {
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    await expect(
      ws.tools.invoke('wms.order.transition', {
        orderNo: created.orderNo,
        to: 'received',
        lines: [{ skuCode: 'A-1', quantity: 11 }],
      }),
    ).rejects.toThrow(PartialQtyExceededError);
    await expect(
      ws.tools.invoke('wms.order.transition', {
        orderNo: created.orderNo,
        to: 'canceled',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(PartialNotOnPostError);
    expect(ws.orders.byNo(created.orderNo)!.state).toBe('created');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(0);
  });
});
