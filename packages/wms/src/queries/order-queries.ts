import type { WmsWorkspace } from '../wms.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import type { OrderRecord } from '../views/order-view.js';
import { toListPage, type ListPage } from './page.js';

/** 单据 + 明细行（联查 SKU 补编码/名称/单位 + 往来单位补编码/名称，组装不碰 SQL） */
export interface OrderWithLines extends OrderRecord {
  lines: {
    skuCode: string;
    name: string;
    quantity: number;
    /** 已入账净量。null = 没记过短收短发（按订单数量） */
    fulfilledQty: number | null;
    /**
     * 录入快照（包装换算）：开单时的原录入（如 2 / 箱）。null = 按基本单位录入；
     * quantity 恒为换算后的基本单位数量
     */
    enteredQty: number | null;
    enteredUnit: string | null;
    /** 数量单位（A3）：null = 不显示。换算语境下是基本单位 */
    unit: string | null;
    /** 行目标库位编码（M21：上架归位的源桶维度） */
    locationCode: string;
    /** 行批次（DEFAULT = 虚拟批次） */
    batchNo: string;
    /** 库位所属仓库。DEFAULT 和未分仓都是 null */
    warehouseCode: string | null;
    /** 这行货要按件扫序列号 */
    serialTracked: boolean;
    /** 行批次效期（A1 打印凭据用）：null = 未声明（OrderLineRecord 有但此前未映射） */
    batchExpiryDate: string | null;
    /** 序列号。没有时不出现 */
    serials?: readonly string[];
  }[];
  /** 往来单位展示（M21）：null = 未关联 */
  partnerCode: string | null;
  partnerName: string | null;
  /** 原单号（module.return）。null = 普通出入库 */
  returnOfOrderNo: string | null;
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
      enteredQty: line.enteredQty,
      enteredUnit: line.enteredUnit,
      unit: sku?.unit ?? null,
      locationCode: location?.locationCode ?? line.locationId,
      warehouseCode: (location?.warehouseId ? ws.warehouses.byId(location.warehouseId)?.warehouseCode : undefined) ?? null,
      batchNo: line.batchNo,
      batchExpiryDate: line.batchExpiryDate ?? null,
      serialTracked: sku?.serialTracked === true,
      ...(line.serials && line.serials.length > 0 ? { serials: line.serials } : {}),
    };
  });
  const partner = order.partnerId ? ws.partners.byId(order.partnerId) : undefined;
  const source = order.returnOfOrderId ? ws.orders.byId(order.returnOfOrderId) : undefined;
  return {
    ...order,
    lines,
    partnerCode: partner?.partnerCode ?? null,
    partnerName: partner?.name ?? null,
    returnOfOrderNo: source?.orderNo ?? null,
  };
}

export function listOrdersWithLines(
  ws: WmsWorkspace,
  direction?: OrderDirection,
): OrderWithLines[] {
  return ws.orders.list(direction).map((order) => withOrderLines(ws, order));
}

/**
 * 界面清单分页。不传 sort 时仍是更新时间倒序。
 * states、sort、warehouseId 给现场列表用，桌面不传就和以前一样。
 * 仓库条件在 LIMIT 之前，避免把别的仓的单算进 hasMore。
 */
export function listOrdersWithLinesPage(
  ws: WmsWorkspace,
  opts: {
    direction?: OrderDirection;
    q?: string;
    states?: string[];
    sort?: 'updatedAtAsc';
    warehouseId?: string;
    includeUnassigned?: boolean;
    limit: number;
    offset: number;
  },
): ListPage<OrderWithLines> {
  const { rows, total } = ws.orders.listPageByNo(opts);
  return toListPage(
    rows.map((order) => withOrderLines(ws, order)),
    total,
    opts.limit,
    opts.offset,
  );
}
