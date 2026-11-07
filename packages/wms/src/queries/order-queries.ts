import type { WmsWorkspace } from '../wms.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import type { OrderRecord } from '../views/order-view.js';

/** 单据 + 明细行（联查 SKU 补编码/名称/单位 + 往来单位补编码/名称，组装不碰 SQL） */
export interface OrderWithLines extends OrderRecord {
  lines: {
    skuCode: string;
    name: string;
    quantity: number;
    /** 已入账净量。null = 没记过短收短发（按订单数量） */
    fulfilledQty: number | null;
    /** 数量单位（A3）：null = 不显示 */
    unit: string | null;
    /** 行目标库位编码（M21：上架归位的源桶维度） */
    locationCode: string;
    /** 行批次（DEFAULT = 虚拟批次） */
    batchNo: string;
    /** 行批次效期（A1 打印凭据用）：null = 未声明（OrderLineRecord 有但此前未映射） */
    batchExpiryDate: string | null;
  }[];
  /** 往来单位展示（M21）：null = 未关联 */
  partnerCode: string | null;
  partnerName: string | null;
}

/** 明细行联查：skuId → skuCode/name/unit + partnerId → 编码/名称（经视图 API，不碰 SQL） */
export function withOrderLines(ws: WmsWorkspace, order: OrderRecord): OrderWithLines {
  const lines = ws.orders.lines(order.id).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    const location = ws.locations.byId(line.locationId);
    return {
      skuCode: sku?.skuCode ?? '(未知)',
      name: sku?.name ?? '',
      quantity: line.quantity,
      fulfilledQty: line.fulfilledQty,
      unit: sku?.unit ?? null,
      locationCode: location?.locationCode ?? line.locationId,
      batchNo: line.batchNo,
      batchExpiryDate: line.batchExpiryDate ?? null,
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
