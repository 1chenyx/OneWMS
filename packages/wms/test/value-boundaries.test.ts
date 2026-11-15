import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  getReplenishment,
  getReturnable,
  HoldExceedsStockError,
  InsufficientStockError,
  LpnPackedError,
  PartialQtyExceededError,
  PickingOverPickError,
  PutawayCapacityError,
  ReturnQtyExceededError,
  WmsDomain,
} from '../src/index.js';

/**
 * 数量和参数的边界。
 * 整数清零、冻结全额、短收超额、超拣、临期 30 天、分页翻页已经在各模块用例里。
 * 这里只钉 3 位小数的步长、刚好满和多 0.001，以及 schema 上下限。
 * 第 4 位小数用 4 和 6，不把恰好 5 的舍入方向写死。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-bounds');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
});

afterEach(() => {
  core.close();
});

function qty(locationCode = 'DEFAULT'): number {
  const locationId = locationCode === 'DEFAULT' ? 'DEFAULT' : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, locationId, 'DEFAULT');
}

function setEnabled(moduleId: string, enabled: boolean): void {
  const patch: PatchOp[] = [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value: enabled }];
  const { proposalId } = ws.profile.propose('user:tester', patch, `${moduleId} ${enabled}`);
  ws.profile.confirm(proposalId, 'user:tester');
}

function setPath(path: string, value: unknown): void {
  const { proposalId } = ws.profile.propose('user:tester', [{ op: 'replace', path, value }], '边界');
  ws.profile.confirm(proposalId, 'user:tester');
}

function dateOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

describe('数量精度', () => {
  it('小于半个千分位的调整拒绝且零事件；收到 3 位；刚好扣完后再多 0.001 拒绝', async () => {
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 0.0004 })).rejects.toThrow(
      /量化后为 0/,
    );
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -0.0004 })).rejects.toThrow(
      /量化后为 0/,
    );
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: Number.NaN })).rejects.toThrow(
      /必须是 number/,
    );
    expect(ws.events.count()).toBe(before);

    const added = (await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 0.0006 })) as {
      quantity: number;
    };
    expect(added.quantity).toBe(0.001);
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -0.001 });
    const rounded = (await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.2346 })) as {
      quantity: number;
    };
    expect(rounded.quantity).toBe(1.235);

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1.235 });
    expect(qty()).toBe(0);
    const over = ws.events.count();
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -0.001 })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(ws.events.count()).toBe(over);
  });

  it('调整、移库、冻结、安全库存和临期天数卡在声明的上下限', async () => {
    const top = (await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1000000000 })) as {
      quantity: number;
    };
    expect(top.quantity).toBe(1000000000);
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1000000000.001 }),
    ).rejects.toThrow('不能大于 1000000000');
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1000000000.001 }),
    ).rejects.toThrow('不能小于 -1000000000');
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow('不能大于 1000000000');
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1000000000 });
    expect(qty()).toBe(0);

    await expect(
      ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 0.0009 }),
    ).rejects.toThrow('不能小于 0.001');
    await expect(
      ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 1000000000.001 }),
    ).rejects.toThrow('不能大于 1000000000');
    await expect(ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 0.0004 })).rejects.toThrow(
      '不能小于 0.001',
    );

    const capped = (await ws.tools.invoke('wms.sku.create', {
      skuCode: 'CAP',
      name: '上限',
      reorderPoint: 1000000000,
    })) as { reorderPoint: number };
    expect(capped.reorderPoint).toBe(1000000000);
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'OVER', name: '越界', reorderPoint: 1000000001 }),
    ).rejects.toThrow('不能大于 1000000000');
    await expect(ws.tools.invoke('wms.sku.create', { skuCode: 'HALF', name: '小数', reorderPoint: 1.5 })).rejects.toThrow(
      '必须是 integer',
    );

    await expect(ws.tools.invoke('wms.inventory.expiring', { days: -1 })).rejects.toThrow('不能小于 0');
    await expect(ws.tools.invoke('wms.inventory.expiring', { days: 3651 })).rejects.toThrow('不能大于 3650');
    await expect(ws.tools.invoke('wms.inventory.expiring', { days: 1.5 })).rejects.toThrow('必须是 integer');
    await expect(ws.tools.invoke('wms.inventory.expiring', { days: 0 })).resolves.toEqual([]);
    await expect(ws.tools.invoke('wms.inventory.expiring', { days: 3650 })).resolves.toEqual([]);
  });

  it('单据行收到 3 位；刚好发完；多 0.001 不建单', async () => {
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', { direction: 'in', lines: [{ skuCode: 'A-1', quantity: 0.0004 }] }),
    ).rejects.toThrow(/量化后为 0/);
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.list('in')).toHaveLength(0);

    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-Q',
      lines: [{ skuCode: 'A-1', quantity: 1.2344 }],
    })) as { orderNo: string };
    expect(ws.orders.lines(ws.orders.byNo(created.orderNo)!.id)[0]!.quantity).toBe(1.234);
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-Q', to: 'received' });
    expect(qty()).toBe(1.234);

    setEnabled('module.picking', false);
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-EXACT',
      lines: [{ skuCode: 'A-1', quantity: 1.234 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-EXACT', to: 'shipped' });
    expect(qty()).toBe(0);
    const blocked = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 0.001 }],
      }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.events.count()).toBe(blocked);
    expect(ws.orders.byNo('OUT-EXACT')!.state).toBe('shipped');
  });
});

describe('刚好满与多一个千分位', () => {
  it('实收多 0.001 拒绝；少 0.001 记下实收；写上相同数量按整单入账', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-OVER',
      lines: [{ skuCode: 'A-1', quantity: 1.002 }],
    });
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.transition', {
        orderNo: 'IN-OVER',
        to: 'received',
        lines: [{ skuCode: 'A-1', quantity: 1.003 }],
      }),
    ).rejects.toThrow(PartialQtyExceededError);
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.byNo('IN-OVER')!.state).toBe('created');
    expect(qty()).toBe(0);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-SHORT',
      lines: [{ skuCode: 'A-1', quantity: 1.002 }],
    });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: 'IN-SHORT',
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 1.001 }],
    });
    expect(qty()).toBe(1.001);
    expect(ws.orders.lines(ws.orders.byNo('IN-SHORT')!.id)[0]).toMatchObject({
      quantity: 1.002,
      fulfilledQty: 1.001,
    });

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-SAME',
      lines: [{ skuCode: 'A-1', quantity: 1.002 }],
    });
    await ws.tools.invoke('wms.order.transition', {
      orderNo: 'IN-SAME',
      to: 'received',
      lines: [{ skuCode: 'A-1', quantity: 1.002 }],
    });
    expect(ws.orders.lines(ws.orders.byNo('IN-SAME')!.id)[0]!.fulfilledQty).toBeNull();
    expect(qty()).toBeCloseTo(2.003, 3);
  });

  it('冻结刚好占满后再冻 0.001 拒绝', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.001 });
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 1.002 })).rejects.toThrow(
      HoldExceedsStockError,
    );
    expect(ws.events.count()).toBe(before);

    const held = (await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 1.001 })) as {
      available: number;
    };
    expect(held.available).toBeCloseTo(0, 3);
    await expect(ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 0.001 })).rejects.toThrow(
      HoldExceedsStockError,
    );
    expect(qty()).toBe(1.001);
  });

  it('移库刚好搬空；再搬 0.001 拒绝', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.001 });
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 1.002 }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 1.001 });
    expect(qty()).toBe(0);
    expect(qty('A-01')).toBe(1.001);
    await expect(
      ws.tools.invoke('wms.inventory.move', { skuCode: 'A-1', toLocationCode: 'A-01', quantity: 0.001 }),
    ).rejects.toThrow(InsufficientStockError);
  });

  it('装托刚好装完；再装或卸多 0.001 拒绝，库存不变', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.001, locationCode: 'A-01' });
    await ws.tools.invoke('wms.lpn.create', { lpnCode: 'P-1', locationCode: 'A-01' });
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 1.002 }),
    ).rejects.toThrow(LpnPackedError);
    expect(ws.events.count()).toBe(before);

    const packed = (await ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 1.001 })) as {
      quantity: number;
    };
    expect(packed.quantity).toBe(1.001);
    await expect(ws.tools.invoke('wms.lpn.pack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 0.001 })).rejects.toThrow(
      LpnPackedError,
    );
    const unpacked = (await ws.tools.invoke('wms.lpn.unpack', {
      lpnCode: 'P-1',
      skuCode: 'A-1',
      quantity: 1.001,
    })) as { quantity: number };
    expect(unpacked.quantity).toBe(0);
    await expect(
      ws.tools.invoke('wms.lpn.unpack', { lpnCode: 'P-1', skuCode: 'A-1', quantity: 0.001 }),
    ).rejects.toThrow(LpnPackedError);
    expect(qty('A-01')).toBe(1.001);
  });

  it('上架刚好放到容量；再放 0.001 拒绝；0 和负数不能当容量，清空后不再拦', async () => {
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.location.create', { locationCode: 'CAP-0', capacity: 0 })).rejects.toThrow(
      /容量必须是正数/,
    );
    await expect(ws.tools.invoke('wms.location.create', { locationCode: 'CAP-NEG', capacity: -1 })).rejects.toThrow(
      /容量必须是正数/,
    );
    expect(ws.events.count()).toBe(before);
    expect(ws.locations.byCode('CAP-0')).toBeUndefined();

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', capacity: 10 });
    setPath('/modules/core.wms/settings/putawayCapacity', 'block');
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-FIT',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-FIT', to: 'received' });
    await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-FIT',
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    });
    expect(ws.orders.byNo('IN-FIT')!.state).toBe('putaway');
    expect(qty('A-01')).toBe(10);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-MORE',
      lines: [{ skuCode: 'A-1', quantity: 0.001 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-MORE', to: 'received' });
    const blocked = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo: 'IN-MORE',
        targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
      }),
    ).rejects.toThrow(PutawayCapacityError);
    expect(ws.events.count()).toBe(blocked);
    expect(ws.orders.byNo('IN-MORE')!.state).toBe('received');
    expect(qty('A-01')).toBe(10);

    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', capacity: null });
    expect(ws.locations.byCode('A-01')!.capacity).toBeNull();
    await ws.tools.invoke('wms.order.putaway', {
      orderNo: 'IN-MORE',
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    });
    expect(qty('A-01')).toBeCloseTo(10.001, 3);
  });

  it('可用量刚好等于安全库存不预警也不补；少 0.001 两边都出现', async () => {
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    expect(await ws.tools.invoke('wms.inventory.lowstock', {})).toEqual([]);
    expect(getReplenishment(ws).find((row) => row.skuCode === 'A-1')).toBeUndefined();

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -0.001 });
    const low = (await ws.tools.invoke('wms.inventory.lowstock', {})) as { skuCode: string; shortage: number }[];
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ skuCode: 'A-1' });
    expect(low[0]!.shortage).toBeCloseTo(0.001, 3);
    expect(getReplenishment(ws).find((row) => row.skuCode === 'A-1')?.suggestedQty).toBe(0.001);
  });

  it('临期天数含当天、不含再往后的一天', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      batchNo: 'YDAY',
      batchExpiryDate: dateOffset(-1),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      batchNo: 'TODAY',
      batchExpiryDate: dateOffset(0),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      batchNo: 'TMR',
      batchExpiryDate: dateOffset(1),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      batchNo: 'LATER',
      batchExpiryDate: dateOffset(2),
    });

    const today = (await ws.tools.invoke('wms.inventory.expiring', { days: 0 })) as { batchNo: string }[];
    expect(today.map((row) => row.batchNo)).toEqual(['YDAY', 'TODAY']);
    const tomorrow = (await ws.tools.invoke('wms.inventory.expiring', { days: 1 })) as { batchNo: string }[];
    expect(tomorrow.map((row) => row.batchNo)).toEqual(['YDAY', 'TODAY', 'TMR']);
  });

  it('流水分页：1 和 200 合法，0、201 和负偏移拒绝', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1 });
    const page = (await ws.tools.invoke('wms.ledger.query', { limit: 1, offset: 0 })) as {
      total: number;
      limit: number;
      hasMore: boolean;
    };
    expect(page).toMatchObject({ total: 2, limit: 1, hasMore: true });
    const wide = (await ws.tools.invoke('wms.ledger.query', { limit: 200 })) as { limit: number; hasMore: boolean };
    expect(wide).toMatchObject({ limit: 200, hasMore: false });
    await expect(ws.tools.invoke('wms.ledger.query', { limit: 0 })).rejects.toThrow('不能小于 1');
    await expect(ws.tools.invoke('wms.ledger.query', { limit: 201 })).rejects.toThrow('不能大于 200');
    await expect(ws.tools.invoke('wms.ledger.query', { offset: -1 })).rejects.toThrow('不能小于 0');
    await expect(ws.tools.invoke('wms.order.query', { limit: 201 })).rejects.toThrow('不能大于 200');
  });

  it('实盘四舍到账面则零差异不落流水；多一个千分位才调', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1 });
    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-FLAT' });
    const flat = (await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-FLAT',
      skuCode: 'A-1',
      countedQty: 1.0004,
    })) as { countedQty: number };
    expect(flat.countedQty).toBe(1);
    const closed = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-FLAT' })) as {
      adjustedLines: number;
    };
    expect(closed.adjustedLines).toBe(0);
    expect(qty()).toBe(1);
    expect(ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id).some((row) => row.reason.startsWith('stocktake:'))).toBe(
      false,
    );

    await ws.tools.invoke('wms.stocktake.create', { stocktakeNo: 'ST-UP' });
    const up = (await ws.tools.invoke('wms.stocktake.count', {
      stocktakeNo: 'ST-UP',
      skuCode: 'A-1',
      countedQty: 1.0006,
    })) as { countedQty: number };
    expect(up.countedQty).toBe(1.001);
    const adjusted = (await ws.tools.invoke('wms.stocktake.close', { stocktakeNo: 'ST-UP' })) as {
      adjustedLines: number;
      adjustments: { delta: number }[];
    };
    expect(adjusted.adjustedLines).toBe(1);
    expect(adjusted.adjustments[0]!.delta).toBeCloseTo(0.001, 3);
    expect(qty()).toBeCloseTo(1.001, 3);
  });

  it('实拣多 0.001 拒绝，刚好拣满可以关单', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2 });
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1.001 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'picking' });
    const created = (await ws.tools.invoke('wms.picking.create', { orderNos: ['OUT-1'], pickingNo: 'PK-1' })) as {
      pickingNo: string;
    };
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.picking.pick', { pickingNo: 'PK-1', orderNo: 'OUT-1', skuCode: 'A-1', pickedQty: 1.002 }),
    ).rejects.toThrow(PickingOverPickError);
    expect(ws.events.count()).toBe(before);

    const picked = (await ws.tools.invoke('wms.picking.pick', {
      pickingNo: created.pickingNo,
      orderNo: 'OUT-1',
      skuCode: 'A-1',
      pickedQty: 1.001,
    })) as { remainingToPick: number };
    expect(picked.remainingToPick).toBeCloseTo(0, 3);
    await ws.tools.invoke('wms.picking.close', { pickingNo: 'PK-1' });
    expect(ws.orders.byNo('OUT-1')!.state).toBe('picked');
    expect(qty()).toBeCloseTo(0.999, 3);
  });

  it('客退刚好退完；再退 0.001 拒绝', async () => {
    setEnabled('module.picking', false);
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1.001 });
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1.001 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'OUT-1', to: 'shipped' });
    expect(qty()).toBe(0);

    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 1.002 }],
      }),
    ).rejects.toThrow(ReturnQtyExceededError);
    expect(ws.events.count()).toBe(before);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1.001 }],
    });
    expect(getReturnable(ws, 'OUT-1').lines[0]!.remaining).toBe(0);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 0.001 }],
      }),
    ).rejects.toThrow(ReturnQtyExceededError);
  });
});
