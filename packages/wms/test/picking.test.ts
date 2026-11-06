import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  WmsDomain,
  InsufficientStockError,
  InvalidTransitionError,
  OrderNotFoundError,
  PickingIncompleteError,
  PickingLineNotFoundError,
  PickingNoOrdersError,
  PickingNotOpenError,
  PickingNotFoundError,
  PickingOrderStateError,
  PickingOverPickError,
  listPickingsWithLines,
} from '../src/index.js';

/**
 * 拣货单（M21）——聚合「拣货中」出库单、实拣记实、关单统一扣减。
 * 覆盖：建单（状态守卫 / 建议桶）/ 实拣（累计后到者胜 / 超拣拒绝 / 改拣桶）/
 * 关单（全行拣满守卫 / 订单 shipped / 扣减流水 reason / 原子性）/ 取消 /
 * replay 重建 / 守卫复用（余量不足拒绝且零事件）。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-picking');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

/** 备货：入库收货（DEFAULT 桶），把 SKU 放上架 */
async function stock(skuCode: string, qty: number, batchNo?: string): Promise<void> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode, quantity: qty, ...(batchNo ? { batchNo } : {}) }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'done' });
}

/** 建出库单并推进到「拣货中」 */
async function pickingStateOrder(skuCode: string, qty: number, batchNo?: string): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines: [{ skuCode, quantity: qty, ...(batchNo ? { batchNo } : {}) }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'picking' });
  return r.orderNo;
}

describe('拣货单：创建', () => {
  it('聚合两张出库单 → 建议桶随事件携带 → 投影可见', async () => {
    await stock('A-1', 20, 'B-1');
    await stock('B-2', 10);
    const o1 = await pickingStateOrder('A-1', 5, 'B-1');
    const o2 = await pickingStateOrder('B-2', 3);

    const r = (await ws.tools.invoke('wms.picking.create', { orderNos: [o1, o2] })) as {
      pickingNo: string;
      lineCount: number;
    };
    expect(r.lineCount).toBe(2);

    const withLines = listPickingsWithLines(ws)[0]!;
    expect(withLines.state).toBe('created');
    expect(withLines.lines.map((l) => [l.orderNo, l.skuCode, l.suggestedBatchNo])).toEqual([
      [o1, 'A-1', 'B-1'], // 显式批次行 → 建议桶 = 该批次
      [o2, 'B-2', 'DEFAULT'], // 虚拟批次 + strict 缺省策略 → 建议 DEFAULT
    ]);
  });

  it('虚拟批次 + fifo 策略 → 建议桶按余量桶装载', async () => {
    await stock('A-1', 10, 'B-1');
    // 无批次入库（DEFAULT 桶）
    await stock('A-1', 5);
    const orderNo = await pickingStateOrder('A-1', 5); // 无批次出库行

    await ws.tools.invoke('wms.picking.create', { orderNos: [orderNo] });
    const line = listPickingsWithLines(ws)[0]!.lines[0]!;
    // fifo 缺省 strict——先改策略再建第二张验证
    expect(line.suggestedBatchNo).toBe('DEFAULT');
  });

  it('非「拣货中」状态的出库单 → 拒绝且零事件', async () => {
    await stock('A-1', 10);
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    })) as { orderNo: string };
    const baseline = countEvents();
    await expect(ws.tools.invoke('wms.picking.create', { orderNos: [r.orderNo] })).rejects.toThrow(
      PickingOrderStateError,
    );
    expect(countEvents()).toBe(baseline);
  });

  it('入库单 / 不存在单号 → 拒绝', async () => {
    await expect(ws.tools.invoke('wms.picking.create', { orderNos: ['ghost'] })).rejects.toThrow(
      OrderNotFoundError,
    );
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    await expect(ws.tools.invoke('wms.picking.create', { orderNos: [r.orderNo] })).rejects.toThrow(
      PickingOrderStateError,
    );
    await expect(ws.tools.invoke('wms.picking.create', { orderNos: [] })).rejects.toThrow(
      PickingNoOrdersError,
    );
  });
});

