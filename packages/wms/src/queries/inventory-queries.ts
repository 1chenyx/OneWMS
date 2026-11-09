import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { codeOfLocation, resolveLocation } from '../state/inventory-policy.js';
import { toListPage, type ListPage } from './page.js';
import { assertWarehouseEnabled } from './warehouse-queries.js';

export interface InventorySummaryRow {
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  held: number;
  /** 其他出库单的拣货占用合计。可用量 = 余量 − 冻结 − 占用。 */
  reserved: number;
  available: number;
  reorderPoint: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
}

/** 按 SKU 汇总库存：跨库位求和。available = 余量 − 冻结 − 拣货占用。 */
export function listInventorySummary(ws: WmsWorkspace): InventorySummaryRow[] {
  const bySku = new Map<string, Omit<InventorySummaryRow, 'available' | 'reserved'>>();
  for (const row of ws.inventory.list()) {
    const sku = ws.skus.byId(row.skuId);
    const current = bySku.get(row.skuId) ?? {
      skuId: row.skuId,
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      quantity: 0,
      held: 0,
      reorderPoint: sku?.reorderPoint ?? 0,
      unit: sku?.unit ?? null,
    };
    current.quantity += row.quantity;
    bySku.set(row.skuId, current);
  }
  for (const hold of ws.inventory.listHolds()) {
    const current = bySku.get(hold.skuId);
    if (current) current.held += hold.quantity;
  }
  return [...bySku.values()]
    .map((row) => {
      const reserved = ws.inventory.reservedOfSku(row.skuId);
      return { ...row, reserved, available: row.quantity - row.held - reserved };
    })
    .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
}

export interface InventorySummaryPage extends ListPage<InventorySummaryRow> {
  /** 全库是否还有占用行。分页后当前页可能看不到，列仍要留。 */
  hasReserved: boolean;
}

/**
 * 库存汇总的 SQL 分页。口径与 listInventorySummary 相同：只含有库存行的 SKU，
 * available = 余量 − 冻结 − 占用。q 匹配编码/名称；skuCode 精确；lowOnly = 安全库存 > 0 且可用量低于阈值。
 */
export function listInventorySummaryPage(
  ws: WmsWorkspace,
  opts: { q?: string; skuCode?: string; lowOnly?: boolean; limit: number; offset: number },
): InventorySummaryPage {
  const { rows, total, hasReserved } = ws.inventory.summaryPage(opts);
  return { ...toListPage(rows, total, opts.limit, opts.offset), hasReserved };
}

export interface LedgerRow {
  eventId: string;
  skuCode: string;
  name: string;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string | null;
  delta: number;
  reason: string;
  orderNo: string | null;
  createdAt: string;
}

/**
 * 库存流水清单（导出 / 对账用）——按时间倒序，limit 默认 500、上限 5000。
 * 流水是 append-only 的真相层，这里只做联查（SKU 编码/名称、库位编码、单据号），
 * 不聚合不修正：负库存等异常态照原样导出，让人能核账。
 * 数据源是投影的 listLedgerPage（与 AI 工具 wms.ledger.query 同一条查询），
 * 本函数只补人类可读的联查字段。
 */
export function listLedger(
  ws: WmsWorkspace,
  opts: { limit?: number; skuCode?: string } = {},
): LedgerRow[] {
  const filterSku = opts.skuCode !== undefined ? ws.skus.byCode(opts.skuCode) : undefined;
  if (opts.skuCode !== undefined && !filterSku) return []; // 未知编码 = 无流水
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 500), 1), 5000);
  const { rows } = ws.inventory.listLedgerPage({
    ...(filterSku ? { skuId: filterSku.id } : {}),
    limit,
    offset: 0,
  });
  return rows.map((r) => {
    const sku = ws.skus.byId(r.skuId);
    return {
      eventId: r.eventId,
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      // location_id 可能是虚拟桶 DEFAULT（不落库位表），codeOfLocation 原样回显
      locationCode: codeOfLocation(ws, r.locationId),
      batchNo: r.batchNo,
      batchExpiryDate: r.batchExpiryDate,
      delta: r.delta,
      reason: r.reason,
      orderNo: r.orderId ? (ws.orders.byId(r.orderId)?.orderNo ?? null) : null,
      createdAt: r.createdAt,
    };
  });
}

