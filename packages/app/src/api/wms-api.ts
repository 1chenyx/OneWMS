import type { ListPage } from './page';
import { request } from './request';

/** 与 @one/wms 的 SkuRecord 同形（前端不依赖 wms 包类型，只镜像 HTTP 契约） */
export interface Sku {
  id: string;
  skuCode: string;
  /** 条码（M18）：null = 未设置；同库唯一（扫码枪识读） */
  barcode: string | null;
  /** 安全库存（M20）：低库存预警阈值；0 = 不预警 */
  reorderPoint: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  /** 档案状态（A2 软停用）：'archived' = 已停用（默认隐藏）；缺省 = 启用 */
  status?: string;
  name: string;
  /** 按序列号管理。缺省或 false = 只记数量。仅 module.serial 开启时有意义 */
  serialTracked?: boolean;
  extData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrderLine {
  skuCode: string;
  name: string;
  quantity: number;
  /** 数量单位（A3）：null = 不显示 */
  unit?: string | null;
  /** 行目标库位编码（M21：上架归位的源桶） */
  locationCode?: string;
  /** 行批次（DEFAULT = 虚拟批次） */
  batchNo?: string;
  /** 行批次效期（A1 打印凭据）：null = 未声明 */
  batchExpiryDate?: string | null;
  /** 已入账净量。null = 没记过短收短发（按订单数量） */
  fulfilledQty?: number | null;
  /** 这一行的序列号。仅按件管理、且 module.serial 开启时才有 */
  serials?: string[];
}

export interface Order {
  id: string;
  orderNo: string;
  direction: 'in' | 'out';
  state: string;
  /** 往来单位展示（M21）：入库=供应商 / 出库=客户；null = 未关联 */
  partnerCode: string | null;
  partnerName: string | null;
  note: string | null;
  /** 原单号。有值表示这张单是退货 */
  returnOfOrderNo?: string | null;
  /** 预计到货日。有值表示这张入库单是到货预报 */
  expectedAt?: string | null;
  /** 补货单。true = 按安全库存缺口开出的入库单 */
  replenishment?: boolean;
  createdAt: string;
  updatedAt: string;
  lines: OrderLine[];
}

/** GET /api/replenishment */
export interface ReplenishmentSuggestion {
  skuCode: string;
  name: string;
  unit: string | null;
  total: number;
  held: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  inboundOpen: number;
  suggestedQty: number;
}

/** GET /api/orders/:orderNo/returnable */
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
  sourceDirection: 'in' | 'out';
  direction: 'in' | 'out';
  lines: ReturnableLine[];
}

