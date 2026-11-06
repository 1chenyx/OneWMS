import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  HoldExceedsStockError,
  HoldNotFoundError,
  SkuNotFoundError,
  StockHeldError,
  WMS_EVENT_TYPES,
} from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

/** 事件计数（断言「拒绝零事件」与「纯读零事件」用） */
function countEvents(): number {
  return ws.events.count();
}

describe('冻结：hold/release 基础链路（M19）', () => {
  it('hold 返回 held/available；落 held 事件；不产生库存流水', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, reason: '期初' });
    const before = countEvents();

    const r = (await ws.tools.invoke('wms.inventory.hold', {
      skuCode: 'A-1',
      quantity: 4,
      reason: '质检隔离',
    })) as { holdId: string; held: number; available: number };

    expect(r.holdId).toBeTruthy();
    expect(r.held).toBe(4);
    expect(r.available).toBe(6);
    expect(countEvents()).toBe(before + 1); // 恰一条 held 事件

    // 冻结不改物理量：流水仍只有期初一条；汇总余量仍 10
    const skuId = ws.skus.byCode('A-1')!.id;
    expect(ws.inventory.ledgerOf(skuId)).toHaveLength(1);
    expect(ws.inventory.totalOf(skuId)).toBe(10);
    expect(ws.inventory.heldOf(skuId)).toBe(4);
  });

  it('同 SKU 多笔冻结累加；跨 SKU 互不影响', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 4 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 3, reason: '客订' });

    const a = ws.skus.byCode('A-1')!.id;
    expect(ws.inventory.heldOf(a)).toBe(7);

    // B-2 无冻结
    const b = ws.skus.byCode('B-2')!.id;
    expect(ws.inventory.heldOf(b)).toBe(0);
  });

  it('冻结超量拒（已冻结合计 + 本次 ≤ 账面余量），零事件', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 6 });
    const before = countEvents();

    await expect(
      ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 5 }),
    ).rejects.toThrow(HoldExceedsStockError);
    expect(countEvents()).toBe(before);

    // 边界：恰好冻到全额允许（available 0）
    const r = (await ws.tools.invoke('wms.inventory.hold', {
      skuCode: 'A-1',
      quantity: 4,
    })) as { available: number };
    expect(r.available).toBe(0);
  });

  it('零库存冻结拒（总量 0）；quantity 非正拒', async () => {
    await expect(
      ws.tools.invoke('wms.inventory.hold', { skuCode: 'B-2', quantity: 1 }),
    ).rejects.toThrow(HoldExceedsStockError);

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
    // 非正数量在工具总线 schema 层即拒（minimum: 1，先于 handler）
    await expect(
      ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 0 }),
    ).rejects.toThrow('参数 quantity 不能小于 1');
    await expect(
      ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: -2 }),
    ).rejects.toThrow('参数 quantity 不能小于 1');
  });

  it('SKU 不存在拒', async () => {
    await expect(
      ws.tools.invoke('wms.inventory.hold', { skuCode: 'X-9', quantity: 1 }),
    ).rejects.toThrow(SkuNotFoundError);
  });

  it('release 按 holdId 整笔解除；重复释放拒；释放后出回归可用', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    const h = (await ws.tools.invoke('wms.inventory.hold', {
      skuCode: 'A-1',
      quantity: 6,
    })) as { holdId: string };
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 2, reason: '客订' });

    const r = (await ws.tools.invoke('wms.inventory.release', {
      holdId: h.holdId,
      reason: '质检合格',
    })) as { quantity: number; held: number; available: number };
    expect(r.quantity).toBe(6);
    expect(r.held).toBe(2);
    expect(r.available).toBe(8);

    const skuId = ws.skus.byCode('A-1')!.id;
    expect(ws.inventory.heldOf(skuId)).toBe(2);

    // 重复释放（已不在活动清单）→ HoldNotFoundError，零事件
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.inventory.release', { holdId: h.holdId }),
    ).rejects.toThrow(HoldNotFoundError);
    expect(countEvents()).toBe(before);

    // 释放原因落事件（审计）
    const releasedEvents: Array<{ payload: { reason?: string } }> = [];
    ws.events.forEach((env) => {
      if (env.type === WMS_EVENT_TYPES.inventoryReleased) releasedEvents.push(env as never);
    });
    expect(releasedEvents).toHaveLength(1);
    expect(releasedEvents[0].payload.reason).toBe('质检合格');
  });

  it('holds 查询：全量 / 按 skuCode 过滤 / 释放后不在列；纯读零事件', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 5 });
    const h1 = (await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 3 })) as {
      holdId: string;
    };
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'B-2', quantity: 2 });

    const before = countEvents();
    const all = (await ws.tools.invoke('wms.inventory.holds', {})) as Array<{ skuCode: string }>;
    expect(all).toHaveLength(2);
    const onlyA = (await ws.tools.invoke('wms.inventory.holds', {
      skuCode: 'A-1',
    })) as Array<{ skuCode: string }>;
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].skuCode).toBe('A-1');
    expect(countEvents()).toBe(before); // 纯读零事件

    await ws.tools.invoke('wms.inventory.release', { holdId: h1.holdId });
    const after = (await ws.tools.invoke('wms.inventory.holds', { skuCode: 'A-1' })) as unknown[];
    expect(after).toHaveLength(0);
  });
});

