import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { codeOfLocation } from '../state/inventory-policy.js';

export interface InventorySummaryRow {
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  held: number;
  available: number;
  reorderPoint: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
}

/** 按 SKU 汇总库存：跨库位求和，活动冻结合计，available = 余量 − 冻结。 */
export function listInventorySummary(ws: WmsWorkspace): InventorySummaryRow[] {
  const bySku = new Map<string, Omit<InventorySummaryRow, 'available'>>();
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
    .map((row) => ({ ...row, available: row.quantity - row.held }))
    .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
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