export interface HoldListRow {
  id: string;
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  reason: string;
  createdAt: string;
}

/** 活动冻结清单；skuCode 是过滤器，未知编码返回空清单。 */
export function listHoldRows(ws: WmsWorkspace, skuCode?: string): HoldListRow[] {
  let rows = ws.inventory.listHolds();
  if (skuCode) {
    const sku = ws.skus.byCode(skuCode);
    rows = sku ? rows.filter((hold) => hold.skuId === sku.id) : [];
  }
  return rows.map((hold) => {
    const sku = ws.skus.byId(hold.skuId);
    return {
      id: hold.id,
      skuId: hold.skuId,
      skuCode: sku?.skuCode ?? hold.skuId,
      name: sku?.name ?? '',
      quantity: hold.quantity,
      reason: hold.reason,
      createdAt: hold.createdAt,
    };
  });
}

/** 批次临期分层（后端算好，前端纯展示；今天到期未过期） */
export type ExpiryLevel = 'expired' | 'critical' | 'warning' | 'safe' | 'unknown';

/** 效期看板行：SKU × 批次聚合（余量跨库位合计 + 库位明细） */
export interface ExpiryBatchRow {
  skuId: string;
  skuCode: string;
  name: string;
  batchNo: string;
  batchExpiryDate: string | null;
  daysLeft: number | null;
  level: ExpiryLevel;
  quantity: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  buckets: { locationCode: string; quantity: number }[];
}

export interface ExpiryBoard {
  today: string;
  rows: ExpiryBatchRow[];
}

/** UTC 日期差（天）：ISO 日期字符串相减。两端均为 UTC 午夜，差恒整天 */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

function levelOf(
  batchExpiryDate: string | null,
  daysLeft: number | null,
  criticalDays: number,
  warningDays: number,
): ExpiryLevel {
  if (batchExpiryDate === null || daysLeft === null) return 'unknown';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= criticalDays) return 'critical';
  if (daysLeft <= warningDays) return 'warning';
  return 'safe';
}

/** 全仓效期看板：零余量桶不上板；阈值与出库命令同源读取 core.wms settings。 */
export function getExpiryBoard(
  ws: WmsWorkspace,
  today = new Date().toISOString().slice(0, 10),
): ExpiryBoard {
  const { expiryCriticalDays, expiryWarningDays } = readWmsSettings(ws);
  const byKey = new Map<string, ExpiryBatchRow>();
  for (const row of ws.inventory.list()) {
    if (row.quantity <= 0) continue;
    const daysLeft = row.batchExpiryDate !== null ? daysBetween(today, row.batchExpiryDate) : null;
    const key = `${row.skuId}\u0000${row.batchNo}`;
    const sku = ws.skus.byId(row.skuId);
    const locationCode = codeOfLocation(ws, row.locationId);
    const current = byKey.get(key) ?? {
      skuId: row.skuId,
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      batchNo: row.batchNo,
      batchExpiryDate: row.batchExpiryDate,
      daysLeft,
      level: levelOf(row.batchExpiryDate, daysLeft, expiryCriticalDays, expiryWarningDays),
      quantity: 0,
      unit: sku?.unit ?? null,
      buckets: [],
    };
    current.quantity += row.quantity;
    const bucket = current.buckets.find((item) => item.locationCode === locationCode);
    if (bucket) bucket.quantity += row.quantity;
    else current.buckets.push({ locationCode, quantity: row.quantity });
    byKey.set(key, current);
  }
  for (const row of byKey.values()) {
    row.buckets.sort(
      (a, b) => b.quantity - a.quantity || a.locationCode.localeCompare(b.locationCode),
    );
  }
  const rows = [...byKey.values()].sort(
    (a, b) =>
      (a.batchExpiryDate ?? '9999-12-31').localeCompare(b.batchExpiryDate ?? '9999-12-31') ||
      a.skuCode.localeCompare(b.skuCode) ||
      a.batchNo.localeCompare(b.batchNo),
  );
  return { today, rows };
}