describe('冻结：出库拦截（M19）', () => {
  it('picking 预检拒（可用量不足）；释放后同单可流转', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 6 });

    const order = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    })) as { orderNo: string };
    const before = countEvents();

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'picking' }),
    ).rejects.toThrow(StockHeldError);
    expect(countEvents()).toBe(before); // 拒绝零事件

    // 逐笔释放到可用 ≥ 需求后放行
    const holds = (await ws.tools.invoke('wms.inventory.holds', { skuCode: 'A-1' })) as Array<{
      holdId: string;
    }>;
    await ws.tools.invoke('wms.inventory.release', { holdId: holds[0].holdId });
    const t = (await ws.tools.invoke('wms.order.transition', {
      orderNo: order.orderNo,
      to: 'picking',
    })) as { to: string };
    expect(t.to).toBe('picking');
  });

  it('shipped 扣减同拦；可用量恰好等于需求放行', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 5 }); // 可用 5

    const order = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    })) as { orderNo: string };

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'picking' }),
    ).rejects.toThrow(StockHeldError);

    // 出库单绕过 picking 直接 ship 不合法（状态机）；改为可用恰好 = 需求的边界单
    await ws.tools.invoke('wms.inventory.release', {
      holdId: ((await ws.tools.invoke('wms.inventory.holds', { skuCode: 'A-1' })) as Array<{
        holdId: string;
      }>)[0].holdId,
    });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 4 }); // 可用 6 = 需求
    await ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'picking' });
    const ship = (await ws.tools.invoke('wms.order.transition', {
      orderNo: order.orderNo,
      to: 'shipped',
    })) as { adjustedLines: Array<{ delta: number }> };
    expect(ship.adjustedLines).toHaveLength(1);
    expect(ship.adjustedLines[0].delta).toBe(-6);
  });

  it('同 SKU 多行聚合拦截（逐行各自通过而合计超可用也拒）', async () => {
    // 两个批次桶各 5（行键不同才可同单两行）；冻结 5 → 可用 5
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, batchNo: 'B1' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, batchNo: 'B2' });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 5 });

    // 两行各 3：逐桶 3 ≤ 5 各自通过，合计 6 > 可用 5 → 拒（聚合校验兜住）
    const order = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [
        { skuCode: 'A-1', quantity: 3, batchNo: 'B1' },
        { skuCode: 'A-1', quantity: 3, batchNo: 'B2' },
      ],
    })) as { orderNo: string };
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'picking' }),
    ).rejects.toThrow(StockHeldError);
  });

  it('调整（负 delta）与移库不受冻结拦截——物理修正通道', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 6 });

    // 盘点修正把冻结中的货调走（物理事实优先；可用量可为负）
    const r = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -10,
      reason: '盘亏',
    })) as { quantity: number };
    expect(r.quantity).toBe(0);

    // 移库不拦（先补回货，再整桶移走——冻结不挡库内移动）
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.location.create', { locationCode: 'LOC-01', name: '备货区' });
    const mv = (await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      toLocationCode: 'LOC-01',
      quantity: 10,
    })) as { fromBalance: number };
    expect(mv.fromBalance).toBe(0);
  });

  it('query 分组携带 held / available', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 4 });

    const q = (await ws.tools.invoke('wms.inventory.query', { skuCode: 'A-1' })) as {
      total: number;
      held: number;
      available: number;
    };
    expect(q.total).toBe(10);
    expect(q.held).toBe(4);
    expect(q.available).toBe(6);
  });
});

describe('冻结：投影与重放（M19）', () => {
  it('replay() 后冻结投影完整重建', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    const h = (await ws.tools.invoke('wms.inventory.hold', {
      skuCode: 'A-1',
      quantity: 6,
    })) as { holdId: string };
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 2 });
    await ws.tools.invoke('wms.inventory.release', { holdId: h.holdId });

    const skuId = ws.skus.byCode('A-1')!.id;
    ws.replay();
    expect(ws.inventory.heldOf(skuId)).toBe(2);
    expect(ws.inventory.listHolds(skuId)).toHaveLength(1);
    expect(ws.inventory.listHolds(skuId)[0].quantity).toBe(2);

    // 事件账本里 held×2 + released×1（审计可溯）
    const types: string[] = [];
    ws.events.forEach((env) => types.push(env.type));
    expect(types.filter((t) => t === WMS_EVENT_TYPES.inventoryHeld)).toHaveLength(2);
    expect(types.filter((t) => t === WMS_EVENT_TYPES.inventoryReleased)).toHaveLength(1);
  });
});
