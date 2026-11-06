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
