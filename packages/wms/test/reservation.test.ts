import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { InsufficientStockError, StockReservedError, WmsDomain } from '../src/index.js';

/**
 * module.reservation：拣货占用可用量，物理库存仍在发货时扣。
 * 停用后新的拣货不再占用。已有占用保留到发货或取消。
 * 调整不看占用。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-reservation');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
});

afterEach(() => {
  core.close();
});

function disableReservation(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.reservation/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'reservation test');
  ws.profile.confirm(proposalId, 'user:tester');
}

async function outbound(quantity: number, orderNo?: string): Promise<string> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    ...(orderNo ? { orderNo } : {}),
    lines: [{ skuCode: 'A-1', quantity }],
  })) as { orderNo: string };
  return created.orderNo;
}

function skuId(): string {
  return ws.skus.byCode('A-1')!.id;
}

describe('module.reservation', () => {
  it('拣货占用可用量，其他出库单不能再拿走；发货后释放并扣实物', async () => {
    const a = await outbound(6, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    expect(ws.inventory.quantityOf(skuId())).toBe(10);
    expect(ws.inventory.reservedOfSku(skuId())).toBe(6);

    const b = await outbound(6, 'OUT-B');
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: b, to: 'picking' })).rejects.toThrow(
      StockReservedError,
    );
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.byNo(b)!.state).toBe('created');

    const small = await outbound(4, 'OUT-C');
    await ws.tools.invoke('wms.order.transition', { orderNo: small, to: 'picking' });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(10);

    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'shipped' });
    expect(ws.inventory.quantityOf(skuId())).toBe(4);
    expect(ws.inventory.listReservations(ws.orders.byNo(a)!.id)).toHaveLength(0);
    expect(ws.inventory.reservedOfSku(skuId())).toBe(4);

    await ws.tools.invoke('wms.order.transition', { orderNo: small, to: 'shipped' });
    expect(ws.inventory.quantityOf(skuId())).toBe(0);
    expect(ws.inventory.listReservations()).toHaveLength(0);
  });

  it('短发释放全部占用，未发的数量回到可用', async () => {
    const a = await outbound(10, 'OUT-SHORT');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: a,
      to: 'shipped',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    expect(ws.inventory.quantityOf(skuId())).toBe(7);
    expect(ws.inventory.reservedOfSku(skuId())).toBe(0);

    const b = await outbound(7, 'OUT-REST');
    await ws.tools.invoke('wms.order.transition', { orderNo: b, to: 'picking' });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(7);
  });

  it('取消拣货释放占用；冻结后再占用时，剩下的可用量不够就拒', async () => {
    const a = await outbound(6, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'canceled' });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(0);
    expect(ws.inventory.quantityOf(skuId())).toBe(10);

    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 4 });
    const again = await outbound(6, 'OUT-HELD');
    await ws.tools.invoke('wms.order.transition', { orderNo: again, to: 'picking' });
    const q = (await ws.tools.invoke('wms.inventory.query', { skuCode: 'A-1' })) as {
      reserved: number;
      available: number;
    };
    expect(q.reserved).toBe(6);
    expect(q.available).toBe(0);

    const other = await outbound(1, 'OUT-OTHER');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: other, to: 'picking' })).rejects.toThrow(
      StockReservedError,
    );
  });

  it('停用后新的拣货不再占用；停用前已占用的仍拦住别人，发货时照样释放', async () => {
    disableReservation();
    const a = await outbound(8, 'OUT-A');
    const b = await outbound(8, 'OUT-B');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: b, to: 'picking' });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(0);
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'shipped' });
    expect(ws.inventory.quantityOf(skuId())).toBe(2);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: b, to: 'shipped' })).rejects.toThrow(
      InsufficientStockError,
    );

    core.close();
    core = OneCore.open(':memory:');
    ws = WmsDomain.attach(core).workspace('ws-reservation-2');
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    const held = await outbound(8, 'OUT-HELD');
    await ws.tools.invoke('wms.order.transition', { orderNo: held, to: 'picking' });
    disableReservation();
    const late = await outbound(8, 'OUT-LATE');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: late, to: 'picking' })).rejects.toThrow(
      StockReservedError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: held, to: 'shipped' });
    expect(ws.inventory.quantityOf(skuId())).toBe(2);
    expect(ws.inventory.reservedOfSku(skuId())).toBe(0);
  });

  it('手工调整不看占用；实物被调走后，占用方发货按余量拒绝', async () => {
    const a = await outbound(6, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -5 });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(6);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'shipped' })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(ws.orders.byNo(a)!.state).toBe('picking');
    expect(ws.inventory.reservedOfSku(skuId())).toBe(6);
  });

  it('重放后占用还在；发货并再重放后占用消失', async () => {
    const a = await outbound(4, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    ws.replay();
    expect(ws.orders.byNo(a)!.state).toBe('picking');
    expect(ws.inventory.reservedOfSku(skuId())).toBe(4);

    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'shipped' });
    ws.replay();
    expect(ws.inventory.quantityOf(skuId())).toBe(6);
    expect(ws.inventory.listReservations()).toHaveLength(0);
  });

  it('拣货关单扣实物并释放占用', async () => {
    const a = await outbound(4, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    const created = (await ws.tools.invoke('wms.picking.create', { orderNos: [a] })) as { pickingNo: string };
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: created.pickingNo,
      orderNo: a,
      skuCode: 'A-1',
      pickedQty: 4,
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: created.pickingNo });
    expect(ws.orders.byNo(a)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(skuId())).toBe(6);
    expect(ws.inventory.listReservations()).toHaveLength(0);

    const b = await outbound(6, 'OUT-B');
    await ws.tools.invoke('wms.order.transition', { orderNo: b, to: 'picking' });
    expect(ws.inventory.reservedOfSku(skuId())).toBe(6);
  });

  it('收货被占用时不能冲销；占用释放后可以', async () => {
    const inbound = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'received' });
    // 期初 10 + 收货 10。出库占的是默认桶上的 10，冲销收货要扣这 10。
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -10, reason: '去掉期初' });
    expect(ws.inventory.quantityOf(skuId())).toBe(10);

    const a = await outbound(10, 'OUT-A');
    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'picking' });
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'canceled' }),
    ).rejects.toThrow(StockReservedError);
    expect(ws.orders.byNo(inbound.orderNo)!.state).toBe('received');
    expect(ws.inventory.quantityOf(skuId())).toBe(10);

    await ws.tools.invoke('wms.order.transition', { orderNo: a, to: 'canceled' });
    await ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'canceled' });
    expect(ws.inventory.quantityOf(skuId())).toBe(0);
    expect(ws.inventory.listReservations()).toHaveLength(0);
  });
});