/** 库存页的视角。sku 在带了库位、批次或仓库筛选时也走这里，只返回实物余量。 */
export type InventorySliceView = 'sku' | 'location' | 'batch' | 'warehouse';

/** 一行展开后的桶。库位 × 批次，数量是该桶余量。 */
export interface InventorySliceDetail {
  locationCode: string;
  locationName: string;
  batchNo: string;
  batchExpiryDate: string | null;
  quantity: number;
}

/**
 * 一个视角上的合计行。
 * 按库位带 location*，按批次带 batch*，按仓库带 warehouse*。
 * 未分仓的 warehouseCode 为 null，warehouseName 为「未分仓」。
 */
export interface InventorySliceRow {
  key: string;
  skuCode: string;
  name: string;
  unit: string | null;
  quantity: number;
  locationCode?: string;
  locationName?: string;
  batchNo?: string;
  batchExpiryDate?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  details: InventorySliceDetail[];
}

export interface InventorySlicePage extends ListPage<InventorySliceRow> {
  view: InventorySliceView;
}

interface SliceFact {
  skuId: string;
  skuCode: string;
  name: string;
  unit: string | null;
  locationId: string;
  locationCode: string;
  locationName: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  batchNo: string;
  batchExpiryDate: string | null;
  quantity: number;
}

/**
 * 按视角把库存桶收成页。
 * 数量只加总实物余量，不含冻结和拣货占用。零余量的桶不出现，负数仍留下。
 * 仓库不是库存键：按仓库时把库位上的 warehouseId 加总，DEFAULT 和未划仓的库位归「未分仓」。
 * warehouseId 为 undefined 表示不按仓库收；null 表示只看未分仓。这两种和 view=warehouse 都要求多仓开着。
 */
export function listInventorySlices(
  ws: WmsWorkspace,
  opts: {
    view: InventorySliceView;
    q?: string;
    locationCode?: string;
    batchNo?: string;
    warehouseId?: string | null;
    limit: number;
    offset: number;
  },
): InventorySlicePage {
  ws.sync();
  if (opts.view === 'warehouse' || opts.warehouseId !== undefined) assertWarehouseEnabled(ws);
  const locationId = opts.locationCode ? resolveLocation(ws, opts.locationCode).locationId : undefined;
  const batchNo = opts.batchNo?.trim() || undefined;
  const needle = opts.q?.trim().toLowerCase() ?? '';
  const groups = new Map<string, SliceFact[]>();
  for (const row of ws.inventory.list()) {
    if (row.quantity === 0) continue;
    if (locationId !== undefined && row.locationId !== locationId) continue;
    if (batchNo !== undefined && row.batchNo !== batchNo) continue;
    const fact = sliceFact(ws, row);
    if (opts.warehouseId !== undefined && fact.warehouseId !== opts.warehouseId) continue;
    if (needle && !fact.skuCode.toLowerCase().includes(needle) && !fact.name.toLowerCase().includes(needle)) continue;
    const key = sliceGroupKey(opts.view, fact);
    const list = groups.get(key);
    if (list) list.push(fact);
    else groups.set(key, [fact]);
  }
  const rows = [...groups.values()]
    .map((facts) => sliceRow(opts.view, facts))
    .sort((a, b) => compareSliceRows(opts.view, a, b));
  return { view: opts.view, ...toListPage(rows.slice(opts.offset, opts.offset + opts.limit), rows.length, opts.limit, opts.offset) };
}

