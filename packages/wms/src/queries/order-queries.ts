import type { WmsWorkspace } from '../wms.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import type { OrderRecord } from '../views/order-view.js';

/** 单据 + 明细行（联查 SKU 补编码/名称 + 往来单位补编码/名称，组装不碰 SQL） */
export interface OrderWithLines extends OrderRecord {
  lines: {
    skuCode: string;
    name: string;
    quantity: number;
    /** 行目标库位编码（M21：上架归位的源桶维度） */
    locationCode: string;
    /** 行批次（DEFAULT = 虚拟批次） */
    batchNo: string;
  }[];
  /** 往来单位展示（M21）：null = 未关联 */
  partnerCode: string | null;
  partnerName: string | null;
}

/** 明细行联查：skuId → skuCode/name + partnerId → 编码/名称（经视图 API，不碰 SQL） */
export function withOrderLines(ws: WmsWorkspace, order: OrderRecord): OrderWithLines {
  const lines = ws.orders.lines(order.id).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    const location = ws.locations.byId(line.locationId);
    return {
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      quantity: line.quantity,
      locationCode: location?.locationCode ?? line.locationId,
      batchNo: line.batchNo,
    };
  });
  const partner = order.partnerId ? ws.partners.byId(order.partnerId) : undefined;
  return {
    ...order,
    lines,
    partnerCode: partner?.partnerCode ?? null,
    partnerName: partner?.name ?? null,
  };
}

export function listOrdersWithLines(
  ws: WmsWorkspace,
  direction?: OrderDirection,
): OrderWithLines[] {
  return ws.orders.list(direction).map((order) => withOrderLines(ws, order));
}