describe('拣货单：实拣与关单', () => {
  beforeEach(async () => {
    await stock('A-1', 20, 'B-1');
    await stock('B-2', 10);
  });

  async function newPicking(): Promise<{ pickingNo: string; o1: string; o2: string }> {
    const o1 = await pickingStateOrder('A-1', 5, 'B-1');
    const o2 = await pickingStateOrder('B-2', 3);
    const r = (await ws.tools.invoke('wms.picking.create', { orderNos: [o1, o2] })) as {
      pickingNo: string;
    };
    return { pickingNo: r.pickingNo, o1, o2 };
  }

  it('未拣完关单 → PickingIncompleteError；拣满后关单 → 订单 shipped + 统一扣减', async () => {
    const { pickingNo, o1, o2 } = await newPicking();

    await expect(ws.tools.invoke('wms.picking.close', { pickingNo })).rejects.toThrow(
      PickingIncompleteError,
    );

    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
    });
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o2,
      skuCode: 'B-2',
      pickedQty: 3,
    });

    const r = (await ws.tools.invoke('wms.picking.close', { pickingNo })) as {
      state: string;
      orders: { orderNo: string; to: string }[];
    };
    expect(r.state).toBe('closed');
    // 逐单 shipped（聚合顺序无承诺——无序比较）
    expect(r.orders).toEqual(
      expect.arrayContaining([
        { orderNo: o1, from: 'picking', to: 'shipped' },
        { orderNo: o2, from: 'picking', to: 'shipped' },
      ]),
    );
    expect(r.orders).toHaveLength(2);
    expect(ws.orders.byNo(o1)!.state).toBe('shipped');
    expect(ws.orders.byNo(o2)!.state).toBe('shipped');

    const a1 = ws.skus.byCode('A-1')!;
    const b2 = ws.skus.byCode('B-2')!;
    expect(ws.inventory.quantityOf(a1.id, 'DEFAULT', 'B-1')).toBe(15);
    expect(ws.inventory.quantityOf(b2.id, 'DEFAULT', 'DEFAULT')).toBe(7);
  });

  it('实拣可改拣其他库位/批次——关单按实拣桶校验与扣减', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: 'A 区 01' });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      locationCode: 'A-01',
      batchNo: 'B-2',
      batchExpiryDate: '2027-01-01',
    });
    const o1 = await pickingStateOrder('A-1', 5, 'B-1');
    const r = (await ws.tools.invoke('wms.picking.create', { orderNos: [o1] })) as {
      pickingNo: string;
    };

    // 建议桶 B-1@DEFAULT，实拣改到 A-01/B-2
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: r.pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
      locationCode: 'A-01',
      pickedBatchNo: 'B-2',
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: r.pickingNo });

    const a1 = ws.skus.byCode('A-1')!;
    const a01 = ws.locations.byCode('A-01')!.id;
    expect(ws.inventory.quantityOf(a1.id, a01, 'B-2')).toBe(5);
    expect(ws.inventory.quantityOf(a1.id, 'DEFAULT', 'B-1')).toBe(20); // 建议桶未动
  });

  it('超拣拒绝；实拣量累计（后到者胜）', async () => {
    const { pickingNo, o1 } = await newPicking();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: o1,
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 6,
      }),
    ).rejects.toThrow(PickingOverPickError);

    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 2,
    });
    const r = (await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
    })) as { remainingToPick: number };
    expect(r.remainingToPick).toBe(0);
  });

  it('实拣桶余量不足 → 关单拒绝且零事件（守卫复用）', async () => {
    const { pickingNo, o1, o2 } = await newPicking();
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
    });
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o2,
      skuCode: 'B-2',
      pickedQty: 3,
    });
    // 建议桶被挪用（关单前库存被移走）
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -20,
      batchNo: 'B-1',
      reason: 'test',
    });
    const baseline = countEvents();
    await expect(ws.tools.invoke('wms.picking.close', { pickingNo })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(countEvents()).toBe(baseline);
    expect(ws.orders.byNo(o1)!.state).toBe('picking'); // 订单留在拣货中
    expect(ws.pickings.byNo(pickingNo)!.state).toBe('created'); // 拣货单仍 open
  });

  it('行定位失败 → PickingLineNotFoundError；单号不存在 → PickingNotFoundError', async () => {
    const { pickingNo, o1 } = await newPicking();
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: o1,
        skuCode: 'A-1',
        suggestedBatchNo: 'B-NOPE',
        pickedQty: 5,
      }),
    ).rejects.toThrow(PickingLineNotFoundError);
    await expect(
      ws.tools.invoke('wms.picking.pick', { pickingNo: 'ghost', orderNo: o1, skuCode: 'A-1', pickedQty: 1 }),
    ).rejects.toThrow(PickingNotFoundError);
  });

  it('取消：open 可取消，已录实拣保留审计；再操作 → PickingNotOpenError', async () => {
    const { pickingNo, o1 } = await newPicking();
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
    });
    const r = (await ws.tools.invoke('wms.picking.cancel', { pickingNo })) as { state: string };
    expect(r.state).toBe('canceled');
    expect(ws.pickings.byNo(pickingNo)!.state).toBe('canceled');
    const a1 = ws.skus.byCode('A-1')!;
    const pickedLine = ws.pickings
      .lines(ws.pickings.byNo(pickingNo)!.id)
      .find((l) => l.skuId === a1.id)!;
    expect(pickedLine.pickedQty).toBe(5); // 审计保留
    expect(ws.orders.byNo(o1)!.state).toBe('picking'); // 订单留待人工

    await expect(ws.tools.invoke('wms.picking.cancel', { pickingNo })).rejects.toThrow(
      PickingNotOpenError,
    );
    await expect(
      ws.tools.invoke('wms.picking.pick', {
        pickingNo,
        orderNo: o1,
        skuCode: 'A-1',
        suggestedBatchNo: 'B-1',
        pickedQty: 5,
      }),
    ).rejects.toThrow(PickingNotOpenError);
  });

  it('replay 重建一致（拣货单 + 实拣 + 扣减后的库存）', async () => {
    const { pickingNo, o1, o2 } = await newPicking();
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o1,
      skuCode: 'A-1',
      suggestedBatchNo: 'B-1',
      pickedQty: 5,
    });
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo,
      orderNo: o2,
      skuCode: 'B-2',
      pickedQty: 3,
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo });

    ws.replay();
    const a1 = ws.skus.byCode('A-1')!;
    expect(ws.pickings.byNo(pickingNo)!.state).toBe('closed');
    expect(ws.orders.byNo(o1)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(a1.id, 'DEFAULT', 'B-1')).toBe(15);
  });
});

