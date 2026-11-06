import type { WmsWorkspace } from '../wms.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import type { OrderRecord } from '../views/order-view.js';

/** 单据 + 明细行（联查 SKU 补编码/名称，组装不碰 SQL） */
export interface OrderWithLines extends OrderRecord {
  lines: { skuCode: string; name: string; quantity: number }[];
}

/** 明细行联查：skuId → skuCode/name（经视图 API，不碰 SQL） */
export function withOrderLines(ws: WmsWorkspace, order: OrderRecord): OrderWithLines {
  const lines = ws.orders.lines(order.id).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    return {
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      quantity: line.quantity,
    };
  });
  return { ...order, lines };
}

export function listOrdersWithLines(
  ws: WmsWorkspace,
  direction?: OrderDirection,
): OrderWithLines[] {
  return ws.orders.list(direction).map((order) => withOrderLines(ws, order));
}
