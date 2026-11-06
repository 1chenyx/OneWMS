import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { bucketLabel, codeOfLocation, isExpired } from './inventory-policy.js';
import { ExpiredBatchError, InsufficientStockError, StockHeldError } from '../errors.js';

/**
 * 出库硬守卫（M21 自 order-tools.ts 提取，行为不变——现有测试兜底）：
 *  1. 过期拦截（M13）：blockExpiredOutbound 开启时，行批次效期（以流水首个
 *     非空登记为准——出库行自身不声明效期）早于今日即拒；
 *  2. 逐桶余量（M11）：行按 (SKU, 库位, 批次) 验余量，不足即拒；
 *  3. SKU 冻结聚合（M19）：同 SKU 多行先聚合再校验（逐行各自通过而合计
 *     超可用也要拒）；可用量 = 全库位合计余量 − 冻结合计。
 * 只拦单据出库（order-tools 的 transition 与 picking 的 close）——调整/移库/
 * 盘点修正是物理修正通道，不拦。纯校验（不落事件），拒绝发生在落账前。
 */

export interface OutboundBucketLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

export function assertOutboundBuckets(ws: WmsWorkspace, lines: readonly OutboundBucketLine[]): void {
  const settings = readWmsSettings(ws);
  const today = new Date().toISOString().slice(0, 10);
  for (const line of lines) {
    if (settings.blockExpiredOutbound) {
      const expiry = ws.inventory.expiryOfBatch(line.skuId, line.batchNo);
      if (isExpired(expiry, today)) {
        throw new ExpiredBatchError(
          ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
          line.batchNo,
          expiry,
        );
      }
    }
    const available = ws.inventory.quantityOf(line.skuId, line.locationId, line.batchNo);
    if (available < line.quantity) {
      throw new InsufficientStockError(
        bucketLabel(
          ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
          codeOfLocation(ws, line.locationId),
          line.batchNo,
        ),
        -line.quantity,
        available,
      );
    }
  }
  const needBySku = new Map<string, number>();
  for (const line of lines) {
    needBySku.set(line.skuId, (needBySku.get(line.skuId) ?? 0) + line.quantity);
  }
  for (const [skuId, need] of needBySku) {
    const total = ws.inventory.totalOf(skuId);
    const held = ws.inventory.heldOf(skuId);
    if (total - held < need) {
      throw new StockHeldError(ws.skus.byId(skuId)?.skuCode ?? skuId, need, total, held);
    }
  }
}
