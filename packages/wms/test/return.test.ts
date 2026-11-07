import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  getReturnable,
  DEFAULT_LOCATION_ID,
  InsufficientStockError,
  listOrdersWithLines,
  OrderNotFoundError,
  ReturnAllocationError,
  ReturnDirectionError,
  ReturnDisabledError,
  ReturnLineNotFoundError,
  ReturnNotPostedError,
  ReturnOfReturnError,
  ReturnQtyExceededError,
  WmsDomain,
} from '../src/index.js';

/**
 * module.return：客退是入库单，退供是出库单。不新增状态。
 * 额度按 SKU + 批次，库位可以换。停用后不能再带原单号开单，已开的单仍可流转。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-return');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'C-03', name: '三号架' });
});

afterEach(() => {
  core.close();
});

function disableReturn(): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.return/enabled', value: false }];
  const { proposalId } = ws.profile.propose('user:tester', patch, 'return test');
  ws.profile.confirm(proposalId, 'user:tester');
}

function qty(skuCode: string, locationCode = 'DEFAULT', batchNo = 'DEFAULT'): number {
  const sku = ws.skus.byCode(skuCode)!;
  // DEFAULT 是虚拟库位，不落库位表。
  const locationId =
    locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(sku.id, locationId, batchNo);
}

async function receiveIn(
  orderNo: string,
  lines: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string; batchExpiryDate?: string }[],
  postLines?: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[],
): Promise<void> {
  await ws.tools.invoke('wms.order.create', { direction: 'in', orderNo, lines });
  await ws.tools.invoke('wms.order.transition', {
    orderNo,
    to: 'received',
    ...(postLines ? { lines: postLines } : {}),
  });
}

async function shipOut(
  orderNo: string,
  lines: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[],
  postLines?: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[],
): Promise<void> {
  await ws.tools.invoke('wms.order.create', { direction: 'out', orderNo, lines });
  await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
  await ws.tools.invoke('wms.order.transition', {
    orderNo,
    to: 'shipped',
    ...(postLines ? { lines: postLines } : {}),
  });
}

describe('module.return', () => {
  it('客退收货加库存；超过剩余可退被拒绝', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 10 }]);
    expect(qty('A-1')).toBe(10);
    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 10 }]);
    expect(qty('A-1')).toBe(0);

    const view = getReturnable(ws, 'OUT-1');
    expect(view).toMatchObject({
      sourceOrderNo: 'OUT-1',
      sourceDirection: 'out',
      direction: 'in',
    });
    expect(view.lines[0]).toMatchObject({ skuCode: 'A-1', batchNo: 'DEFAULT', postedQty: 10, remaining: 10 });

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 4 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-1', to: 'received' });
    expect(qty('A-1')).toBe(4);
    expect(listOrdersWithLines(ws).find((o) => o.orderNo === 'RT-1')!.returnOfOrderNo).toBe('OUT-1');

    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 7 }],
      }),
    ).rejects.toThrow(ReturnQtyExceededError);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-2',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    expect(getReturnable(ws, 'OUT-1').lines[0]!.remaining).toBe(0);
  });

  it('停用后带原单号被拒绝且不落事件；不带原单号仍可开单', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 5 }]);
    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 5 }]);
    disableReturn();
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnDisabledError);
    expect(ws.events.count()).toBe(before);
    expect(() => getReturnable(ws, 'OUT-1')).toThrow(ReturnDisabledError);
  });

  it('停用后不带原单号的出入库不受影响', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 2 }]);
    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 2 }]);
    disableReturn();
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    expect(ws.orders.byNo(created.orderNo)!.returnOfOrderId).toBeNull();
    expect(ws.orders.byNo(created.orderNo)!.state).toBe('created');
  });

  it('退供发货扣库存；原单未收货、库位没货、超额都被拦住', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 10, locationCode: 'A-01' }],
    });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        returnOf: 'IN-1',
        lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'A-01' }],
      }),
    ).rejects.toThrow(ReturnNotPostedError);

    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-1', to: 'received' });
    expect(qty('A-1', 'A-01')).toBe(10);

    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'RT-EMPTY',
      returnOf: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: 'RT-EMPTY', to: 'picking' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.byNo('RT-EMPTY')!.state).toBe('created');

    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'RT-1',
      returnOf: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 3, locationCode: 'A-01' }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-1', to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-1', to: 'shipped' });
    expect(qty('A-1', 'A-01')).toBe(7);

    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        returnOf: 'IN-1',
        lines: [{ skuCode: 'A-1', quantity: 8, locationCode: 'A-01' }],
      }),
    ).rejects.toThrow(ReturnQtyExceededError);

    // 未拣成的退货仍占着订单数量；取消后释放。短发按实发（出库净量是负数）占额度。
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-EMPTY', to: 'canceled' });
    expect(getReturnable(ws, 'IN-1').lines[0]!.remaining).toBe(7);
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'RT-PART',
      returnOf: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 4, locationCode: 'A-01' }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-PART', to: 'picking' });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: 'RT-PART',
      to: 'shipped',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'A-01' }],
    });
    expect(qty('A-1', 'A-01')).toBe(6);
    expect(getReturnable(ws, 'IN-1').lines[0]!.remaining).toBe(6);
  });

  it('方向不对、原单不存在、退货单再退、未发货、带 allocation 都拒绝', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 6 }]);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'IN-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnDirectionError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        returnOf: 'MISSING',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(OrderNotFoundError);

    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 4 }]);
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-OPEN',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-OPEN',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnNotPostedError);
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-OPEN', to: 'picking' });
    expect(() => getReturnable(ws, 'OUT-OPEN')).toThrow(ReturnNotPostedError);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        returnOf: 'RT-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnOfReturnError);
    expect(() => getReturnable(ws, 'RT-1')).toThrow(ReturnOfReturnError);

    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        allocation: 'fefo',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnAllocationError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        returnOf: 'IN-1',
        allocation: 'fifo',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnAllocationError);
  });

  it('短发后只能退实发；未入账的退货按订单数量占用，取消后释放', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 10 }]);
    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 10 }], [{ skuCode: 'A-1', quantity: 6 }]);
    const view = getReturnable(ws, 'OUT-1');
    expect(view.lines[0]).toMatchObject({ postedQty: 6, remaining: 6 });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 7 }],
      }),
    ).rejects.toThrow(ReturnQtyExceededError);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-OPEN',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 4 }],
    });
    expect(getReturnable(ws, 'OUT-1').lines[0]!.remaining).toBe(2);
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-OPEN', to: 'canceled' });
    expect(getReturnable(ws, 'OUT-1').lines[0]!.remaining).toBe(6);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-SHORT',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: 'RT-SHORT',
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 2 }],
    });
    expect(getReturnable(ws, 'OUT-1').lines[0]!.remaining).toBe(4);
    expect(qty('A-1')).toBe(6);
  });

  it('库位可以和原单不同；批次必须对上；建议库位取入账最多的那一行', async () => {
    await receiveIn('IN-1', [
      { skuCode: 'A-1', quantity: 4, locationCode: 'A-01', batchNo: 'LOT-1', batchExpiryDate: '2027-06-01' },
      { skuCode: 'A-1', quantity: 6, locationCode: 'B-02', batchNo: 'LOT-1' },
    ]);
    await shipOut('OUT-1', [
      { skuCode: 'A-1', quantity: 4, locationCode: 'A-01', batchNo: 'LOT-1' },
      { skuCode: 'A-1', quantity: 6, locationCode: 'B-02', batchNo: 'LOT-1' },
    ]);
    const view = getReturnable(ws, 'OUT-1');
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({
      batchNo: 'LOT-1',
      locationCode: 'B-02',
      batchExpiryDate: '2027-06-01',
      postedQty: 10,
      remaining: 10,
    });

    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 1, batchNo: 'LOT-2' }],
      }),
    ).rejects.toThrow(ReturnLineNotFoundError);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [
        {
          skuCode: 'A-1',
          quantity: 3,
          locationCode: 'C-03',
          batchNo: 'LOT-1',
          batchExpiryDate: '2027-06-01',
        },
      ],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-1', to: 'received' });
    expect(qty('A-1', 'C-03', 'LOT-1')).toBe(3);
    expect(qty('A-1', 'B-02', 'LOT-1')).toBe(0);
    const line = ws.orders.lines(ws.orders.byNo('RT-1')!.id)[0]!;
    expect(line.batchExpiryDate).toBe('2027-06-01');
  });

  it('停用后已开出的退货单仍可收货；重放后原单 id 还在', async () => {
    await receiveIn('IN-1', [{ skuCode: 'A-1', quantity: 8 }]);
    await shipOut('OUT-1', [{ skuCode: 'A-1', quantity: 8 }]);
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    const sourceId = ws.orders.byNo('OUT-1')!.id;
    disableReturn();
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-1', to: 'received' });
    expect(qty('A-1')).toBe(3);
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnDisabledError);
    expect(ws.events.count()).toBe(before);

    ws.replay();
    expect(ws.orders.byNo('RT-1')!.returnOfOrderId).toBe(sourceId);
    expect(qty('A-1')).toBe(3);
  });
});
