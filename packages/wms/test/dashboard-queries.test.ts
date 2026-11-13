import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  getAlertSummary,
  getDashboardActivity,
  getDashboardOverview,
  getDashboardStock,
  getDashboardUrgent,
  getDashboardWorkload,
  getFlowTrend,
  getLocationDistribution,
  getOrderStats,
} from '../src/index.js';

/**
 * 运营看板查询（M21）——五维度各自独立的纯读组装。
 * 覆盖：总览计数（含库位使用/在途单据/冻结）/ 流量趋势（缺日补零、上架
 * 移库不计入）/ 库位分布（Top 8 + 其他归并）/ 单据统计 / 预警分级。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-dash');
});

afterEach(() => {
  core.close();
});

async function receive(skuCode: string, qty: number, batchNo?: string, expiry?: string): Promise<void> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode, quantity: qty, ...(batchNo ? { batchNo } : {}), ...(expiry ? { batchExpiryDate: expiry } : {}) }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
  await ws.tools.invoke('wms.order.putaway', { orderNo: r.orderNo });
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'done' });
}

describe('运营看板：总览', () => {
  it('计数正确：SKU / 总量 / 在途单据 / 库位使用 / 拣货 / 冻结', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: 'A 区' });
    await receive('A-1', 10);
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      locationCode: 'A-01',
    });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 2, reason: '质检' });
    // 在途单据：一张入库单停在 created
    await ws.tools.invoke('wms.order.create', { direction: 'in', lines: [{ skuCode: 'A-1', quantity: 1 }] });

    const o = getDashboardOverview(ws);
    expect(o.skuCount).toBe(2);
    expect(o.totalQuantity).toBe(15);
    expect(o.openOrderCount).toBe(1);
    expect(o.locationCount).toBe(1); // DEFAULT + A-01 = 2？——DEFAULT 是系统库位
    expect(o.locationUsedCount).toBe(2); // DEFAULT + A-01
    expect(o.activeHoldCount).toBe(1);
    expect(o.openPickingCount).toBe(0);
  });

  it('A2 软停用：archived 档不计入 skuCount（其余计数不受影响）', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
    expect(getDashboardOverview(ws).skuCount).toBe(2);

    await ws.tools.invoke('wms.sku.archive', { skuCode: 'B-2' });
    expect(getDashboardOverview(ws).skuCount).toBe(1);
  });
});

describe('运营看板：流量趋势', () => {
  it('近 N 天逐日聚合，缺日补零', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await receive('A-1', 10); // 今天：入库 10

    const trend = getFlowTrend(ws, 3);
    expect(trend).toHaveLength(3);
    expect(trend.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day))).toBe(true);
    const today = trend[2]!;
    expect(today.inbound).toBe(10);
    expect(today.outbound).toBe(0);
    expect(trend[0]).toEqual({ day: trend[0]!.day, inbound: 0, outbound: 0 });
  });

  it('上架移库（± 对）不计入流量', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: 'A 区' });
    await receive('A-1', 10);
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
    await ws.tools.invoke('wms.order.putaway', {
      orderNo: r.orderNo,
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    });

    const trend = getFlowTrend(ws, 1);
    // receive 10 + 第二单 receive 10 = 20；putaway ±10/10 被排除（不排除会是 30）
    expect(trend[0]!.inbound).toBe(20);
  });
});

describe('运营看板：库位分布', () => {
  it('按库位聚合，超过 Top 8 归并「其他」', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    for (let i = 1; i <= 10; i++) {
      await ws.tools.invoke('wms.location.create', { locationCode: `L-${String(i).padStart(2, '0')}`, name: `库位${i}` });
      await ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: i,
        locationCode: `L-${String(i).padStart(2, '0')}`,
      });
    }
    const dist = getLocationDistribution(ws);
    // 10 个库位 > 8 → Top 8（L-10..L-03）+ 其他（L-01 + L-02 = 1 + 2）
    expect(dist).toHaveLength(9);
    expect(dist[0]).toEqual({ locationCode: 'L-10', quantity: 10 });
    expect(dist[8]).toEqual({ locationCode: '其他（2 库位）', quantity: 3 });
  });
});

describe('运营看板：单据统计与预警', () => {
  it('方向 × 状态计数', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await receive('A-1', 10);
    await ws.tools.invoke('wms.order.create', { direction: 'out', lines: [{ skuCode: 'A-1', quantity: 1 }] });

    const stats = getOrderStats(ws);
    expect(stats).toContainEqual({ direction: 'in', state: 'done', count: 1 });
    expect(stats).toContainEqual({ direction: 'out', state: 'created', count: 1 });
  });

  it('效期分级：过期 / 紧急 / 预警', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    const today = new Date();
    const shift = (n: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    await receive('A-1', 1, 'B-过期', shift(-1));
    await receive('A-1', 1, 'B-紧急', shift(2));
    await receive('A-1', 1, 'B-预警', shift(13));
    await receive('A-1', 1, 'B-安全', shift(60));

    const a = getAlertSummary(ws);
    expect(a.expiredCount).toBe(1);
    expect(a.criticalCount).toBe(1);
    expect(a.warningCount).toBe(1);
    expect(a.negativeCount).toBe(0);
    expect(a.holdCount).toBe(0);
  });
});

describe('运营看板：作业积压', () => {
  it('未结束的入库、出库、盘点、调拨、报损、波次分开计数', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: 'A 区' });
    await receive('A-1', 10);
    await ws.tools.invoke('wms.order.create', { direction: 'in', lines: [{ skuCode: 'A-1', quantity: 1 }] });
    const outbound = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.stocktake.create', {});
    const transfer = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', quantity: 1, fromLocationCode: 'DEFAULT', toLocationCode: 'A-01' }],
    })) as { transferNo: string };
    await ws.tools.invoke('wms.scrap.create', { lines: [{ skuCode: 'A-1', quantity: 1 }] });

    const open = getDashboardWorkload(ws);
    expect(open.inboundOpen).toBe(1);
    expect(open.outboundOpen).toBe(1);
    expect(outbound.orderNo).toBeTruthy();
    expect(open.stocktakeOpen).toBe(1);
    expect(open.transferOpen).toBe(1);
    expect(open.transferInTransit).toBe(0);
    expect(open.scrapOpen).toBe(1);
    // 这套测试默认关掉波次，也不会有遗留的待拣波次。
    expect(open.waveOpen).toBe(0);
    expect(open.pickingOpen).toBe(0);

    await ws.tools.invoke('wms.transfer.ship', { transferNo: transfer.transferNo });
    const shipped = getDashboardWorkload(ws);
    expect(shipped.transferOpen).toBe(1);
    expect(shipped.transferInTransit).toBe(1);
  });
});

describe('运营看板：库存结构', () => {
  it('低库存含售罄，停用档不计；余量最高的 SKU 只留 8 个', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'LOW', name: '缺货', reorderPoint: 5 });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'OLD', name: '停用', reorderPoint: 9 });
    await ws.tools.invoke('wms.sku.archive', { skuCode: 'OLD' });
    for (let i = 1; i <= 9; i++) {
      await ws.tools.invoke('wms.sku.create', { skuCode: `S-${i}`, name: `货${i}` });
      await ws.tools.invoke('wms.inventory.adjust', { skuCode: `S-${i}`, delta: i });
    }

    const focus = getDashboardStock(ws);
    expect(focus.lowStockCount).toBe(1);
    expect(focus.lowStock[0]).toMatchObject({ skuCode: 'LOW', total: 0, available: 0, shortage: 5 });
    expect(focus.onHand).toBe(45); // 1+…+9
    expect(focus.topSkus).toHaveLength(8);
    expect(focus.topSkus[0]).toMatchObject({ skuCode: 'S-9', quantity: 9 });
    expect(focus.topSkus.map((row) => row.skuCode)).not.toContain('S-1');
    expect(focus.holds).toEqual([]);
  });

  it('冻结吃掉可用量，并出现在冻结清单', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 10 });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 8 });
    await ws.tools.invoke('wms.inventory.hold', { skuCode: 'A-1', quantity: 3, reason: '质检' });

    const focus = getDashboardStock(ws);
    expect(focus.held).toBe(3);
    expect(focus.available).toBe(5);
    expect(focus.lowStock[0]).toMatchObject({ skuCode: 'A-1', available: 5, shortage: 5 });
    expect(focus.holds[0]).toMatchObject({ skuCode: 'A-1', quantity: 3, reason: '质检' });
  });
});

describe('运营看板：临期批次与最近流水', () => {
  it('只留过期、紧急、预警，安全批次不上板', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    const today = new Date();
    const shift = (n: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    await receive('A-1', 1, 'B-过期', shift(-1));
    await receive('A-1', 1, 'B-紧急', shift(2));
    await receive('A-1', 1, 'B-预警', shift(13));
    await receive('A-1', 1, 'B-安全', shift(60));

    const rows = getDashboardUrgent(ws);
    expect(rows.map((row) => row.batchNo)).toEqual(['B-过期', 'B-紧急', 'B-预警']);
    expect(rows[0]!.level).toBe('expired');
    expect(rows[0]!.daysLeft).toBeLessThan(0);
  });

  it('最近流水条数受 limit 限制，调整原因原样带回', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, reason: 'first' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1, reason: 'second' });

    expect(getDashboardActivity(ws, 1)).toHaveLength(1);
    const rows = getDashboardActivity(ws, 12);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((row) => row.delta)).toEqual(expect.arrayContaining([4, -1]));
    expect(rows.map((row) => row.reason)).toEqual(expect.arrayContaining(['first', 'second']));
    expect(rows[0]!.createdAt >= rows[1]!.createdAt).toBe(true);
  });
});
