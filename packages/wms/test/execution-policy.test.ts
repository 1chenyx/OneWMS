import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
  getReturnable,
  InsufficientStockError,
  PickingIncompleteError,
  PickingStillOpenError,
  PickingSubstitutionError,
  PutawayCapacityError,
  ReturnLineNotFoundError,
  SerialStockError,
  StockReservedError,
  WmsDomain,
} from '../src/index.js';

/**
 * 承诺、建议、实绩。
 * 没填的批次和库位是不限。写了的缺省建议，单据可以改成锁定。
 * 退货和序列号锁定批次。上架只搬库位。没点过的行不能靠关单短发。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-exec');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
});

afterEach(() => {
  core.close();
});

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

function setPath(path: string, value: unknown): void {
  const patch: PatchOp[] = [{ op: 'replace', path, value }];
  const { proposalId } = ws.profile.propose('user:tester', patch, '执行规则');
  ws.profile.confirm(proposalId, 'user:tester');
}

function locationId(code: string): string {
  return code === 'DEFAULT' ? DEFAULT_LOCATION_ID : ws.locations.byCode(code)!.id;
}

function qty(locationCode: string, batchNo = DEFAULT_BATCH_NO): number {
  return ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, locationId(locationCode), batchNo);
}

async function putStock(locationCode: string, batchNo: string, quantity: number): Promise<void> {
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: quantity,
    locationCode,
    batchNo,
    reason: '期初',
  });
}

async function outbound(input: {
  orderNo: string;
  quantity: number;
  locationCode?: string;
  batchNo?: string;
  batchConstraint?: 'prefer' | 'lock';
  locationConstraint?: 'prefer' | 'lock';
  returnOf?: string;
}): Promise<void> {
  await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    orderNo: input.orderNo,
    ...(input.returnOf ? { returnOf: input.returnOf } : {}),
    ...(input.batchConstraint ? { batchConstraint: input.batchConstraint } : {}),
    ...(input.locationConstraint ? { locationConstraint: input.locationConstraint } : {}),
    lines: [
      {
        skuCode: 'A-1',
        quantity: input.quantity,
        ...(input.locationCode ? { locationCode: input.locationCode } : {}),
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
      },
    ],
  });
  await ws.tools.invoke('wms.order.transition', { orderNo: input.orderNo, to: 'picking' });
}

async function openPicking(orderNo: string): Promise<string> {
  const created = (await ws.tools.invoke('wms.picking.create', { orderNos: [orderNo] })) as { pickingNo: string };
  return created.pickingNo;
}

describe('拣货改桶', () => {
  it('写了批次缺省是建议：可以改拣，退货认实绩批次', async () => {
    await putStock('A-01', 'B-PLAN', 4);
    await putStock('A-01', 'B-ACT', 4);
    await outbound({ orderNo: 'OUT-1', quantity: 4, locationCode: 'A-01', batchNo: 'B-PLAN' });
    expect(ws.orders.byNo('OUT-1')!.batchConstraint).toBe('prefer');
    const pickingNo = await openPicking('OUT-1');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-PLAN',
      pickedQty: 4,
      pickedBatchNo: 'B-ACT',
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo });
    expect(qty('A-01', 'B-PLAN')).toBe(4);
    expect(qty('A-01', 'B-ACT')).toBe(0);
    const returnable = getReturnable(ws, 'OUT-1').lines.map((line) => line.batchNo);
    expect(returnable).toEqual(['B-ACT']);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 4, batchNo: 'B-PLAN', locationCode: 'A-01' }],
      }),
    ).rejects.toThrow(ReturnLineNotFoundError);
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 4, batchNo: 'B-ACT', locationCode: 'B-02' }],
    })) as { orderNo: string };
    expect(created.orderNo).toBeTruthy();
  });

  it('批次锁定拒绝改拣，事件数不变', async () => {
    await putStock('A-01', 'B-1', 4);
    await putStock('A-01', 'B-2', 4);
    await outbound({
      orderNo: 'OUT-1',
      quantity: 4,
      locationCode: 'A-01',
      batchNo: 'B-1',
      batchConstraint: 'lock',
    });
    expect(ws.orders.byNo('OUT-1')!.batchConstraint).toBe('lock');
    const pickingNo = await openPicking('OUT-1');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: 'OUT-1',
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 4,
        pickedBatchNo: 'B-2',
      }),
    ).rejects.toThrow(PickingSubstitutionError);
    expect(countEvents()).toBe(before);
  });

  it('没填批次时，即使单据锁定，改拣仍然允许', async () => {
    await putStock('A-01', 'DEFAULT', 4);
    await putStock('A-01', 'B-2', 4);
    await outbound({ orderNo: 'OUT-1', quantity: 4, locationCode: 'A-01', batchConstraint: 'lock' });
    const pickingNo = await openPicking('OUT-1');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      pickedQty: 4,
      pickedBatchNo: 'B-2',
    });
    expect(qty('A-01', 'B-2')).toBe(4);
  });

  it('库位锁定拒绝换库位；没填库位时仍可换', async () => {
    await putStock('A-01', 'B-1', 4);
    await putStock('DEFAULT', 'B-1', 4);
    await putStock('B-02', 'B-1', 4);
    await outbound({
      orderNo: 'OUT-LOCK',
      quantity: 4,
      locationCode: 'A-01',
      batchNo: 'B-1',
      locationConstraint: 'lock',
    });
    const locked = await openPicking('OUT-LOCK');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo: locked,
        orderNo: 'OUT-LOCK',
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 4,
        locationCode: 'B-02',
      }),
    ).rejects.toThrow(PickingSubstitutionError);
    expect(countEvents()).toBe(before);

    await outbound({ orderNo: 'OUT-OPEN', quantity: 4, batchNo: 'B-1', locationConstraint: 'lock' });
    const open = await openPicking('OUT-OPEN');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: open,
      orderNo: 'OUT-OPEN',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 4,
      locationCode: 'B-02',
    });
  });

  it('一行拆成两桶，关单两边都扣，退货能看到两个批次', async () => {
    await putStock('DEFAULT', 'DEFAULT', 10);
    await putStock('A-01', 'B-1', 4);
    await putStock('B-02', 'B-2', 6);
    await outbound({ orderNo: 'OUT-1', quantity: 10 });
    const pickingNo = await openPicking('OUT-1');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      pickedQty: 10,
      allocations: [
        { locationCode: 'A-01', batchNo: 'B-1', quantity: 4 },
        { locationCode: 'B-02', batchNo: 'B-2', quantity: 6 },
      ],
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo });
    expect(qty('A-01', 'B-1')).toBe(0);
    expect(qty('B-02', 'B-2')).toBe(0);
    expect(getReturnable(ws, 'OUT-1').lines.map((line) => [line.batchNo, line.remaining]).sort()).toEqual([
      ['B-1', 4],
      ['B-2', 6],
    ]);
  });
});

describe('未关拣货单挡住直接发货', () => {
  it('有拣货单时直接发货被拒绝；取消拣货单后可以发', async () => {
    await putStock('A-01', 'B-1', 4);
    await outbound({ orderNo: 'OUT-1', quantity: 4, locationCode: 'A-01', batchNo: 'B-1' });
    const pickingNo = await openPicking('OUT-1');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'shipped' })).rejects.toThrow(
      PickingStillOpenError,
    );
    expect(ws.orders.byNo('OUT-1')!.state).toBe('picking');
    expect(qty('A-01', 'B-1')).toBe(4);
    await ws.tools.invoke('wms.picking.cancel', { pickingNo });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'shipped' });
    expect(ws.orders.byNo('OUT-1')!.state).toBe('shipped');
    expect(qty('A-01', 'B-1')).toBe(0);
  });
});

describe('短发', () => {
  it('开了短发：录入过的短拣可以关，没点过的行不能关成 0，明确拣 0 可以关', async () => {
    await putStock('A-01', 'B-1', 15);
    await outbound({ orderNo: 'OUT-SHORT', quantity: 5, locationCode: 'A-01', batchNo: 'B-1' });
    const shortNo = await openPicking('OUT-SHORT');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: shortNo,
      orderNo: 'OUT-SHORT',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 2,
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: shortNo });
    expect(ws.orders.byNo('OUT-SHORT')!.state).toBe('shipped');
    expect(ws.orders.lines(ws.orders.byNo('OUT-SHORT')!.id)[0]!.fulfilledQty).toBe(-2);
    expect(getReturnable(ws, 'OUT-SHORT').lines[0]!.remaining).toBe(2);
    expect(qty('A-01', 'B-1')).toBe(13);

    await outbound({ orderNo: 'OUT-IDLE', quantity: 5, locationCode: 'A-01', batchNo: 'B-1' });
    const idleNo = await openPicking('OUT-IDLE');
    await expect(ws.tools.invoke('wms.picking.close', { pickingNo: idleNo })).rejects.toThrow(PickingIncompleteError);
    expect(ws.orders.byNo('OUT-IDLE')!.state).toBe('picking');

    await outbound({ orderNo: 'OUT-ZERO', quantity: 5, locationCode: 'A-01', batchNo: 'B-1' });
    const zeroNo = await openPicking('OUT-ZERO');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: zeroNo,
      orderNo: 'OUT-ZERO',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 0,
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: zeroNo });
    expect(ws.orders.lines(ws.orders.byNo('OUT-ZERO')!.id)[0]!.fulfilledQty).toBe(0);
    expect(qty('A-01', 'B-1')).toBe(13);
  });

  it('关掉短发后，已经录入的短拣也不能关', async () => {
    await putStock('A-01', 'B-1', 5);
    await outbound({ orderNo: 'OUT-1', quantity: 5, locationCode: 'A-01', batchNo: 'B-1' });
    const pickingNo = await openPicking('OUT-1');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 2,
    });
    setPath('/modules/module.partial/enabled', false);
    await expect(ws.tools.invoke('wms.picking.close', { pickingNo })).rejects.toThrow(PickingIncompleteError);
    expect(ws.orders.byNo('OUT-1')!.state).toBe('picking');
    expect(qty('A-01', 'B-1')).toBe(5);
  });
});

describe('占用跟着实拣桶', () => {
  it('改拣之后占用挪到实绩桶，别人拿不走实绩桶，可以拿回承诺桶', async () => {
    await putStock('A-01', 'B-PLAN', 10);
    await putStock('A-01', 'B-ACT', 10);
    await outbound({ orderNo: 'OUT-1', quantity: 10, locationCode: 'A-01', batchNo: 'B-PLAN' });
    const pickingNo = await openPicking('OUT-1');
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      suggestedBatchNo: 'B-PLAN',
      pickedQty: 10,
      pickedBatchNo: 'B-ACT',
    });
    expect(ws.inventory.listReservations(ws.orders.byNo('OUT-1')!.id).map((row) => row.batchNo)).toEqual(['B-ACT']);
    await expect(
      outbound({ orderNo: 'OUT-ACT', quantity: 1, locationCode: 'A-01', batchNo: 'B-ACT' }),
    ).rejects.toThrow(StockReservedError);
    await outbound({ orderNo: 'OUT-PLAN', quantity: 1, locationCode: 'A-01', batchNo: 'B-PLAN' });
    expect(ws.orders.byNo('OUT-PLAN')!.state).toBe('picking');
  });
});

describe('退货和序列号锁定', () => {
  it('退货单不能改批次', async () => {
    await putStock('A-01', 'B-1', 4);
    const inbound = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 4, locationCode: 'A-01', batchNo: 'B-1' }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'received' });
    await outbound({
      orderNo: 'RT-1',
      quantity: 4,
      locationCode: 'A-01',
      batchNo: 'B-1',
      returnOf: inbound.orderNo,
    });
    expect(ws.orders.byNo('RT-1')!.batchConstraint).toBe('lock');
    const pickingNo = await openPicking('RT-1');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: 'RT-1',
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 4,
        pickedBatchNo: 'B-2',
      }),
    ).rejects.toThrow(/退货单的批次已锁定/);
    expect(countEvents()).toBe(before);
  });

  it('序列号商品改桶在录入时拒绝，并说明必须从指定桶拣出', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', serialTracked: true });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      locationCode: 'A-01',
      batchNo: 'B-1',
      serials: ['S-1'],
      reason: '期初',
    });
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'A-01', batchNo: 'B-1', serials: ['S-1'] }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'picking' });
    const pickingNo = await openPicking('OUT-1');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: 'OUT-1',
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 1,
        locationCode: 'B-02',
      }),
    ).rejects.toThrow(SerialStockError);
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: 'OUT-1',
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 1,
        locationCode: 'B-02',
      }),
    ).rejects.toThrow(/序列号必须从单据指定的库位批次拣出: A-1/);
    expect(countEvents()).toBe(before);
  });
});

describe('上架库容', () => {
  async function received(orderNo: string, quantity: number): Promise<void> {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo,
      lines: [{ skuCode: 'A-1', quantity }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'received' });
  }

  it('block 放不下就拒绝，货留在收货库位；warn 放行并提示；off 和不填容量都不拦', async () => {
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '一号架', capacity: 10 });
    await received('IN-BLOCK', 12);
    setPath('/modules/core.wms/settings/putawayCapacity', 'block');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo: 'IN-BLOCK',
        targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
      }),
    ).rejects.toThrow(PutawayCapacityError);
    expect(countEvents()).toBe(before);
    expect(ws.orders.byNo('IN-BLOCK')!.state).toBe('received');
    expect(qty('DEFAULT')).toBe(12);

    setPath('/modules/core.wms/settings/putawayCapacity', 'off');
    const off = (await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-BLOCK',
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    })) as { warning?: string };
    expect(off.warning).toBeUndefined();
    expect(ws.orders.byNo('IN-BLOCK')!.state).toBe('putaway');
    expect(qty('A-01')).toBe(12);

    await received('IN-WARN', 12);
    setPath('/modules/core.wms/settings/putawayCapacity', 'warn');
    const warned = (await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-WARN',
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    })) as { warning?: string };
    expect(warned.warning).toContain('库位 A-01 容量 10');
    expect(ws.orders.byNo('IN-WARN')!.state).toBe('putaway');

    await received('IN-FREE', 12);
    setPath('/modules/core.wms/settings/putawayCapacity', 'block');
    const free = (await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-FREE',
      targets: [{ skuCode: 'A-1', toLocationCode: 'B-02' }],
    })) as { warning?: string };
    expect(free.warning).toBeUndefined();
    expect(ws.orders.byNo('IN-FREE')!.state).toBe('putaway');
    expect(qty('B-02')).toBe(12);
  });
});

describe('占用桶上的调整', () => {
  it('调走占用桶照常记账并提示，之后发货按余量拒绝', async () => {
    await putStock('A-01', 'B-1', 10);
    await outbound({ orderNo: 'OUT-1', quantity: 10, locationCode: 'A-01', batchNo: 'B-1' });
    const adjusted = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -10,
      locationCode: 'A-01',
      batchNo: 'B-1',
      reason: '盘亏',
    })) as { warning?: string };
    expect(adjusted.warning).toContain('出库单 OUT-1 占用着');
    expect(qty('A-01', 'B-1')).toBe(0);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'shipped' })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(ws.orders.byNo('OUT-1')!.state).toBe('picking');
  });
});
