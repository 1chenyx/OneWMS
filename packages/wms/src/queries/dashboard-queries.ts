import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { getExpiryBoard, listHoldRows, listInventorySummary, listLedger } from './inventory-queries.js';

/**
 * 运营看板查询（M21）——维度各自独立函数 + 独立端点 + 独立 queryKey：
 * 后续新增维度只加函数 + 路由 + hook，不动既有维度；前端按维度独立拉取。
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

const BOARD_LIMIT = 8;

/** ⑥ 作业积压：未结束的单据计数。终态（done / canceled / completed / confirmed / closed）不计。 */
export interface DashboardWorkload {
  inboundOpen: number;
  outboundOpen: number;
  /** 拣货单仍在拣（created） */
  pickingOpen: number;
  /** 波次还没生成拣货单（open） */
  waveOpen: number;
  /** 盘点中（created） */
  stocktakeOpen: number;
  /** 调拨未完成：新建 + 在途 */
  transferOpen: number;
  /** transferOpen 里已经发货、还没收到的张数 */
  transferInTransit: number;
  /** 报损待确认（created） */
  scrapOpen: number;
}

export function getDashboardWorkload(ws: WmsWorkspace): DashboardWorkload {
  let inboundOpen = 0;
  let outboundOpen = 0;
  for (const order of ws.orders.list()) {
    if (order.state === 'done' || order.state === 'canceled') continue;
    if (order.direction === 'in') inboundOpen++;
    else outboundOpen++;
  }
  let transferOpen = 0;
  let transferInTransit = 0;
  for (const transfer of ws.transfers.list()) {
    if (transfer.state !== 'created' && transfer.state !== 'inTransit') continue;
    transferOpen++;
    if (transfer.state === 'inTransit') transferInTransit++;
  }
  return {
    inboundOpen,
    outboundOpen,
    pickingOpen: ws.pickings.list('created').length,
    waveOpen: ws.waves.list().filter((wave) => wave.state === 'open').length,
    stocktakeOpen: ws.stocktakes.list().filter((row) => row.state === 'created').length,
    transferOpen,
    transferInTransit,
    scrapOpen: ws.scraps.list().filter((row) => row.state === 'created').length,
  };
}

/** 库存集中的一行。数量是实物余量，可用量已扣冻结和拣货占用。 */
export interface DashboardSkuRank {
  skuCode: string;
  name: string;
  unit: string | null;
  quantity: number;
  available: number;
  held: number;
  reserved: number;
}

/**
 * 低库存一行。口径与 wms.inventory.lowstock 相同：
 * 在用 SKU、安全库存 > 0、可用量 = 余量 − 冻结 − 占用，且可用量低于阈值。
 * 售罄（没有任何库存桶）也在列。
 */
export interface DashboardLowStock {
  skuCode: string;
  name: string;
  unit: string | null;
  total: number;
  available: number;
  reorderPoint: number;
  shortage: number;
}

export interface DashboardHoldBrief {
  id: string;
  skuCode: string;
  name: string;
  quantity: number;
  reason: string;
  createdAt: string;
}

/** ⑦ 库存结构：可用量拆分、余量最高的 SKU、低库存、活动冻结。清单最多 8 行，计数是全量。 */
export interface DashboardStockFocus {
  /** 实物余量，负桶按 0，与总览 totalQuantity 同口径 */
  onHand: number;
  held: number;
  reserved: number;
  available: number;
  lowStockCount: number;
  lowStock: DashboardLowStock[];
  topSkus: DashboardSkuRank[];
  holds: DashboardHoldBrief[];
}

