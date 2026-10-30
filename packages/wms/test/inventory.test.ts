import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain, InsufficientStockError, SkuNotFoundError } from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

describe('库存：流水与余量', () => {
  it('adjust 返回新余量；库存 = 期初 + Σ流水（永远派生）', async () => {
    const r1 = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      reason: '采购入库',
    })) as { quantity: number };
    expect(r1.quantity).toBe(10);

    const r2 = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -3,
      reason: '领料出库',
    })) as { quantity: number };
    expect(r2.quantity).toBe(7);

    // 流水求和 == 当前余量
    const skuId = ws.skus.byCode('A-1')!.id;
    const ledger = ws.inventory.ledgerOf(skuId);
    expect(ledger).toHaveLength(2);
    expect(ledger.reduce((s, l) => s + l.delta, 0)).toBe(7);
    expect(ws.inventory.quantityOf(skuId)).toBe(7);
  });

  it('出库超出余量 → InsufficientStockError，不落事件（负库存防线）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
    const before = ws.events.count();

    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -6 }),
    ).rejects.toThrow(InsufficientStockError);

    expect(ws.events.count()).toBe(before); // 拒绝未产生事件
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(5);
  });

  it('恰好清零允许；零余量再出库拒绝', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4 });
    const r = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: -4,
    })) as { quantity: number };
    expect(r.quantity).toBe(0);

    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1 }),
    ).rejects.toThrow(InsufficientStockError);
  });

  it('关联单据：流水行携带 order_id', async () => {
    const order = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 20 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 20,
      orderNo: order.orderNo,
    });

    const ledger = ws.inventory.ledgerOf(ws.skus.byCode('A-1')!.id);
    expect(ledger[0].orderId).toBe(ws.orders.byNo(order.orderNo)!.id);
    expect(ledger[0].reason).toBe('inbound'); // 缺省 reason 按方向推断
  });

  it('不存在的 SKU / delta=0 → 拒绝', async () => {
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'ghost', delta: 1 }),
    ).rejects.toThrow(SkuNotFoundError);
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 0 }),
    ).rejects.toThrow(/delta 不能为 0/);
  });

  it('query 工具：单个查询与全量清单（read 权限，不落事件）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 7 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 3 });
    const before = ws.events.count();

    const single = (await ws.tools.invoke('wms.inventory.query', {
      skuCode: 'A-1',
    })) as { quantity: number };
    expect(single.quantity).toBe(7);

    const all = (await ws.tools.invoke('wms.inventory.query', {})) as {
      skuCode: string;
      quantity: number;
    }[];
    expect(all).toEqual([
      { skuId: expect.any(String), skuCode: 'A-1', name: '螺丝', quantity: 7 },
      { skuId: expect.any(String), skuCode: 'B-2', name: '螺母', quantity: 3 },
    ]);
    expect(ws.events.count()).toBe(before); // 读操作零事件
  });
});
