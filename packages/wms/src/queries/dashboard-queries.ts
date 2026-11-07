import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';

/**
 * 运营看板查询（M21）——五个维度各自独立函数 + 独立端点 + 独立 queryKey：
 * 后续新增维度（SKU 周转 / 作业员绩效 / …）只加函数 + 路由 + hook，不动既有
 * 维度；前端按维度独立拉取/失效（inventory 变不重拉 orders）。
 * 组装纪律：SQL 聚合在视图层（dailyFlow / quantityByLocation），跨实体联查
 * 在本层经视图 API 组装（不碰 SQL）。
 */

/** ① 总览：数字卡片 */
export interface DashboardOverview {
  skuCount: number;
  totalQuantity: number;
  openOrderCount: number;
  locationCount: number;
  locationUsedCount: number;
  openPickingCount: number;
  activeHoldCount: number;
  expiringSoonCount: number;
}

export function getDashboardOverview(ws: WmsWorkspace): DashboardOverview {
  const settings = readWmsSettings(ws);
  const today = new Date().toISOString().slice(0, 10);
  const inventory = ws.inventory.list();
  const usedLocations = new Set(inventory.filter((r) => r.quantity > 0).map((r) => r.locationId));
  const openOrders = ws.orders
    .list()
    .filter((o) => o.state !== 'done' && o.state !== 'canceled').length;
  return {
    skuCount: ws.skus.list().filter((s) => (s.status ?? 'active') === 'active').length, // A2：停用档不计
    totalQuantity: inventory.reduce((s, r) => s + Math.max(0, r.quantity), 0),
    openOrderCount: openOrders,
    locationCount: ws.locations.list().length,
    locationUsedCount: usedLocations.size,
    openPickingCount: ws.pickings.list('created').length,
    activeHoldCount: ws.inventory.listHolds().length,
    expiringSoonCount: ws.inventory
      .listExpiring(settings.expiryWarningDays, today)
      .filter((r) => r.batchExpiryDate !== null).length,
  };
}

/** ② 出入库流量趋势（近 N 天，缺日补零；上架移库净零不计） */
export interface FlowTrendPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export function getFlowTrend(ws: WmsWorkspace, days = 14): FlowTrendPoint[] {
  const today = new Date();
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map(
    ws.inventory.dailyFlow(dayList[0]!).map((r) => [r.day, r] as const),
  );
  return dayList.map(
    (day) => byDay.get(day) ?? { day, inbound: 0, outbound: 0 },
  );
}

/** ③ 库位库存分布（Top 8 + 其他归并；返回编码供展示） */
export interface LocationDistribution {
  locationCode: string;
  quantity: number;
}

export function getLocationDistribution(ws: WmsWorkspace): LocationDistribution[] {
  const TOP_N = 8;
  const rows = ws.inventory.quantityByLocation();
  const codeOf = (locationId: string) =>
    ws.locations.byId(locationId)?.locationCode ?? locationId;
  if (rows.length <= TOP_N) {
    return rows.map((r) => ({ locationCode: codeOf(r.locationId), quantity: r.quantity }));
  }
  const top = rows.slice(0, TOP_N).map((r) => ({ locationCode: codeOf(r.locationId), quantity: r.quantity }));
  const otherQty = rows.slice(TOP_N).reduce((s, r) => s + r.quantity, 0);
  return [...top, { locationCode: `其他（${rows.length - TOP_N} 库位）`, quantity: otherQty }];
}

/** ④ 单据统计（方向 × 状态计数；状态标签由前端按流程配置渲染） */
export interface OrderStateCount {
  direction: 'in' | 'out';
  state: string;
  count: number;
}

export function getOrderStats(ws: WmsWorkspace): OrderStateCount[] {
  const counter = new Map<string, number>();
  for (const order of ws.orders.list()) {
    const key = `${order.direction}:${order.state}`;
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }
  return [...counter.entries()].map(([key, count]) => {
    const [direction, state] = key.split(':') as ['in' | 'out', string];
    return { direction, state, count };
  });
}

/** ⑤ 预警汇总（效期分级 / 冻结 / 负余量防御） */
export interface AlertSummary {
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  holdCount: number;
  negativeCount: number;
  /** 负余量桶明细（理论上不可能——防御：出现即运营需介入） */
  negativeBuckets: { skuCode: string; locationCode: string; batchNo: string; quantity: number }[];
}

export function getAlertSummary(ws: WmsWorkspace): AlertSummary {
  const settings = readWmsSettings(ws);
  const today = new Date().toISOString().slice(0, 10);
  const skuCodeOf = (skuId: string) => ws.skus.byId(skuId)?.skuCode ?? skuId;
  const locCodeOf = (locationId: string) =>
    ws.locations.byId(locationId)?.locationCode ?? locationId;

  let expiredCount = 0;
  let criticalCount = 0;
  let warningCount = 0;
  for (const r of ws.inventory.list()) {
    if (r.quantity <= 0 || r.batchExpiryDate === null) continue;
    if (r.batchExpiryDate < today) expiredCount++;
    else if (r.batchExpiryDate < addDays(today, settings.expiryCriticalDays)) criticalCount++;
    else if (r.batchExpiryDate < addDays(today, settings.expiryWarningDays)) warningCount++;
  }
  const negativeBuckets = ws.inventory
    .list()
    .filter((r) => r.quantity < 0)
    .map((r) => ({
      skuCode: skuCodeOf(r.skuId),
      locationCode: locCodeOf(r.locationId),
      batchNo: r.batchNo,
      quantity: r.quantity,
    }));
  return {
    expiredCount,
    criticalCount,
    warningCount,
    holdCount: ws.inventory.listHolds().length,
    negativeCount: negativeBuckets.length,
    negativeBuckets,
  };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
