import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain, OrderNotFoundError, SkuNotFoundError } from '../src/index.js';

/**
 * 分页查询工具（AI 结果守门的配套）：wms.ledger.query / wms.order.query。
 * 统一分页壳 { total, limit, offset, hasMore, rows }；过滤条件各自生效；纯读零事件。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-query');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

describe('wms.ledger.query：库存流水分页查询', () => {
  it('全量分页：total/hasMore/翻页；行含裁剪字段；纯读零事件', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, reason: '期初' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, reason: '补货' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 5, reason: '期初' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: -2, reason: '报损' });

    const before = ws.events.count();
    const page1 = (await ws.tools.invoke('wms.ledger.query', { limit: 2 })) as {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      rows: {
        createdAt: string;
        skuCode: string;
        locationCode: string;
        batchNo: string;
        delta: number;
        reason: string;
        orderNo: string | null;
      }[];
    };
    expect(page1.total).toBe(4);
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.rows[0].locationCode).toBe('DEFAULT');
    expect(page1.rows[0].batchNo).toBe('DEFAULT');
    expect(typeof page1.rows[0].delta).toBe('number');
    expect(page1.rows[0].orderNo).toBeNull();

    const page2 = (await ws.tools.invoke('wms.ledger.query', { limit: 2, offset: 2 })) as {
      rows: unknown[];
      hasMore: boolean;
    };
    expect(page2.rows).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(ws.events.count()).toBe(before); // 纯读
  });

  it('skuCode / orderNo 过滤；orderNo 换算回单据号', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, reason: '期初' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 3, reason: '期初' });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-OQ-1',
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-OQ-1', to: 'received' });

    const bySku = (await ws.tools.invoke('wms.ledger.query', { skuCode: 'A-1' })) as {
      total: number;
      rows: { skuCode: string }[];
    };
    // A-1：期初 + 入单 received 各一条
    expect(bySku.total).toBe(2);
    expect(bySku.rows.every((r) => r.skuCode === 'A-1')).toBe(true);

    const byOrder = (await ws.tools.invoke('wms.ledger.query', { orderNo: 'IN-OQ-1' })) as {
      total: number;
      rows: { orderNo: string | null; reason: string }[];
    };
    expect(byOrder.total).toBe(1);
    expect(byOrder.rows[0].orderNo).toBe('IN-OQ-1');
    expect(byOrder.rows[0].reason).toContain('received');
  });

  it('skuCode 不存在 → 抛 SkuNotFoundError', async () => {
    await expect(ws.tools.invoke('wms.ledger.query', { skuCode: 'GHOST' })).rejects.toThrow(SkuNotFoundError);
  });
});

describe('wms.order.query：单据分页查询与详情', () => {
  it('列表模式：direction/state 过滤 + 行统计 + 分页壳', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-LQ-1',
      lines: [
        { skuCode: 'A-1', quantity: 3 },
        { skuCode: 'B-2', quantity: 2 },
      ],
    });
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-LQ-1',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-LQ-1', to: 'received' });

    const before = ws.events.count();
    const all = (await ws.tools.invoke('wms.order.query', {})) as {
      total: number;
      rows: { orderNo: string; direction: string; state: string; lineCount: number; totalQuantity: number }[];
    };
    expect(all.total).toBe(2);
    const inRow = all.rows.find((r) => r.orderNo === 'IN-LQ-1')!;
    expect(inRow.lineCount).toBe(2);
    expect(inRow.totalQuantity).toBe(5);
    expect(inRow.state).toBe('received');

    const outs = (await ws.tools.invoke('wms.order.query', { direction: 'out' })) as {
      total: number;
      rows: { orderNo: string }[];
    };
    expect(outs.total).toBe(1);
    expect(outs.rows[0].orderNo).toBe('OUT-LQ-1');

    const received = (await ws.tools.invoke('wms.order.query', { state: 'received' })) as { total: number };
    expect(received.total).toBe(1);
    expect(ws.events.count()).toBe(before); // 纯读
  });

  it('orderNo 模式：返回详情含明细行与 SKU 编码', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-LQ-2',
      lines: [{ skuCode: 'A-1', quantity: 3, batchNo: 'B2026' }],
    });

    const detail = (await ws.tools.invoke('wms.order.query', { orderNo: 'IN-LQ-2' })) as {
      orderNo: string;
      direction: string;
      lines: { skuCode: string; quantity: number; batchNo: string }[];
    };
    expect(detail.orderNo).toBe('IN-LQ-2');
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].skuCode).toBe('A-1');
    expect(detail.lines[0].batchNo).toBe('B2026');
  });

  it('orderNo 不存在 → 抛 OrderNotFoundError；分页翻页 hasMore 正确', async () => {
    await expect(ws.tools.invoke('wms.order.query', { orderNo: 'GHOST-1' })).rejects.toThrow(OrderNotFoundError);

    for (let i = 0; i < 3; i++) {
      await ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      });
    }
    const page1 = (await ws.tools.invoke('wms.order.query', { limit: 2 })) as { hasMore: boolean; total: number };
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    const page2 = (await ws.tools.invoke('wms.order.query', { limit: 2, offset: 2 })) as {
      hasMore: boolean;
    };
    expect(page2.hasMore).toBe(false);
  });
});
