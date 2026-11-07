import type { WmsWorkspace } from '../wms.js';
import { OrderNotFoundError, ReturnDisabledError, ReturnOfReturnError, ReturnNotPostedError } from '../errors.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import { quantizeQty } from '../state/inventory-policy.js';
import { accountedQty, remainingBySkuBatch, sourceIsPosted } from '../state/return-qty.js';

/** 一张原单还能退多少。按 SKU + 批次一行，库位是建议值（原单上该批次入账最多的库位）。 */
export interface ReturnableLine {
  skuCode: string;
  name: string;
  unit: string | null;
  batchNo: string;
  batchExpiryDate: string | null;
  locationCode: string;
  postedQty: number;
  remaining: number;
}

export interface ReturnableView {
  sourceOrderNo: string;
  sourceDirection: OrderDirection;
  /** 要开的退货单方向：客退 in，退供 out */
  direction: OrderDirection;
  lines: ReturnableLine[];
}

export function getReturnable(ws: WmsWorkspace, orderNo: string): ReturnableView {
  if (ws.profile.getSnapshot().modules['module.return']?.enabled !== true) {
    throw new ReturnDisabledError();
  }
  const source = ws.orders.byNo(orderNo);
  if (!source) throw new OrderNotFoundError(orderNo);
  if (source.returnOfOrderId) throw new ReturnOfReturnError(source.orderNo);
  if (!sourceIsPosted(source.direction, source.state)) {
    throw new ReturnNotPostedError(source.orderNo, source.state);
  }
  const sourceLines = ws.orders.lines(source.id);
  const prior = ws.orders.returnsOf(source.id).map((order) => ({
    state: order.state,
    lines: ws.orders.lines(order.id),
  }));
  const left = remainingBySkuBatch(sourceLines, prior);
  const grouped = new Map<
    string,
    {
      skuId: string;
      batchNo: string;
      posted: number;
      best: number;
      locationId: string;
      expiry: string | null;
    }
  >();
  for (const line of sourceLines) {
    const key = `${line.skuId}\u0000${line.batchNo}`;
    const posted = accountedQty(line.quantity, line.fulfilledQty);
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, {
        skuId: line.skuId,
        batchNo: line.batchNo,
        posted,
        best: posted,
        locationId: line.locationId,
        expiry: line.batchExpiryDate,
      });
      continue;
    }
    prev.posted += posted;
    if (posted > prev.best) {
      prev.best = posted;
      prev.locationId = line.locationId;
    }
    if (!prev.expiry && line.batchExpiryDate) prev.expiry = line.batchExpiryDate;
  }
  const lines: ReturnableLine[] = [];
  for (const [key, row] of grouped) {
    const sku = ws.skus.byId(row.skuId);
    const location = ws.locations.byId(row.locationId);
    const remain = left.get(key) ?? 0;
    // 出库单行不带效期。客退要沿用入库时登记的效期，从流水里补。
    const expiry = row.expiry ?? ws.inventory.expiryOfBatch(row.skuId, row.batchNo);
    lines.push({
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      unit: sku?.unit ?? null,
      batchNo: row.batchNo,
      batchExpiryDate: expiry,
      locationCode: location?.locationCode ?? row.locationId,
      postedQty: quantizeQty(row.posted),
      remaining: remain > 0 ? quantizeQty(remain) : 0,
    });
  }
  return {
    sourceOrderNo: source.orderNo,
    sourceDirection: source.direction,
    direction: source.direction === 'in' ? 'out' : 'in',
    lines,
  };
}