export function getDashboardStock(ws: WmsWorkspace): DashboardStockFocus {
  const inventory = ws.inventory.list();
  const onHand = inventory.reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
  const held = ws.inventory.listHolds().reduce((sum, row) => sum + row.quantity, 0);
  let reserved = 0;
  for (const sku of ws.skus.list()) reserved += ws.inventory.reservedOfSku(sku.id);
  const lowStock = listLowStock(ws);
  const holds = listHoldRows(ws)
    .sort((a, b) => b.quantity - a.quantity || a.skuCode.localeCompare(b.skuCode))
    .slice(0, BOARD_LIMIT)
    .map((row) => ({
      id: row.id,
      skuCode: row.skuCode,
      name: row.name,
      quantity: row.quantity,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
  const topSkus = listInventorySummary(ws)
    .filter((row) => row.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || a.skuCode.localeCompare(b.skuCode))
    .slice(0, BOARD_LIMIT)
    .map((row) => ({
      skuCode: row.skuCode,
      name: row.name,
      unit: row.unit,
      quantity: row.quantity,
      available: row.available,
      held: row.held,
      reserved: row.reserved,
    }));
  return {
    onHand,
    held,
    reserved,
    available: onHand - held - reserved,
    lowStockCount: lowStock.length,
    lowStock: lowStock.slice(0, BOARD_LIMIT),
    topSkus,
    holds,
  };
}

function listLowStock(ws: WmsWorkspace): DashboardLowStock[] {
  const rows: DashboardLowStock[] = [];
  for (const sku of ws.skus.list()) {
    if (!(sku.reorderPoint > 0)) continue;
    if ((sku.status ?? 'active') !== 'active') continue;
    const total = ws.inventory.totalOf(sku.id);
    const held = ws.inventory.heldOf(sku.id);
    const reserved = ws.inventory.reservedOfSku(sku.id);
    const available = total - held - reserved;
    if (!(available < sku.reorderPoint)) continue;
    rows.push({
      skuCode: sku.skuCode,
      name: sku.name,
      unit: sku.unit,
      total,
      available,
      reorderPoint: sku.reorderPoint,
      shortage: sku.reorderPoint - available,
    });
  }
  rows.sort((a, b) => b.shortage - a.shortage || a.skuCode.localeCompare(b.skuCode));
  return rows;
}

/** ⑧ 最近流水。上架移库也在列（流量趋势里那对 ± 仍排除，避免虚增出入库）。 */
export interface DashboardActivityRow {
  eventId: string;
  skuCode: string;
  name: string;
  locationCode: string;
  batchNo: string;
  delta: number;
  reason: string;
  orderNo: string | null;
  createdAt: string;
}

export function getDashboardActivity(ws: WmsWorkspace, limit = 12): DashboardActivityRow[] {
  const n = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 12;
  return listLedger(ws, { limit: n }).map((row) => ({
    eventId: row.eventId,
    skuCode: row.skuCode,
    name: row.name,
    locationCode: row.locationCode,
    batchNo: row.batchNo,
    delta: row.delta,
    reason: row.reason,
    orderNo: row.orderNo,
    createdAt: row.createdAt,
  }));
}

/** ⑨ 临期与过期批次（不含安全、未登记）。已按效期升序，最多 8 行。 */
export interface DashboardUrgentRow {
  skuCode: string;
  name: string;
  batchNo: string;
  batchExpiryDate: string;
  daysLeft: number;
  level: 'expired' | 'critical' | 'warning';
  quantity: number;
  unit: string | null;
}

export function getDashboardUrgent(ws: WmsWorkspace): DashboardUrgentRow[] {
  const rows: DashboardUrgentRow[] = [];
  for (const row of getExpiryBoard(ws).rows) {
    if (row.level !== 'expired' && row.level !== 'critical' && row.level !== 'warning') continue;
    if (row.batchExpiryDate === null || row.daysLeft === null) continue;
    rows.push({
      skuCode: row.skuCode,
      name: row.name,
      batchNo: row.batchNo,
      batchExpiryDate: row.batchExpiryDate,
      daysLeft: row.daysLeft,
      level: row.level,
      quantity: row.quantity,
      unit: row.unit,
    });
    if (rows.length >= BOARD_LIMIT) break;
  }
  return rows;
}
