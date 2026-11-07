import type { WmsWorkspace } from '../wms.js';
import { DEFAULT_BATCH_NO, DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { BatchExpiryMismatchError, LocationNotFoundError } from '../errors.js';

/**
 * 库位解析（M10）：缺省/显式 DEFAULT → 虚拟桶（不占 wms_location 表）；
 * 否则查实体库位，未建即拒。所有携带库位的命令共用这一个口子。
 */
export function resolveLocation(
  ws: WmsWorkspace,
  code: string | undefined,
): { locationId: string; locationCode: string } {
  if (!code || code === DEFAULT_LOCATION_ID) {
    return { locationId: DEFAULT_LOCATION_ID, locationCode: DEFAULT_LOCATION_ID };
  }
  const loc = ws.locations.byCode(code);
  if (!loc) throw new LocationNotFoundError(code);
  return { locationId: loc.id, locationCode: loc.locationCode };
}

/** 行库位 id → 编码（审计/返回值显示；DEFAULT 虚拟桶直通，实体缺失兜底 id） */
export function codeOfLocation(ws: WmsWorkspace, locationId: string): string {
  if (locationId === DEFAULT_LOCATION_ID) return DEFAULT_LOCATION_ID;
  return ws.locations.byId(locationId)?.locationCode ?? locationId;
}

/**
 * 批次解析（M11）：缺省/空串 → 虚拟批次 DEFAULT（不携带效期）；显式 DEFAULT
 * 批次 + 效期 → 拒（保留词语义纯净——它是「未指定批次」的归宿，不是真批次）。
 * 批次随首条流水诞生（无实体表），显式批次号本身无需存在性校验。
 */
export function resolveBatch(
  batchNo: string | undefined,
  batchExpiryDate: string | undefined,
): { batchNo: string; batchExpiryDate?: string } {
  if (!batchNo || batchNo === DEFAULT_BATCH_NO) {
    if (batchExpiryDate) {
      throw new Error('TOOL_REJECTED: DEFAULT 是虚拟批次（未指定批次的归宿），不携带效期');
    }
    return { batchNo: DEFAULT_BATCH_NO };
  }
  return { batchNo, batchExpiryDate };
}

/**
 * 批次效期一致性（M11）：同 (SKU, 批次) 首个非空效期登记后，后继流水必须一致。
 * 未登记（null）→ 放行（首条登记或后补）；不一致 → BatchExpiryMismatchError。
 * 只对带效期的真批次调用（DEFAULT 已在 resolveBatch 挡掉效期）。
 */
export function assertExpiryConsistent(
  ws: WmsWorkspace,
  skuId: string,
  skuCode: string,
  batchNo: string,
  expiryDate: string | undefined,
): void {
  if (!expiryDate) return;
  const known = ws.inventory.expiryOfBatch(skuId, batchNo);
  if (known !== null && known !== expiryDate) {
    throw new BatchExpiryMismatchError(skuCode, batchNo, known, expiryDate);
  }
}

/** 过期判定（M13）：效期早于今日（UTC）= 过期；今天到期 = 临期可出（ISO 日期字典序即时间序）。
 *  类型谓词：true ⇒ 效期非空（拦截处据此收窄 expiry 供错误消息使用）。 */
export function isExpired(batchExpiryDate: string | null, today: string): batchExpiryDate is string {
  return batchExpiryDate !== null && batchExpiryDate < today;
}

// ── 小数数量（散装/称重场景）：全链路统一 3 位小数精度 ──────────────
// 数量不再要求整数（个人仓库常卖 0.5 斤瓜子、1.75 米电线），但必须收敛到
// 固定精度，否则浮点求和漂移会让余量守卫出现假性不足/假性富余。
// 铁律：入库（写路径）一律 quantize 后落事件；守卫比较一律带 QTY_EPS。

/** 数量精度：3 位小数（0.001） */
export const QTY_PRECISION = 3;
/** 守卫比较容差：浮点求和漂移吸收（远小于最小步长 0.001） */
export const QTY_EPS = 1e-9;

/** 量化到 3 位小数（入参与返回都是安全有限数的前提下调用） */
export function quantizeQty(x: number): number {
  return Math.round(x * 10 ** QTY_PRECISION) / 10 ** QTY_PRECISION;
}

/** 校验并量化正数量（> 0，≤ 3 位小数）：不合法抛 TOOL_REJECTED。label 如「第 1 行数量」。 */
export function assertPositiveQty(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`TOOL_REJECTED: ${label}必须是正数（最多 ${QTY_PRECISION} 位小数，实际 ${String(value)}）`);
  }
  const q = quantizeQty(value);
  if (q <= 0) {
    throw new Error(`TOOL_REJECTED: ${label}精度超出 ${QTY_PRECISION} 位小数，量化后为 0`);
  }
  return q;
}

/** 校验并量化非负数量（≥ 0，≤ 3 位小数）：盘点实盘数等允许为零的场景。 */
export function assertNonNegativeQty(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`TOOL_REJECTED: ${label}必须是不小于 0 的数（最多 ${QTY_PRECISION} 位小数，实际 ${String(value)}）`);
  }
  return quantizeQty(value);
}

/** 校验并量化非零数量（调整 delta）：正入负出，0 与量化后为 0 都拒。 */
export function assertNonZeroQty(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    throw new Error(`TOOL_REJECTED: ${label}必须是非 0 数（正数入库，负数出库）`);
  }
  const q = quantizeQty(value);
  if (q === 0) {
    throw new Error(`TOOL_REJECTED: ${label}精度超出 ${QTY_PRECISION} 位小数，量化后为 0`);
  }
  return q;
}

/** 余量守卫错误消息的桶标识：DEFAULT 批次不加批次后缀（与 M10 消息逐字节兼容） */
export function bucketLabel(skuCode: string, locationCode: string, batchNo: string): string {
  return batchNo === DEFAULT_BATCH_NO
    ? `${skuCode}@${locationCode}`
    : `${skuCode}@${locationCode}@${batchNo}`;
}
