import type { WmsWorkspace } from '../wms.js';
import { OrderNotFoundError, ReturnDisabledError, ReturnOfReturnError, ReturnNotPostedError } from '../errors.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import { QTY_EPS, quantizeQty } from '../state/inventory-policy.js';
import { accountedQty, postedBucketsForReturn, remainingBySkuBatch, sourceIsPosted } from '../state/return-qty.js';

/** 一张原单还能退多少。按 SKU + 批次一行。有流水时库位取实绩里入账最多的那个；没有流水时用单据行。 */
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
  const movements = ws.inventory.movementsByOrder(source.id);
  const posted = postedBucketsForReturn(source.direction, sourceLines, movements);
  const prior = ws.orders.returnsOf(source.id).map((order) => ({
    state: order.state,
    lines: ws.orders.lines(order.id),
  }));
  const left = remainingBySkuBatch(sourceLines, prior, posted);
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
  if (movements.length === 0) {
    for (const line of sourceLines) {
      const key = `${line.skuId}\u0000${line.batchNo}`;
      const qty = accountedQty(line.quantity, line.fulfilledQty);
      const prev = grouped.get(key);
      if (!prev) {
        grouped.set(key, {
          skuId: line.skuId,
          batchNo: line.batchNo,
          posted: qty,
          best: qty,
          locationId: line.locationId,
          expiry: line.batchExpiryDate,
        });
        continue;
      }
      prev.posted += qty;
      if (qty > prev.best) {
        prev.best = qty;
        prev.locationId = line.locationId;
      }
      if (!prev.expiry && line.batchExpiryDate) prev.expiry = line.batchExpiryDate;
    }
  } else {
    for (const row of movements) {
      const qty = source.direction === 'out' ? -row.net : row.net;
      if (qty <= QTY_EPS) continue;
      const key = `${row.skuId}\u0000${row.batchNo}`;
      const prev = grouped.get(key);
      if (!prev) {
        grouped.set(key, {
          skuId: row.skuId,
          batchNo: row.batchNo,
          posted: qty,
          best: qty,
          locationId: row.locationId,
          expiry: null,
        });
        continue;
      }
      prev.posted += qty;
      if (qty > prev.best) {
        prev.best = qty;
        prev.locationId = row.locationId;
      }
    }
  }
  const lines: ReturnableLine[] = [];
  for (const [key, row] of grouped) {
    const sku = ws.skus.byId(row.skuId);
    const location = ws.locations.byId(row.locationId);
    const remain = left.get(key) ?? 0;
    const lineExpiry = sourceLines.find((line) => line.skuId === row.skuId && line.batchNo === row.batchNo)
      ?.batchExpiryDate;
    const expiry =
      movements.length === 0
        ? (row.expiry ?? ws.inventory.expiryOfBatch(row.skuId, row.batchNo))
        : (ws.inventory.expiryOfBatch(row.skuId, row.batchNo) ?? lineExpiry ?? null);
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
