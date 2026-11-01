import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain, InsufficientStockError } from '../src/index.js';

/**
 * 单据 → 库存联动（M9）：
 *  - 入库 received 自动 +库存（逐行流水，reason=order:received，关联单号）
 *  - 出库 picking 余量预检（同 SKU 多行聚合；不足拒绝且零事件）
 *  - 出库 shipped 自动 -库存（硬守卫：不足拒绝且零事件——含 picking 后库存被挪走的窗口）
 *  - 无效应状态（done / canceled）库存不动；replay 重建一致；手动 adjust 共存
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-link');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

function qty(code: string): number {
  return ws.inventory.quantityOf(ws.skus.byCode(code)!.id);
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

async function createOrder(
  direction: 'in' | 'out',
  lines: { skuCode: string; quantity: number }[],
): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', { direction, lines })) as { orderNo: string };
  return r.orderNo;
}

describe('入库联动：received 自动上架', () => {
  it('多行入库 → received 后逐行入账，返回值携带明细', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 100 },
      { skuCode: 'B-2', quantity: 50 },
    ]);
    const r = (await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' })) as {
      adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
    };
    expect(r.adjustedLines).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: 100 },
      { skuCode: 'B-2', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: 50 },
    ]);
    expect(qty('A-1')).toBe(100);
    expect(qty('B-2')).toBe(50);
  });

  it('多 SKU 入库 → 逐行流水（行级事实粒度），reason/orderId 可审计', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 30 },
      { skuCode: 'B-2', quantity: 70 },
    ]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    expect(qty('A-1')).toBe(30);
    expect(qty('B-2')).toBe(70);

    const ledger = ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('order:received');
    expect(ledger[0].orderId).toBe(ws.orders.byNo(no)!.id);
  });

  it('received → done 不再变动库存', async () => {
    const no = await createOrder('in', [{ skuCode: 'A-1', quantity: 10 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' });
    expect(qty('A-1')).toBe(10);
  });

  it('created → canceled 零库存效应', async () => {
    const no = await createOrder('in', [{ skuCode: 'A-1', quantity: 10 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'canceled' });
    expect(qty('A-1')).toBe(0);
  });
});

describe('出库联动：预检 + 自动扣减', () => {
  it('余量充足 → picking 预检通过不动账，shipped 扣减正确', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 100 });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 40 }]);

    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    expect(qty('A-1')).toBe(100); // 拣货不动账

    const r = (await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'shipped' })) as {
      adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
    };
    expect(r.adjustedLines).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: -40 },
    ]);
    expect(qty('A-1')).toBe(60);
  });

  it('picking 预检：多行中任一 SKU 余量不足即拒绝，零事件、状态不变', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 }); // B-2 余量为 0
    const no = await createOrder('out', [
      { skuCode: 'A-1', quantity: 30 },
      { skuCode: 'B-2', quantity: 30 },
    ]);
    const before = countEvents();

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.byNo(no)!.state).toBe('created');
    expect(countEvents()).toBe(before);
    expect(qty('A-1')).toBe(50);
  });

  it('shipped 硬守卫：picking 后库存被挪走 → 拒绝且零事件（原子性可观测）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 100 });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 60 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    // 拣货与发货之间，库存被手动挪用（v1 无真实预占的已知窗口）
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -50 });
    const before = countEvents();

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'shipped' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.byNo(no)!.state).toBe('picking');
    expect(countEvents()).toBe(before); // state_changed 与流水同生共死：一条都没落
    expect(qty('A-1')).toBe(50);
  });

  it('picking → canceled 不动库存', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 100 });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 40 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'canceled' });
    expect(qty('A-1')).toBe(100);
  });

  it('流水审计：shipped 流水携带 reason=order:shipped 与单号关联', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 100 });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 40 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'shipped' });

    const shipped = ws.inventory
      .ledgerOf(ws.skus.byCode('A-1')!.id)
      .find((l) => l.reason === 'order:shipped')!;
    expect(shipped.delta).toBe(-40);
    expect(shipped.orderId).toBe(ws.orders.byNo(no)!.id);
  });
});

describe('联动与追账模型', () => {
  it('replay() 全量重建后余量与流水一致', async () => {
    const inNo = await createOrder('in', [{ skuCode: 'A-1', quantity: 100 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'received' });
    const outNo = await createOrder('out', [{ skuCode: 'A-1', quantity: 30 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(qty('A-1')).toBe(70);

    const r = ws.replay();
    expect(r.appliedWmsEvents).toBeGreaterThanOrEqual(5);
    expect(qty('A-1')).toBe(70);
    expect(ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id)).toHaveLength(2); // 收货 + / 发货 -
  });

  it('手动 adjust 与单据联动共存（期初 + 收货）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50, reason: '期初' });
    const no = await createOrder('in', [{ skuCode: 'A-1', quantity: 30 }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    expect(qty('A-1')).toBe(80);

    const ledger = ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id);
    expect(ledger.map((l) => l.reason)).toEqual(['期初', 'order:received']);
  });
});