function sliceFact(
  ws: WmsWorkspace,
  row: { skuId: string; locationId: string; batchNo: string; batchExpiryDate: string | null; quantity: number },
): SliceFact {
  const sku = ws.skus.byId(row.skuId);
  const isDefault = row.locationId === DEFAULT_LOCATION_ID;
  const location = isDefault ? undefined : ws.locations.byId(row.locationId);
  const warehouse = location?.warehouseId ? ws.warehouses.byId(location.warehouseId) : undefined;
  return {
    skuId: row.skuId,
    skuCode: sku?.skuCode ?? '(未知)',
    name: sku?.name ?? '',
    unit: sku?.unit ?? null,
    locationId: row.locationId,
    locationCode: isDefault ? DEFAULT_LOCATION_ID : (location?.locationCode ?? row.locationId),
    locationName: isDefault ? '默认库位' : (location?.name ?? '(未知库位)'),
    warehouseId: location?.warehouseId ?? null,
    warehouseCode: warehouse?.warehouseCode ?? (location?.warehouseId ? location.warehouseId : null),
    warehouseName: warehouse?.name ?? null,
    batchNo: row.batchNo,
    batchExpiryDate: row.batchExpiryDate,
    quantity: row.quantity,
  };
}

function sliceGroupKey(view: InventorySliceView, fact: SliceFact): string {
  if (view === 'location') return `${fact.skuId}\u0000${fact.locationId}`;
  if (view === 'batch') return `${fact.skuId}\u0000${fact.batchNo}`;
  if (view === 'warehouse') return `${fact.warehouseId ?? ''}\u0000${fact.skuId}`;
  return fact.skuId;
}

function sliceRow(view: InventorySliceView, facts: SliceFact[]): InventorySliceRow {
  const head = facts[0]!;
  const details = facts
    .map((fact) => ({
      locationCode: fact.locationCode,
      locationName: fact.locationName,
      batchNo: fact.batchNo,
      batchExpiryDate: fact.batchExpiryDate,
      quantity: fact.quantity,
    }))
    .sort((a, b) => a.locationCode.localeCompare(b.locationCode) || a.batchNo.localeCompare(b.batchNo));
  const expiry = details.find((detail) => detail.batchExpiryDate)?.batchExpiryDate ?? null;
  const row: InventorySliceRow = {
    key: sliceGroupKey(view, head),
    skuCode: head.skuCode,
    name: head.name,
    unit: head.unit,
    quantity: facts.reduce((sum, fact) => sum + fact.quantity, 0),
    details,
  };
  if (view === 'location') {
    row.locationCode = head.locationCode;
    row.locationName = head.locationName;
  } else if (view === 'batch') {
    row.batchNo = head.batchNo;
    row.batchExpiryDate = expiry;
  } else if (view === 'warehouse') {
    row.warehouseCode = head.warehouseCode;
    row.warehouseName = head.warehouseId ? (head.warehouseName ?? '(未知仓库)') : '未分仓';
  }
  return row;
}

function compareSliceRows(view: InventorySliceView, a: InventorySliceRow, b: InventorySliceRow): number {
  if (view === 'location') {
    return (a.locationCode ?? '').localeCompare(b.locationCode ?? '') || a.skuCode.localeCompare(b.skuCode);
  }
  if (view === 'batch') {
    return a.skuCode.localeCompare(b.skuCode) || (a.batchNo ?? '').localeCompare(b.batchNo ?? '');
  }
  if (view === 'warehouse') {
    const warehouseOrder =
      (a.warehouseCode ?? '\uffff').localeCompare(b.warehouseCode ?? '\uffff');
    return warehouseOrder || a.skuCode.localeCompare(b.skuCode);
  }
  return a.skuCode.localeCompare(b.skuCode);
}
