import { request } from './request';

/** 与 @one/wms 的 SkuRecord 同形（前端不依赖 wms 包类型，只镜像 HTTP 契约） */
export interface Sku {
  id: string;
  skuCode: string;
  /** 条码（M18）：null = 未设置；同库唯一（扫码枪识读） */
  barcode: string | null;
  /** 安全库存（M20）：低库存预警阈值；0 = 不预警 */
  reorderPoint: number;
  name: string;
  extData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrderLine {
  skuCode: string;
  name: string;
  quantity: number;
}

export interface Order {
  id: string;
  orderNo: string;
  direction: 'in' | 'out';
  state: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lines: OrderLine[];
}

export interface InventoryRow {
  skuId: string;
  skuCode: string;
  name: string;
  quantity: number;
  /** 活动冻结合计（M19）；available = quantity − held（单据出库拦截同一口径） */
  held: number;
  available: number;
  /** 安全库存（M20）：>0 且 available < 它 → 低库存预警（前端标红/过滤） */
  reorderPoint: number;
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

/** 库位（GET /api/locations，与 @one/wms LocationRecord 同形；DEFAULT 虚拟桶不在列） */
export interface Location {
  id: string;
  locationCode: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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
  /** 库位 × 余量明细（后端按余量降序）——行展开直出 */
  buckets: { locationCode: string; quantity: number }[];
}

/** GET /api/inventory/expiry 响应（today 供前端展示「截至」语境） */
export interface ExpiryBoard {
  today: string;
  rows: ExpiryBatchRow[];
}

export const wmsApi = {
  /** SKU 清单：q = 编码/名称/条码 模糊搜索（M18）；barcode = 条码精确匹配 */
  skus: (query?: { q?: string; barcode?: string }) => {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.barcode) params.set('barcode', query.barcode);
    const qs = params.toString();
    return request<Sku[]>(qs ? `/api/skus?${qs}` : '/api/skus');
  },
  createSku: (body: {
    skuCode: string;
    name: string;
    barcode?: string;
    reorderPoint?: number;
    extData?: Record<string, unknown>;
  }) =>
    request<{ skuId: string; skuCode: string; name: string; barcode?: string; reorderPoint?: number }>(
      '/api/skus',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  orders: (direction?: 'in' | 'out') =>
    request<Order[]>(direction ? `/api/orders?direction=${direction}` : '/api/orders'),
  createOrder: (body: {
    direction: 'in' | 'out';
    lines: { skuCode: string; quantity: number }[];
    note?: string;
  }) =>
    request<{ orderId: string; orderNo: string; state: string }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  transitionOrder: (orderNo: string, to: string) =>
    request<{ orderNo: string; from: string; to: string }>(`/api/orders/${orderNo}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  inventory: () => request<InventoryRow[]>('/api/inventory'),
  /** 效期看板（M14）：全仓批次分层清单（读直查投影，切页挂载即刷新） */
  expiryBoard: () => request<ExpiryBoard>('/api/inventory/expiry'),
  adjustInventory: (body: { skuCode: string; delta: number; reason?: string }) =>
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
  locations: () => request<Location[]>('/api/locations'),
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
