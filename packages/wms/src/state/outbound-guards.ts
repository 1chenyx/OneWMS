import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { bucketLabel, codeOfLocation, isExpired, QTY_EPS } from './inventory-policy.js';
import { ExpiredBatchError, InsufficientStockError, StockHeldError, StockReservedError } from '../errors.js';
import { assertLooseEnough } from './lpn-policy.js';

/**
 * 出库硬守卫（M21 自 order-tools.ts 提取，行为不变——现有测试兜底）：
 *  1. 过期拦截（M13）：blockExpiredOutbound 开启时，行批次效期（以流水首个
 *     非空登记为准——出库行自身不声明效期）早于今日即拒；
 *  2. 逐桶余量（M11）：行按 (SKU, 库位, 批次) 验余量，不足即拒；
 *  3. 其他单据的拣货占用：桶余量减去别人的占用仍不足则拒；
 *  4. SKU 冻结聚合（M19）：同 SKU 多行先聚合再校验（逐行各自通过而合计
 *     超可用也要拒）；可用量 = 全库位合计余量 − 冻结合计 − 别人的占用。
 * exceptOrderIds 是正在履约的单据，它们自己的占用不算在别人头上。
 * 只拦单据出库（order-tools 的 transition 与 picking 的 close）——调整/移库/
 * 盘点修正是物理修正通道，不拦。纯校验（不落事件），拒绝发生在落账前。
 */

export interface OutboundBucketLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

/**
 * 按行验桶余量，可选过期拦截与 SKU 冻结。
 * 出库履约开 expiry+hold；入库冲销只开 hold（过期拦截是履约策略，不挡回冲）。
 */
export function assertOnHand(
  ws: WmsWorkspace,
  lines: readonly OutboundBucketLine[],
  opts: { readonly expiry: boolean; readonly hold: boolean; readonly exceptOrderIds?: readonly string[] },
): void {
  const settings = readWmsSettings(ws);
  const today = new Date().toISOString().slice(0, 10);
  const except = opts.exceptOrderIds ?? [];
  for (const line of lines) {
    if (opts.expiry && settings.blockExpiredOutbound) {
      const expiry = ws.inventory.expiryOfBatch(line.skuId, line.batchNo);
      if (isExpired(expiry, today)) {
        throw new ExpiredBatchError(
          ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
          line.batchNo,
          expiry,
        );
      }
    }
    const label = bucketLabel(
      ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
      codeOfLocation(ws, line.locationId),
      line.batchNo,
    );
    const onHand = ws.inventory.quantityOf(line.skuId, line.locationId, line.batchNo);
    if (onHand + QTY_EPS < line.quantity) {
      throw new InsufficientStockError(label, -line.quantity, onHand);
    }
    assertLooseEnough(ws, {
      skuCode: ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
      skuId: line.skuId,
      locationId: line.locationId,
      locationCode: codeOfLocation(ws, line.locationId),
      batchNo: line.batchNo,
      take: line.quantity,
      onHand,
    });
    const reserved = ws.inventory.reservedOf(line.skuId, line.locationId, line.batchNo, except);
    if (onHand - reserved + QTY_EPS < line.quantity) {
      throw new StockReservedError(label, line.quantity, onHand, reserved);
    }
  }
  if (!opts.hold) return;
  const needBySku = new Map<string, number>();
  for (const line of lines) {
    needBySku.set(line.skuId, (needBySku.get(line.skuId) ?? 0) + line.quantity);
  }
  for (const [skuId, need] of needBySku) {
    const total = ws.inventory.totalOf(skuId);
    const held = ws.inventory.heldOf(skuId);
    const skuCode = ws.skus.byId(skuId)?.skuCode ?? skuId;
    if (total - held + QTY_EPS < need) {
      throw new StockHeldError(skuCode, need, total, held);
    }
    const reserved = ws.inventory.reservedOfSku(skuId, except);
    if (total - held - reserved + QTY_EPS < need) {
      throw new StockReservedError(skuCode, need, total, reserved, held);
    }
  }
}

/** 出库履约守卫：过期拦截 + 逐桶余量 + 占用 + SKU 冻结。 */
export function assertOutboundBuckets(
  ws: WmsWorkspace,
  lines: readonly OutboundBucketLine[],
  exceptOrderIds: readonly string[] = [],
): void {
  assertOnHand(ws, lines, { expiry: true, hold: true, exceptOrderIds });
}