/** 往来单位（M21，GET /api/partners；供应商/客户统一档案，kind 区分） */
export interface Partner {
  id: string;
  partnerCode: string;
  kind: 'supplier' | 'customer';
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  extData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 拣货单（M21，GET /api/pickings）：聚合「拣货中」出库单的作业单 */
export interface Picking {
  id: string;
  pickingNo: string;
  /** 'created'（拣货中）/ 'closed'（已关单）/ 'canceled'（已取消）——固定生命周期 */
  state: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PickingLine[];
}

export interface PickingLine {
  id: string;
  orderId: string;
  orderNo: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  /** 数量单位（A3）：null = 不显示 */
  unit?: string | null;
  qtyToPick: number;
  suggestedLocationCode: string;
  suggestedBatchNo: string;
  /** 累计实拣量（0 = 未拣） */
  pickedQty: number;
  /** 实拣桶（null = 未拣 / 用建议桶） */
  pickedLocationCode: string | null;
  pickedBatchNo: string | null;
  /** 一行拆成多桶时的实绩。没有拆桶时可以不带 */
  allocations?: { locationCode: string; batchNo: string; quantity: number }[];
}

// ── 运营看板（M21）：五维度独立类型/端点/queryKey，便于后续扩展新维度 ──

export interface DashboardOverview {
  skuCount: number;
  totalQuantity: number;
  openOrderCount: number;
  locationCount: number;
  locationUsedCount: number;
  openPickingCount: number;
  activeHoldCount: number;
  expiringSoonCount: number;
}

export interface FlowTrendPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export interface LocationDistribution {
  locationCode: string;
  quantity: number;
}

export interface OrderStateCount {
  direction: 'in' | 'out';
  state: string;
  count: number;
}

export interface AlertSummary {
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  holdCount: number;
  negativeCount: number;
  negativeBuckets: { skuCode: string; locationCode: string; batchNo: string; quantity: number }[];
}

export interface InventoryRow {
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  /** 活动冻结合计（M19） */
  held: number;
  /** 拣货占用。缺省当 0。available = quantity − held − reserved */
  reserved?: number;
  available: number;
  /** 安全库存（M20）：>0 且 available < 它 → 低库存预警（前端标红/过滤） */
  reorderPoint: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
}

/** 库存页视角。按库位 / 批次 / 仓库，或按 SKU 但带了维度筛选。 */
export type InventorySliceView = 'sku' | 'location' | 'batch' | 'warehouse';

/** 视角行展开后的一桶。 */
export interface InventorySliceDetail {
  locationCode: string;
  locationName: string;
  batchNo: string;
  batchExpiryDate: string | null;
  quantity: number;
}

/** 一个视角上的合计。只含实物余量，没有冻结、预占、可用量。 */
export interface InventorySliceRow {
  key: string;
  skuCode: string;
  name: string;
  unit: string | null;
  quantity: number;
  locationCode?: string;
  locationName?: string;
  batchNo?: string;
  batchExpiryDate?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  details: InventorySliceDetail[];
}

export interface InventorySlicePage extends ListPage<InventorySliceRow> {
  view: InventorySliceView;
}

/** 库存分桶明细行（GET /api/inventory/buckets；Excel 导出到桶粒度用） */
export interface InventoryBucketRow {
  skuCode: string;
  name: string;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string | null;
  quantity: number;
}

/** 库存流水行（GET /api/inventory/ledger；append-only 真相层，倒序） */
export interface LedgerRow {
  eventId: string;
  skuCode: string;
  name: string;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string | null;
  delta: number;
  reason: string;
  orderNo: string | null;
  createdAt: string;
}

/** 活动冻结行（M19，GET /api/holds；已释放的不在列——历史在事件账本） */
export interface Hold {
  id: string;
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  reason: string;
  createdAt: string;
}

/** 库位（GET /api/locations。未分仓时仓库字段为空；DEFAULT 虚拟桶不在列） */
export interface Location {
  id: string;
  locationCode: string;
  name: string;
  warehouseId?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  /** 库位最多放多少。不填表示不限 */
  capacity?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 仓库（GET /api/warehouses）。库位的上一层，不是库存桶。 */
export interface Warehouse {
  id: string;
  warehouseCode: string;
  name: string;
  locationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseStockRow {
  skuCode: string;
  name: string;
  unit: string | null;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

export interface WarehouseStock {
  warehouseCode: string;
  name: string;
  rows: WarehouseStockRow[];
}

/** 序列号（GET /api/serials）。lpnCode 只有装在托盘上才有。 */
export interface SerialRow {
  serialNo: string;
  skuCode: string;
  locationCode: string;
  batchNo: string;
  status: 'in' | 'out';
  lpnCode?: string;
}

/** 托盘清单（GET /api/lpns）。 */
export interface LpnRow {
  lpnCode: string;
  locationCode: string;
  lineCount: number;
}

export interface LpnStockLine {
  skuCode: string;
  batchNo: string;
  quantity: number;
}

/** 某个托盘上装了什么（GET /api/lpns/:code/stock）。 */
export interface LpnStock {
  lpnCode: string;
  locationCode: string;
  lines: LpnStockLine[];
}

/** 盘点单清单行（GET /api/stocktakes；scope 是编码展示，'全场' = 全仓） */
export interface Stocktake {
  id: string;
  stocktakeNo: string;
  state: string;
  locationIds: string[] | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  scope: string[] | '全场';
  lineCount: number;
  countedCount: number;
}

/** 盘点明细行：expectedQty 创建时点账面快照；bookQty 当前账面；delta 实盘 − 当前账面 */
export interface StocktakeLine {
  skuCode: string;
  name: string;
  locationCode: string;
  batchNo: string;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  expectedQty: number;
  countedQty: number | null;
  bookQty: number;
  delta: number | null;
}

export type StocktakeDetail = Stocktake & { lines: StocktakeLine[] };

/** wms.stocktake.close 响应：差异摘要（零差行不入列） */
export interface StocktakeCloseResult {
  stocktakeNo: string;
  state: string;
  totalLines: number;
  adjustedLines: number;
  adjustments: {
    skuCode: string;
    locationCode: string;
    batchNo: string;
    expectedQty: number;
    countedQty: number;
    bookQty: number;
    delta: number;
  }[];
}

/** 与 server 的 ExpiryLevel 同形（前端镜像 HTTP 契约，不依赖 server 包类型） */
export type ExpiryLevel = 'expired' | 'critical' | 'warning' | 'safe' | 'unknown';

/** 看板行：SKU × 批次 聚合（余量跨库位合计；level/daysLeft 由后端算好） */
export interface ExpiryBatchRow {
  skuId: string;
  skuCode: string;
  name: string;
  batchNo: string;
  batchExpiryDate: string | null;
  /** 距今天数：已过期为负、今天为 0、未登记为 null */
  daysLeft: number | null;
  level: ExpiryLevel;
  quantity: number;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  /** 库位 × 余量明细（后端按余量降序）——行展开直出 */
  buckets: { locationCode: string; quantity: number }[];
}

/** 库存汇总分页。hasReserved 表示全库还有占用，不限于当前页。 */
export interface InventoryListPage extends ListPage<InventoryRow> {
  hasReserved: boolean;
}

/** GET /api/inventory/expiry 响应（today 供前端展示「截至」语境） */
export interface ExpiryBoard {
  today: string;
  rows: ExpiryBatchRow[];
}

/**
 * SKU 清单：q = 编码/名称/条码 模糊搜索（M18）；barcode = 条码精确匹配（不过滤停用）。
 * A2 软停用：默认只回启用档；includeArchived = 回全量（SKU 管理页勾选「显示已停用」时用）。
 * 不传 limit 时是全量数组；传入 limit 时是分页信封。
 */
function skus(query?: {
  q?: string;
  barcode?: string;
  includeArchived?: boolean;
}): Promise<Sku[]>;
function skus(query: {
  q?: string;
  barcode?: string;
  includeArchived?: boolean;
  limit: number;
  offset?: number;
}): Promise<ListPage<Sku>>;
function skus(query?: {
  q?: string;
  barcode?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Sku[] | ListPage<Sku>> {
  const params = new URLSearchParams();
  if (query?.q) params.set('q', query.q);
  if (query?.barcode) params.set('barcode', query.barcode);
  if (query?.includeArchived) params.set('includeArchived', '1');
  writePage(params, query);
  const qs = params.toString();
  return request<Sku[] | ListPage<Sku>>(qs ? `/api/skus?${qs}` : '/api/skus');
}

/** 不传 limit 时是全量数组；传入 limit 时按单号分页。 */
function orders(direction?: 'in' | 'out'): Promise<Order[]>;
function orders(
  direction: 'in' | 'out' | undefined,
  page: { q?: string; limit: number; offset?: number },
): Promise<ListPage<Order>>;
function orders(
  direction?: 'in' | 'out',
  page?: { q?: string; limit?: number; offset?: number },
): Promise<Order[] | ListPage<Order>> {
  const params = new URLSearchParams();
  if (direction) params.set('direction', direction);
  if (page?.q) params.set('q', page.q);
  writePage(params, page);
  const qs = params.toString();
  return request<Order[] | ListPage<Order>>(qs ? `/api/orders?${qs}` : '/api/orders');
}

/** 往来单位清单（M21）：kind = supplier/customer 过滤；q = 编码/名称模糊。不传 limit 时是全量数组。 */
function partners(query?: { kind?: 'supplier' | 'customer'; q?: string }): Promise<Partner[]>;
function partners(query: {
  kind?: 'supplier' | 'customer';
  q?: string;
  limit: number;
  offset?: number;
}): Promise<ListPage<Partner>>;
function partners(query?: {
  kind?: 'supplier' | 'customer';
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<Partner[] | ListPage<Partner>> {
  const params = new URLSearchParams();
  if (query?.kind) params.set('kind', query.kind);
  if (query?.q) params.set('q', query.q);
  writePage(params, query);
  const qs = params.toString();
  return request<Partner[] | ListPage<Partner>>(qs ? `/api/partners?${qs}` : '/api/partners');
}

/** 库存汇总。不传 limit 时是全量数组；传入 limit 时带 hasReserved。 */
function inventory(query?: { q?: string; skuCode?: string; lowOnly?: boolean }): Promise<InventoryRow[]>;
function inventory(query: {
  q?: string;
  skuCode?: string;
  lowOnly?: boolean;
  limit: number;
  offset?: number;
}): Promise<InventoryListPage>;
function inventory(query?: {
  q?: string;
  skuCode?: string;
  lowOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<InventoryRow[] | InventoryListPage> {
  const params = new URLSearchParams();
  if (query?.q) params.set('q', query.q);
  if (query?.skuCode) params.set('skuCode', query.skuCode);
  if (query?.lowOnly) params.set('lowOnly', '1');
  writePage(params, query);
  const qs = params.toString();
  return request<InventoryRow[] | InventoryListPage>(qs ? `/api/inventory?${qs}` : '/api/inventory');
}

type LocationListQuery = {
  q?: string;
  /** 只返回这个仓库里的库位。与 unassigned 互斥。 */
  warehouseCode?: string;
  /** 只返回还没划进仓库的库位。 */
  unassigned?: boolean;
};

/** 库位清单。不传 limit 时是全量数组；q 在服务端过滤。仓库范围也在服务端过滤。 */
function locations(query?: LocationListQuery): Promise<Location[]>;
function locations(query: LocationListQuery & { limit: number; offset?: number }): Promise<ListPage<Location>>;
function locations(query?: LocationListQuery & { limit?: number; offset?: number }): Promise<Location[] | ListPage<Location>> {
  const params = new URLSearchParams();
  if (query?.q) params.set('q', query.q);
  if (query?.unassigned) params.set('unassigned', '1');
  else if (query?.warehouseCode) params.set('warehouseCode', query.warehouseCode);
  writePage(params, query);
  const qs = params.toString();
  return request<Location[] | ListPage<Location>>(qs ? `/api/locations?${qs}` : '/api/locations');
}

export const wmsApi = {
  skus,
  createSku: (body: {
    skuCode: string;
    name: string;
    barcode?: string;
    reorderPoint?: number;
    unit?: string;
    serialTracked?: boolean;
    extData?: Record<string, unknown>;
  }) =>
    request<{
      skuId: string;
      skuCode: string;
      name: string;
      barcode?: string;
      reorderPoint?: number;
      unit?: string | null;
    }>('/api/skus', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 编辑 SKU 档案：只传要改的字段（skuCode 是业务键不可改）；unit 传空串 = 清空 */
  updateSku: (
    skuCode: string,
    body: {
      name?: string;
      barcode?: string;
      reorderPoint?: number;
      unit?: string;
      serialTracked?: boolean;
      extData?: Record<string, unknown>;
    },
  ) =>
    request<{
      skuId: string;
      skuCode: string;
      barcode?: string | null;
      reorderPoint?: number;
      unit?: string | null;
    }>(`/api/skus/${encodeURIComponent(skuCode)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** 停用 SKU（A2 软停用）：隐藏 + 退出预警；剩余库存照常可扣，unarchive 可恢复 */
  archiveSku: (skuCode: string) =>
    request<{ skuId: string; skuCode: string; status: string }>(
      `/api/skus/${encodeURIComponent(skuCode)}/archive`,
      { method: 'POST' },
    ),
  /** 恢复已停用的 SKU */
  unarchiveSku: (skuCode: string) =>
    request<{ skuId: string; skuCode: string; status: string }>(
      `/api/skus/${encodeURIComponent(skuCode)}/unarchive`,
      { method: 'POST' },
    ),
  orders,
  orderConflicts: () =>
    request<
      {
        eventId: string;
        orderNo: string;
        fromState: string;
        toState: string;
        actualState: string;
        status: string;
      }[]
    >('/api/order-conflicts'),
  acceptConflict: (eventId: string) =>
    request<{ eventId: string; orderNo: string; status: string }>(
      `/api/order-conflicts/${encodeURIComponent(eventId)}/accept`,
      { method: 'POST' },
    ),
  dismissConflict: (eventId: string) =>
    request<{ eventId: string; orderNo: string; status: string }>(
      `/api/order-conflicts/${encodeURIComponent(eventId)}/dismiss`,
      { method: 'POST' },
    ),
  partners,
  createPartner: (body: {
    partnerCode: string;
    kind: 'supplier' | 'customer';
    name: string;
    contact?: string;
    phone?: string;
    address?: string;
    note?: string;
  }) =>
    request<{ partnerId: string; partnerCode: string; kind: string; name: string }>('/api/partners', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePartner: (
    partnerCode: string,
    body: { name?: string; contact?: string; phone?: string; address?: string; note?: string },
  ) =>
    request<{ partnerId: string; partnerCode: string; name: string }>(
      `/api/partners/${encodeURIComponent(partnerCode)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  /** 拣货单清单（M21）：state 过滤（created/closed/canceled） */
  pickings: (state?: string) =>
    request<Picking[]>(state ? `/api/pickings?state=${state}` : '/api/pickings'),
  createPicking: (body: { orderNos: string[]; note?: string }) =>
    request<{ pickingId: string; pickingNo: string; state: string; lineCount: number }>(
      '/api/pickings',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  pickPickingLine: (
    pickingNo: string,
    body: {
      orderNo: string;
      skuCode: string;
      suggestedBatchNo?: string;
      pickedQty: number;
      locationCode?: string;
      pickedBatchNo?: string;
      /** 一行拆成多桶。在场时覆盖这一行，pickedQty 要等于各桶之和 */
      allocations?: { locationCode?: string; batchNo?: string; quantity: number }[];
    },
  ) =>
    request<{ pickingNo: string; lineId: string; pickedQty: number; remainingToPick: number }>(
      `/api/pickings/${encodeURIComponent(pickingNo)}/pick`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  closePicking: (pickingNo: string) =>
    request<{
      pickingNo: string;
      state: string;
      orders: { orderNo: string; from: string; to: string }[];
    }>(`/api/pickings/${encodeURIComponent(pickingNo)}/close`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  cancelPicking: (pickingNo: string) =>
    request<{ pickingNo: string; state: string }>(`/api/pickings/${encodeURIComponent(pickingNo)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // ── 运营看板（M21）：五维度各自独立端点 ──
  dashboardOverview: () => request<DashboardOverview>('/api/dashboard/overview'),
  dashboardFlowTrend: (days = 14) =>
    request<FlowTrendPoint[]>(`/api/dashboard/flow-trend?days=${days}`),
  dashboardLocations: () => request<LocationDistribution[]>('/api/dashboard/locations'),
  dashboardOrders: () => request<OrderStateCount[]>('/api/dashboard/orders'),
  dashboardAlerts: () => request<AlertSummary>('/api/dashboard/alerts'),
  /** 补货建议。模块关闭时 400。空数组表示现在没有缺口。 */
  replenishment: () => request<ReplenishmentSuggestion[]>('/api/replenishment'),
  createReplenishment: (body: { skuCodes?: string[]; partnerCode?: string; note?: string; orderNo?: string }) =>
    request<{ orderId: string; orderNo: string; state: string; lines: { skuCode: string; quantity: number }[] }>(
      '/api/replenishment',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** 原单还能退多少。模块关闭、原单未入账、或原单本身是退货单时 400。 */
  orderReturnable: (orderNo: string) =>
    request<ReturnableView>(`/api/orders/${encodeURIComponent(orderNo)}/returnable`),
  createOrder: (body: {
    direction: 'in' | 'out';
    lines: {
      skuCode: string;
      quantity: number;
      locationCode?: string;
      batchNo?: string;
      batchExpiryDate?: string;
      serials?: string[];
    }[];
    /** 单据号（可选，缺省由服务端生成）。导入时用来把多行并成一张单 */
    orderNo?: string;
    /** 往来单位编码（M21）：入库单=供应商 / 出库单=客户 */
    partnerCode?: string;
    /** 原单号（module.return）。客退填出库单号，退供填入库单号 */
    returnOf?: string;
    /** 到货预报（module.asn）。true = 入库单先停在已预报，收货才加库存 */
    asn?: boolean;
    /** 预计到货日 YYYY-MM-DD，仅和 asn 一起用 */
    expectedAt?: string;
    note?: string;
  }) =>
    request<{ orderId: string; orderNo: string; state: string }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 修订单据内容。只传要改的字段；服务端按状态拒绝已经入账或已结束的字段。 */
  reviseOrder: (
    orderNo: string,
    body: {
      note?: string | null;
      partnerCode?: string | null;
      expectedAt?: string | null;
      lines?: {
        skuCode: string;
        quantity: number;
        locationCode?: string;
        batchNo?: string;
        batchExpiryDate?: string;
        serials?: string[];
      }[];
    },
  ) =>
    request<{ orderNo: string; state: string }>(`/api/orders/${encodeURIComponent(orderNo)}/revise`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  transitionOrder: (
    orderNo: string,
    to: string,
    lines?: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[],
  ) =>
    request<{ orderNo: string; from: string; to: string }>(`/api/orders/${orderNo}/transition`, {
      method: 'POST',
      body: JSON.stringify(lines ? { to, lines } : { to }),
    }),
  /** 上架确认与归位（M21）：targets 缺省 = 纯确认不动库存 */
  putawayOrder: (
    orderNo: string,
    targets?: { skuCode: string; fromLocationCode?: string; batchNo?: string; toLocationCode: string }[],
  ) =>
    request<{
      orderNo: string;
      from: string;
      to: string;
      movedLines?: {
        skuCode: string;
        batchNo: string;
        fromLocationCode: string;
        toLocationCode: string;
        quantity: number;
      }[];
    }>(`/api/orders/${orderNo}/putaway`, {
      method: 'POST',
      body: JSON.stringify({ targets }),
    }),
  inventory,
  /** 库存分桶明细（SKU×库位×批次）——Excel 导出用 */
  inventoryBuckets: () => request<InventoryBucketRow[]>('/api/inventory/buckets'),
  /** 按视角看实物余量。limit 必填。未分仓用 unassigned，不与 warehouseCode 同时传。 */
  inventorySlices: (query: {
    view: InventorySliceView;
    q?: string;
    locationCode?: string;
    batchNo?: string;
    warehouseCode?: string;
    unassigned?: boolean;
    limit: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    params.set('view', query.view);
    if (query.q) params.set('q', query.q);
    if (query.locationCode) params.set('locationCode', query.locationCode);
    if (query.batchNo) params.set('batchNo', query.batchNo);
    if (query.unassigned) params.set('unassigned', '1');
    else if (query.warehouseCode) params.set('warehouseCode', query.warehouseCode);
    writePage(params, query);
    return request<InventorySlicePage>(`/api/inventory/slices?${params.toString()}`);
  },
  /** 库存流水（导出/对账）——limit 上限 5000，skuCode 可选过滤 */
  ledger: (query?: { limit?: number; skuCode?: string }) => {
    const p = new URLSearchParams();
    if (query?.limit) p.set('limit', String(query.limit));
    if (query?.skuCode) p.set('skuCode', query.skuCode);
    const qs = p.toString();
    return request<LedgerRow[]>(`/api/inventory/ledger${qs ? `?${qs}` : ''}`);
  },
  /** 效期看板（M14）：全仓批次分层清单（读直查投影，切页挂载即刷新） */
  expiryBoard: () => request<ExpiryBoard>('/api/inventory/expiry'),
  adjustInventory: (body: { skuCode: string; delta: number; reason?: string; serials?: string[] }) =>
    request<{ skuCode: string; quantity: number }>('/api/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 活动冻结清单；skuCode 过滤（未知编码 → 空清单） */
  holds: (skuCode?: string) =>
    request<Hold[]>(skuCode ? `/api/holds?skuCode=${encodeURIComponent(skuCode)}` : '/api/holds'),
  createHold: (body: { skuCode: string; quantity: number; reason?: string }) =>
    request<{ holdId: string; skuCode: string; quantity: number; total: number; held: number; available: number }>(
      '/api/holds',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  releaseHold: (holdId: string) =>
    request<{ holdId: string; skuCode: string; quantity: number; total: number; held: number; available: number }>(
      `/api/holds/${encodeURIComponent(holdId)}/release`,
      { method: 'POST' },
    ),
  locations,
  createLocation: (body: { locationCode: string; name?: string; warehouseCode?: string; capacity?: number }) =>
    request<{ locationId: string; locationCode: string; name: string; capacity?: number }>('/api/locations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 编辑库位：改名；多仓开启时还可以用 warehouseCode 划仓（空字符串表示划出）。capacity 传 null 清空 */
  updateLocation: (locationCode: string, body: { name?: string; warehouseCode?: string; capacity?: number | null }) =>
    request<{ locationId: string; locationCode: string; name: string }>(
      `/api/locations/${encodeURIComponent(locationCode)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  warehouses: () => request<Warehouse[]>('/api/warehouses'),
  createWarehouse: (body: { warehouseCode: string; name?: string }) =>
    request<{ warehouseId: string; warehouseCode: string; name: string }>('/api/warehouses', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWarehouse: (warehouseCode: string, body: { name?: string }) =>
    request<{ warehouseId: string; warehouseCode: string; name: string }>(
      `/api/warehouses/${encodeURIComponent(warehouseCode)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  warehouseStock: (warehouseCode: string) =>
    request<WarehouseStock>(`/api/warehouses/${encodeURIComponent(warehouseCode)}/stock`),
  serials: (query?: { skuCode?: string; locationCode?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (query?.skuCode) params.set('skuCode', query.skuCode);
    if (query?.locationCode) params.set('locationCode', query.locationCode);
    if (query?.status) params.set('status', query.status);
    const qs = params.toString();
    return request<SerialRow[]>(`/api/serials${qs ? `?${qs}` : ''}`);
  },
  serial: (serialNo: string) => request<SerialRow>(`/api/serials/${encodeURIComponent(serialNo)}`),
  lpns: () => request<LpnRow[]>('/api/lpns'),
  createLpn: (body: { lpnCode: string; locationCode?: string }) =>
    request<{ lpnId: string; lpnCode: string; locationCode: string }>('/api/lpns', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  packLpn: (lpnCode: string, body: { skuCode: string; quantity: number; batchNo?: string; serials?: string[] }) =>
    request<{ lpnCode: string; skuCode: string; batchNo: string; quantity: number }>(
      `/api/lpns/${encodeURIComponent(lpnCode)}/pack`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  unpackLpn: (lpnCode: string, body: { skuCode: string; quantity: number; batchNo?: string; serials?: string[] }) =>
    request<{ lpnCode: string; skuCode: string; batchNo: string; quantity: number }>(
      `/api/lpns/${encodeURIComponent(lpnCode)}/unpack`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  moveLpn: (lpnCode: string, body: { toLocationCode: string }) =>
    request<{ lpnCode: string; from: string; to: string; lines: LpnStockLine[] }>(
      `/api/lpns/${encodeURIComponent(lpnCode)}/move`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  lpnStock: (lpnCode: string) => request<LpnStock>(`/api/lpns/${encodeURIComponent(lpnCode)}/stock`),
  stocktakes: () => request<Stocktake[]>('/api/stocktakes'),
  stocktakeDetail: (no: string) =>
    request<StocktakeDetail>(`/api/stocktakes/${encodeURIComponent(no)}`),
  createStocktake: (body: { locationCodes?: string[]; note?: string }) =>
    request<{ stocktakeId: string; stocktakeNo: string; state: string; lineCount: number }>(
      '/api/stocktakes',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  countStocktake: (
    no: string,
    body: { skuCode: string; locationCode?: string; batchNo?: string; countedQty: number },
  ) =>
    request<{ countedQty: number; expectedQty: number; bookQty: number }>(
      `/api/stocktakes/${encodeURIComponent(no)}/count`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  closeStocktake: (no: string) =>
    request<StocktakeCloseResult>(`/api/stocktakes/${encodeURIComponent(no)}/close`, {
      method: 'POST',
    }),
  cancelStocktake: (no: string) =>
    request<{ stocktakeNo: string; state: string }>(
      `/api/stocktakes/${encodeURIComponent(no)}/cancel`,
      { method: 'POST' },
    ),
};

function writePage(params: URLSearchParams, page?: { limit?: number; offset?: number }): void {
  if (page?.limit == null) return;
  params.set('limit', String(page.limit));
  if (page.offset) params.set('offset', String(page.offset));
}