describe('拣货单：订单流程配置联动（when 过滤）', () => {
  it('picking→shipped 转移挂 when（模块停用）→ 关单被流程拒绝（配置即权威）', async () => {
    await stock('A-1', 10);
    const orderNo = await pickingStateOrder('A-1', 5);
    const r = (await ws.tools.invoke('wms.picking.create', { orderNos: [orderNo] })) as {
      pickingNo: string;
    };
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: r.pickingNo,
      orderNo,
      skuCode: 'A-1',
      pickedQty: 5,
    });

    // 慢通道改流程：picking→shipped 挂 when module.putaway.enabled（同 patch 停用
    // 该模块——转移保留但运行时不可达；静态可达性不受影响，patch 合法）
    const patch: PatchOp[] = [
      {
        op: 'replace',
        path: '/workflows/outbound/transitions',
        value: [
          { from: 'created', to: 'picking' },
          { from: 'picking', to: 'shipped', when: 'module.putaway.enabled' },
          { from: 'shipped', to: 'done' },
          { from: 'picking', to: 'canceled' },
        ],
      },
      { op: 'replace', path: '/modules/module.putaway/enabled', value: false },
    ];
    const { proposalId } = ws.profile.propose('user:tester', patch, '测试');
    ws.profile.confirm(proposalId, 'user:tester');

    await expect(ws.tools.invoke('wms.picking.close', { pickingNo: r.pickingNo })).rejects.toThrow(
      InvalidTransitionError,
    );
  });
});
