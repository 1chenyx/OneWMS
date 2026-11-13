import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { DynListQuery, InventoryListPage, InventoryRow, InventorySlicePage, Location, Order, Partner, Sku, UiPageRecord } from './client';
import type { ListPage } from './page';
import { isConnectorId } from '../lib/integration-draft';

/** Profile 快照：动态列 / 流转按钮的数据源（切页挂载即刷新，提议确认后自然可见） */
export function useProfileSnapshot() {
  return useQuery({ queryKey: ['profile'], queryFn: api.profileSnapshot });
}

/** 模块目录：名字和说明很少变，和快照的开关分开缓存 */
export function useProfileCatalog() {
  return useQuery({
    queryKey: ['profile-catalog'],
    queryFn: api.profileCatalog,
    staleTime: 60_000,
  });
}

/** 某个位置的下一号。place 为空不请求。预填用，不占号。 */
export function useNextNumber(place: string | null) {
  return useQuery({
    queryKey: ['numbering', place ?? ''],
    enabled: !!place,
    queryFn: async () => {
      const view = await api.numbering(place!);
      const row = view.places.find((item) => item.place === place) ?? view.places[0];
      if (!row) throw new Error('没有这个编号位置');
      return { place: row.place, value: row.next, pattern: row.pattern };
    },
  });
}

// ── SKU ──────────────────────────────────────────────

/** SKU 清单（q = 编码/名称/条码 模糊搜索，M18；空串 = 全量）。queryKey 带 q，
 *  搜索翻页互不串缓存；invalidateQueries({ queryKey: ['skus'] }) 前缀匹配仍全失效。
 *  A2：默认只回启用档；includeArchived = 回全量（SKU 管理页「显示已停用」）。 */
export function useSkus(q?: string, includeArchived?: boolean): ReturnType<typeof useQuery<Sku[]>>;
export function useSkus(
  q: string | undefined,
  includeArchived: boolean | undefined,
  page: { limit: number; offset: number },
): ReturnType<typeof useQuery<ListPage<Sku>>>;
export function useSkus(
  q?: string,
  includeArchived?: boolean,
  page?: { limit: number; offset: number },
): ReturnType<typeof useQuery<Sku[]>> | ReturnType<typeof useQuery<ListPage<Sku>>> {
  const base = {
    ...(q ? { q } : {}),
    ...(includeArchived ? { includeArchived } : {}),
  };
  return useQuery({
    queryKey: page
      ? ['skus', q ?? '', includeArchived ? 'all' : 'active', page.limit, page.offset]
      : ['skus', q ?? '', includeArchived ? 'all' : 'active'],
    queryFn: async (): Promise<Sku[] | ListPage<Sku>> =>
      page ? api.skus({ ...base, limit: page.limit, offset: page.offset }) : api.skus(base),
    placeholderData: page ? keepPreviousData : undefined,
  }) as ReturnType<typeof useQuery<Sku[]>> | ReturnType<typeof useQuery<ListPage<Sku>>>;
}

export function useCreateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createSku,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skus'] });
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

/** 编辑 SKU 档案：改条码/安全库存会影响库存页预警与扫码识别，一并失效 */
export function useUpdateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      skuCode: string;
      body: {
        name?: string;
        barcode?: string;
        reorderPoint?: number;
        unit?: string;
        serialTracked?: boolean;
        extData?: Record<string, unknown>;
      };
    }) => api.updateSku(params.skuCode, params.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skus'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

/** 停用/恢复（A2 软停用）：dashboard 的 SKU 数随之变化，一并失效 */
export function useArchiveSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skuCode: string) => api.archiveSku(skuCode),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skus'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useUnarchiveSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skuCode: string) => api.unarchiveSku(skuCode),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skus'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── 往来单位（M21）────────────────────────────────────

/** 往来单位清单（kind = supplier/customer；queryKey 带 kind/q 防串缓存，
 *  invalidateQueries({ queryKey: ['partners'] }) 前缀匹配仍全失效） */
export function usePartners(query?: { kind?: 'supplier' | 'customer'; q?: string }): ReturnType<
  typeof useQuery<Partner[]>
>;
export function usePartners(query: {
  kind?: 'supplier' | 'customer';
  q?: string;
  limit: number;
  offset: number;
}): ReturnType<typeof useQuery<ListPage<Partner>>>;
export function usePartners(query?: {
  kind?: 'supplier' | 'customer';
  q?: string;
  limit?: number;
  offset?: number;
}): ReturnType<typeof useQuery<Partner[]>> | ReturnType<typeof useQuery<ListPage<Partner>>> {
  const paged = query?.limit != null;
  return useQuery({
    queryKey: paged
      ? ['partners', query?.kind ?? '', query?.q ?? '', query.limit, query.offset ?? 0]
      : ['partners', query?.kind ?? '', query?.q ?? ''],
    queryFn: async (): Promise<Partner[] | ListPage<Partner>> => {
      if (query?.limit != null) {
        return api.partners({ ...query, limit: query.limit, offset: query.offset ?? 0 });
      }
      return api.partners(query);
    },
    placeholderData: paged ? keepPreviousData : undefined,
  }) as ReturnType<typeof useQuery<Partner[]>> | ReturnType<typeof useQuery<ListPage<Partner>>>;
}

function useInvalidatePartners() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['partners'] });
  };
}

export function useCreatePartner() {
  const invalidate = useInvalidatePartners();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createPartner,
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useUpdatePartner() {
  const invalidate = useInvalidatePartners();
  return useMutation({
    mutationFn: (params: {
      partnerCode: string;
      body: { name?: string; contact?: string; phone?: string; address?: string; note?: string };
    }) => api.updatePartner(params.partnerCode, params.body),
    onSuccess: invalidate,
  });
}

// ── 拣货单（M21）──────────────────────────────────────

export function usePickings(state?: string) {
  return useQuery({ queryKey: ['pickings', state ?? ''], queryFn: () => api.pickings(state) });
}

function useInvalidatePickings() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['pickings'] });
    void qc.invalidateQueries({ queryKey: ['orders'] }); // 关单推进订单状态
    void qc.invalidateQueries({ queryKey: ['inventory'] }); // 关单统一扣减
    void qc.invalidateQueries({ queryKey: ['expiry-board'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export function useCreatePicking() {
  const invalidate = useInvalidatePickings();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createPicking,
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function usePickPickingLine() {
  const invalidate = useInvalidatePickings();
  return useMutation({
    mutationFn: (params: {
      pickingNo: string;
      body: Parameters<typeof api.pickPickingLine>[1];
    }) => api.pickPickingLine(params.pickingNo, params.body),
    onSuccess: invalidate,
  });
}

export function useClosePicking() {
  const invalidate = useInvalidatePickings();
  return useMutation({
    mutationFn: (pickingNo: string) => api.closePicking(pickingNo),
    onSuccess: invalidate,
  });
}

export function useCancelPicking() {
  const invalidate = useInvalidatePickings();
  return useMutation({
    mutationFn: (pickingNo: string) => api.cancelPicking(pickingNo),
    onSuccess: invalidate,
  });
}

function useInvalidateWaves() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['waves'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['pickings'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['numbering'] });
  };
}

export function useWaves() {
  return useQuery({ queryKey: ['waves'], queryFn: () => api.waves() });
}

export function useWave(waveNo: string | null) {
  return useQuery({
    queryKey: ['waves', waveNo],
    queryFn: () => api.wave(waveNo!),
    enabled: Boolean(waveNo),
  });
}

export function useCreateWave() {
  const invalidate = useInvalidateWaves();
  return useMutation({
    mutationFn: api.createWave,
    onSuccess: invalidate,
  });
}

export function usePickWave() {
  const invalidate = useInvalidateWaves();
  return useMutation({
    mutationFn: (waveNo: string) => api.pickWave(waveNo),
    onSuccess: invalidate,
  });
}

export function useCancelWave() {
  const invalidate = useInvalidateWaves();
  return useMutation({
    mutationFn: (waveNo: string) => api.cancelWave(waveNo),
    onSuccess: invalidate,
  });
}

// ── 运营看板（M21）：五维度独立 queryKey（['dashboard', 维度]），写操作
// 失效时 invalidateQueries({ queryKey: ['dashboard'] }) 前缀匹配全失效 ──

export function useDashboardOverview() {
  return useQuery({ queryKey: ['dashboard', 'overview'], queryFn: api.dashboardOverview });
}

export function useDashboardFlowTrend(days = 14) {
  return useQuery({
    queryKey: ['dashboard', 'flow-trend', days],
    queryFn: () => api.dashboardFlowTrend(days),
  });
}

export function useDashboardLocations() {
  return useQuery({ queryKey: ['dashboard', 'locations'], queryFn: api.dashboardLocations });
}

export function useDashboardOrders() {
  return useQuery({ queryKey: ['dashboard', 'orders'], queryFn: api.dashboardOrders });
}

export function useDashboardAlerts() {
  return useQuery({ queryKey: ['dashboard', 'alerts'], queryFn: api.dashboardAlerts });
}

export function useDashboardWorkload() {
  return useQuery({ queryKey: ['dashboard', 'workload'], queryFn: api.dashboardWorkload });
}

export function useDashboardStock() {
  return useQuery({ queryKey: ['dashboard', 'stock'], queryFn: api.dashboardStock });
}

export function useDashboardActivity(limit = 12) {
  return useQuery({
    queryKey: ['dashboard', 'activity', limit],
    queryFn: () => api.dashboardActivity(limit),
  });
}

export function useDashboardUrgent() {
  return useQuery({ queryKey: ['dashboard', 'urgent'], queryFn: api.dashboardUrgent });
}

export function useReportCatalog() {
  return useQuery({
    queryKey: ['reports', 'catalog'],
    queryFn: api.reportCatalog,
    staleTime: 60_000,
  });
}

export function useReports() {
  return useQuery({ queryKey: ['reports'], queryFn: api.reports });
}

export function useRunReport(
  reportId: string | null,
  sectionId: string | null,
  params: Record<string, string>,
  offset: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['reports', 'run', reportId, sectionId, params, offset],
    queryFn: () =>
      api.runReport({
        reportId: reportId!,
        sectionId: sectionId!,
        params,
        limit: 50,
        offset,
      }),
    enabled: Boolean(reportId && sectionId && enabled),
  });
}

export function useSaveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveReport,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteReport,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

// ── 单据 ─────────────────────────────────────────────

export function useOrderConflicts() {
  return useQuery({
    queryKey: ['order-conflicts'],
    queryFn: api.orderConflicts,
  });
}

export function useAcceptConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.acceptConflict,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order-conflicts'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useDismissConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.dismissConflict,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order-conflicts'] });
    },
  });
}

export function useOrders(direction?: 'in' | 'out'): ReturnType<typeof useQuery<Order[]>>;
export function useOrders(
  direction: 'in' | 'out' | undefined,
  page: { q?: string; limit: number; offset: number },
): ReturnType<typeof useQuery<ListPage<Order>>>;
export function useOrders(
  direction?: 'in' | 'out',
  page?: { q?: string; limit: number; offset: number },
): ReturnType<typeof useQuery<Order[]>> | ReturnType<typeof useQuery<ListPage<Order>>> {
  return useQuery({
    queryKey: page
      ? ['orders', direction ?? 'all', page.q ?? '', page.limit, page.offset]
      : ['orders', direction ?? 'all'],
    queryFn: async (): Promise<Order[] | ListPage<Order>> =>
      page ? api.orders(direction, page) : api.orders(direction),
    placeholderData: page ? keepPreviousData : undefined,
  }) as ReturnType<typeof useQuery<Order[]>> | ReturnType<typeof useQuery<ListPage<Order>>>;
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createOrder,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useReviseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { orderNo: string; body: Parameters<typeof api.reviseOrder>[1] }) =>
      api.reviseOrder(params.orderNo, params.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useTransitionOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      orderNo: string;
      to: string;
      lines?: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[];
    }) => api.transitionOrder(params.orderNo, params.to, params.lines),
    // 出库扣减改桶余量 → 效期看板/运营看板/库存随之变
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['expiry-board'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function usePutawayOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      orderNo: string;
      targets?: { skuCode: string; fromLocationCode?: string; batchNo?: string; toLocationCode: string }[];
    }) => api.putawayOrder(params.orderNo, params.targets),
    // 归位移桶 → 库存分布/效期看板/运营看板随之变（M21）
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['expiry-board'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── 库存 ─────────────────────────────────────────────

export function useInventory(): ReturnType<typeof useQuery<InventoryRow[]>>;
export function useInventory(query: {
  q?: string;
  lowOnly?: boolean;
  limit: number;
  offset: number;
}): ReturnType<typeof useQuery<InventoryListPage>>;
export function useInventory(query?: {
  q?: string;
  lowOnly?: boolean;
  limit: number;
  offset: number;
}): ReturnType<typeof useQuery<InventoryRow[]>> | ReturnType<typeof useQuery<InventoryListPage>> {
  return useQuery({
    queryKey: query
      ? ['inventory', query.q ?? '', query.lowOnly ? 'low' : 'all', query.limit, query.offset]
      : ['inventory'],
    queryFn: async (): Promise<InventoryRow[] | InventoryListPage> =>
      query ? api.inventory(query) : api.inventory(),
    placeholderData: query ? keepPreviousData : undefined,
  }) as ReturnType<typeof useQuery<InventoryRow[]>> | ReturnType<typeof useQuery<InventoryListPage>>;
}

/**
 * 按库位、批次、仓库，或带维度筛选的 SKU 合计。只含实物余量。
 * query 为 null 时不请求（按 SKU 且没有维度筛选，走 useInventory）。
 */
export function useInventorySlices(
  query: {
    view: InventorySlicePage['view'];
    q?: string;
    locationCode?: string;
    batchNo?: string;
    warehouseCode?: string;
    unassigned?: boolean;
    limit: number;
    offset: number;
  } | null,
) {
  return useQuery({
    queryKey: ['inventory', 'slices', query],
    queryFn: () => api.inventorySlices(query!),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

/** 仓库清单。多仓关闭时不要请求，端点会拒绝。 */
export function useWarehouses(enabled = true) {
  return useQuery({
    queryKey: ['warehouses'],
    queryFn: () => api.warehouses(),
    enabled,
  });
}

/** 库存分桶：库位 × 批次 × 效期。出库开单时用来看每一桶还剩多少。 */
export function useInventoryBuckets(enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'buckets'],
    queryFn: () => api.inventoryBuckets(),
    enabled,
  });
}

export function useAdjustInventory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.adjustInventory,
    // 调整改桶余量 → 效期看板的聚合/分层随之变（M14）
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['expiry-board'] });
    },
  });
}

// ── 冻结（M19）────────────────────────────────────────

/** 活动冻结清单（skuCode 缺省 = 全部）。queryKey 带 skuCode 防串缓存；
 *  invalidateQueries({ queryKey: ['holds'] }) 前缀匹配仍全失效 */
export function useHolds(skuCode?: string) {
  return useQuery({
    queryKey: ['holds', skuCode ?? ''],
    queryFn: () => api.holds(skuCode),
  });
}

/** 冻结/释放改可用量与冻结清单（物理库存不变 → 效期看板无需失效） */
function useInvalidateHolds() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['holds'] });
  };
}

export function useCreateHold() {
  const invalidate = useInvalidateHolds();
  return useMutation({ mutationFn: api.createHold, onSuccess: invalidate });
}

export function useReleaseHold() {
  const invalidate = useInvalidateHolds();
  return useMutation({ mutationFn: api.releaseHold, onSuccess: invalidate });
}

// ── 效期看板（M14）────────────────────────────────────

/** 全仓批次分层清单（切页挂载即刷新；调整/出入库后由对应 mutation 失效重取） */
export function useExpiryBoard() {
  return useQuery({ queryKey: ['expiry-board'], queryFn: api.expiryBoard });
}

// ── 盘点（M17）────────────────────────────────────────

/** 实体库位清单。不传 page 时拉全量（盘点范围勾选）；传入时按页要。DEFAULT 虚拟桶不在列。 */
export function useLocations(): ReturnType<typeof useQuery<Location[]>>;
export function useLocations(page: {
  q?: string;
  limit: number;
  offset: number;
  warehouseCode?: string;
  unassigned?: boolean;
  zoneCode?: string;
  unzoned?: boolean;
}): ReturnType<typeof useQuery<ListPage<Location>>>;
export function useLocations(page?: {
  q?: string;
  limit: number;
  offset: number;
  warehouseCode?: string;
  unassigned?: boolean;
  zoneCode?: string;
  unzoned?: boolean;
}): ReturnType<typeof useQuery<Location[]>> | ReturnType<typeof useQuery<ListPage<Location>>> {
  const paged = page?.limit != null;
  const q = page?.q;
  const limit = page?.limit;
  const offset = page?.offset ?? 0;
  const warehouseCode = page?.warehouseCode ?? '';
  const unassigned = page?.unassigned === true;
  const zoneCode = page?.zoneCode ?? '';
  const unzoned = page?.unzoned === true;
  const scopeKey = `${unassigned ? 'unassigned' : warehouseCode}|${unzoned ? 'unzoned' : zoneCode}`;
  return useQuery({
    queryKey: paged ? ['locations', q ?? '', limit, offset, scopeKey] : ['locations'],
    queryFn: async (): Promise<Location[] | ListPage<Location>> =>
      limit != null
        ? api.locations({
            q,
            limit,
            offset,
            ...(unassigned ? { unassigned: true } : warehouseCode ? { warehouseCode } : {}),
            ...(unzoned ? { unzoned: true } : zoneCode ? { zoneCode } : {}),
          })
        : api.locations(),
    // 翻页时留着上一页，避免表格闪空。换了仓库或搜索词就丢掉，免得把别的仓库的库位闪在当前仓库下面。
    placeholderData: paged
      ? (previousData, previousQuery) => {
          const prevKey = previousQuery?.queryKey;
          if (!prevKey || prevKey[1] !== (q ?? '') || prevKey[4] !== scopeKey) return undefined;
          return previousData;
        }
      : undefined,
  }) as ReturnType<typeof useQuery<Location[]>> | ReturnType<typeof useQuery<ListPage<Location>>>;
}

/** 库位增改：影响盘点范围勾选与库存分布看板，一并失效 */
function useInvalidateLocations() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['locations'] });
    void qc.invalidateQueries({ queryKey: ['warehouses'] });
    void qc.invalidateQueries({ queryKey: ['zones'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export function useCreateLocation() {
  const invalidate = useInvalidateLocations();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createLocation,
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useUpdateLocation() {
  const invalidate = useInvalidateLocations();
  return useMutation({
    mutationFn: (params: {
      locationCode: string;
      body: { name?: string; warehouseCode?: string; zoneCode?: string; capacity?: number | null };
    }) => api.updateLocation(params.locationCode, params.body),
    onSuccess: invalidate,
  });
}

export function useStocktakes() {
  return useQuery({ queryKey: ['stocktakes'], queryFn: api.stocktakes });
}

export function useStocktakeDetail(no: string | null) {
  return useQuery({
    queryKey: ['stocktake', no],
    queryFn: () => api.stocktakeDetail(no!),
    enabled: no !== null,
  });
}

/** 录实盘只动盘点投影——失效清单与当前明细即可 */
function useInvalidateStocktakeLines() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['stocktakes'] });
    void qc.invalidateQueries({ queryKey: ['stocktake'] });
  };
}

/** 关单/取消会改状态；关单还落库存调整 → 库存与效期看板一并失效 */
function useInvalidateStocktakeLifecycle() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['stocktakes'] });
    void qc.invalidateQueries({ queryKey: ['stocktake'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['expiry-board'] });
  };
}

export function useCreateStocktake() {
  const invalidate = useInvalidateStocktakeLines();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createStocktake,
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useCountStocktake() {
  const invalidate = useInvalidateStocktakeLines();
  return useMutation({
    mutationFn: (params: {
      no: string;
      body: { skuCode: string; locationCode?: string; batchNo?: string; countedQty: number };
    }) => api.countStocktake(params.no, params.body),
    onSuccess: invalidate,
  });
}

export function useCloseStocktake() {
  const invalidate = useInvalidateStocktakeLifecycle();
  return useMutation({
    mutationFn: (no: string) => api.closeStocktake(no),
    onSuccess: invalidate,
  });
}

export function useCancelStocktake() {
  const invalidate = useInvalidateStocktakeLifecycle();
  return useMutation({
    mutationFn: (no: string) => api.cancelStocktake(no),
    onSuccess: invalidate,
  });
}

// ── 调拨 / 报损 ──────────────────────────────────────

/** 发货 / 收货 / 确认报损会动库存；取消只改单据状态 */
function useInvalidateMovement() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['transfers'] });
    void qc.invalidateQueries({ queryKey: ['scraps'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['expiry-board'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export function useTransfers() {
  return useQuery({ queryKey: ['transfers'], queryFn: api.transfers });
}

/** 托盘清单（标签打印用；module.lpn 开启时才有数据） */
export function useLpns() {
  return useQuery({ queryKey: ['lpns'], queryFn: api.lpns });
}

export function useTransferDetail(no: string | null) {
  return useQuery({
    queryKey: ['transfers', no],
    queryFn: () => api.transferDetail(no!),
    enabled: no !== null,
  });
}

export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createTransfer,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useShipTransfer() {
  const invalidate = useInvalidateMovement();
  return useMutation({ mutationFn: api.shipTransfer, onSuccess: invalidate });
}

export function useReceiveTransfer() {
  const invalidate = useInvalidateMovement();
  return useMutation({ mutationFn: api.receiveTransfer, onSuccess: invalidate });
}

export function useCancelTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.cancelTransfer,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
    },
  });
}

export function useScraps() {
  return useQuery({ queryKey: ['scraps'], queryFn: api.scraps });
}

export function useScrapDetail(no: string | null) {
  return useQuery({
    queryKey: ['scraps', no],
    queryFn: () => api.scrapDetail(no!),
    enabled: no !== null,
  });
}

export function useCreateScrap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createScrap,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scraps'] });
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

export function useConfirmScrap() {
  const invalidate = useInvalidateMovement();
  return useMutation({ mutationFn: api.confirmScrap, onSuccess: invalidate });
}

export function useCancelScrap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.cancelScrap,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scraps'] });
    },
  });
}

// ── 慢通道 ───────────────────────────────────────────

/** pending 提议列表（5s 轮询：AI 什么时候提议不可预期，v1 用轮询而非推送） */
export function useProposals() {
  return useQuery({
    queryKey: ['proposals'],
    queryFn: api.proposals,
    refetchInterval: 5000,
  });
}

/** 提议详情（patch 全文 + 影响报告）——确认界面的数据源 */
export function useProposalDetail(id: string | null) {
  return useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api.proposalDetail(id!),
    enabled: id !== null,
  });
}

function useInvalidateProposals() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['proposals'] });
}

export function useConfirmProposal() {
  const qc = useQueryClient();
  return useMutation({
    // by 可省：服务端默认补全 user:local@nodeId（本地界面确认）
    mutationFn: (params: { id: string; by?: string }) =>
      api.confirmProposal(params.id, params.by),
    onSuccess: () => {
      // 确认即配置生效：待确认列表、快照（流程/模块/字段）与派生视图一并失效（M21）
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['numbering'] });
    },
  });
}

/** 提议配置变更（流程页、模块页入口；AI 提议同一队列） */
export function useProposeProfile() {
  return useMutation({
    mutationFn: (params: {
      patch: { op: string; path: string; value?: unknown }[];
      note?: string;
    }) => api.proposeProfile(params.patch, params.note),
  });
}

export function useRejectProposal() {
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: (id: string) => api.rejectProposal(id),
    onSuccess: invalidate,
  });
}

/** 保存对接配置前先让服务端跑同一套校验。不通过就不提议。 */
export function useCheckIntegrationSettings() {
  return useMutation({
    mutationFn: (settings: unknown) => api.checkIntegrationSettings(settings),
  });
}

/** 本机已有的密钥引用名。没有值。连接器 id 不合法时不请求。 */
export function useIntegrationSecrets(connectorId: string | null) {
  const enabled = !!connectorId && isConnectorId(connectorId);
  return useQuery({
    queryKey: ['integration-secrets', connectorId],
    enabled,
    queryFn: () => api.integrationSecretNames(connectorId!),
  });
}

export function usePutIntegrationSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.putIntegrationSecret,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['integration-secrets', vars.connectorId] });
    },
  });
}

export function useDeleteIntegrationSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteIntegrationSecret,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['integration-secrets', vars.connectorId] });
    },
  });
}

// ── 设置页（M8）──────────────────────────────────────

/** 节点名片（切页挂载即刷新——同步回合后计数会变）。
 *  pollMs：轮询间隔（全局顶栏状态灯传 15s 常驻刷新；不传 = 不轮询，设置页行为不变）。 */
export function useNodeHello(pollMs?: number) {
  return useQuery({ queryKey: ['node-hello'], queryFn: api.nodeHello, refetchInterval: pollMs });
}

export function useSyncRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.syncRun,
    // 同步可能刚把对端的数据拉进来（账本变 → 所有投影变），全量失效让页面重取
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ── 已配对同步节点（扫码组网）──────────────────────────

/** 本端局域网地址（设置 → 设备页二维码的值来源） */
export function useLanAddress() {
  return useQuery({ queryKey: ['lan-address'], queryFn: api.lanAddress });
}

/** 已配对节点清单（服务端 data/peers.json，重启仍在） */
export function useSyncPeers() {
  return useQuery({ queryKey: ['sync-peers'], queryFn: api.syncPeersList });
}

/** 添加节点：服务端握手通过后会立刻同步一轮——清单与全部业务数据都可能变了，全量失效 */
export function useAddSyncPeer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.syncPeerAdd,
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useRemoveSyncPeer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.syncPeerRemove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-peers'] }),
  });
}

/** 迁移导入后事件账本已变——节点名片与业务列表一并失效 */
export function useMigrationImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.migrationImport,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['node-hello'] });
      void qc.invalidateQueries({ queryKey: ['skus'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

// ── AI 模型配置（M17）──────────────────────────────────

/** 状态卡（切页挂载即刷新；保存/关闭后由 mutation 失效重取） */
export function useAiConfig() {
  return useQuery({ queryKey: ['ai-config'], queryFn: api.aiConfig });
}

function useInvalidateAiConfig() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['ai-config'] });
}

export function useClearAiConfig() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.clearAiConfig, onSuccess: invalidate });
}

/** 连通测试不改变服务端状态——无需失效缓存 */
export function useTestAiConfig() {
  return useMutation({ mutationFn: api.testAiConfig });
}

/** 追加模型（同厂商可有多条）。保存后状态卡要重取。 */
export function useAddAiProfiles() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.addAiProfiles, onSuccess: invalidate });
}

/** 切换「当前使用」。对话读的是生效配置，所以同样失效状态缓存。 */
export function useActivateAiProfile() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.activateAiProfile, onSuccess: invalidate });
}

export function useDeleteAiProfile() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.deleteAiProfile, onSuccess: invalidate });
}

// ── 自动备份（滚动保留）──────────────────────────────────

/** 备份清单（服务端定时轮会自己写入新份，切页挂载即刷新） */
export function useBackups() {
  return useQuery({ queryKey: ['backups'], queryFn: api.backupList });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.backupCreate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
}

/**
 * 恢复 = 整个账本可能变了（连 AI 配置也可能被备份带回）——
 * 逐个列举要失效的键迟早漏，这里直接全量失效，让所有页面重取。
 */
export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.backupRestore,
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.backupRemove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
}

// ── SDUI（B.6）：页面清单 + 通用记录读写 ────────────────────

/** 页面清单：只有装卸/停用模块才会变，单独缓存（不跟 profile 快照一起每页重取） */
export function useUiPages() {
  return useQuery({ queryKey: ['ui-pages'], queryFn: api.uiPages, staleTime: 60_000 });
}

/** 通用记录清单（分页 + 单列过滤全走服务端）。queryKey 带查询条件，翻页与过滤互不串缓存 */
export function useDynRecords(record: UiPageRecord, query: DynListQuery) {
  return useQuery({
    queryKey: ['dyn-records', record.id, query],
    queryFn: () => api.dynRecords(record.module, record.type, query),
    placeholderData: keepPreviousData,
  });
}

/**
 * 申请调用工具（B.5 确认闸口的第一步）。
 * read 直接回结果；write 只回令牌 —— ⚠️ 拿到 pending 就以为「写完了」是这条链路
 * 最容易踩的坑，服务端此刻什么都没做，必须再走 useToolConfirm。
 */
export function useToolInvoke() {
  return useMutation({
    mutationFn: (input: { toolId: string; params: Record<string, unknown> }) =>
      api.invokeTool(input.toolId, input.params),
  });
}

/** 带令牌落地。成功后失效通用记录和编码对照（不知道具体是哪张表，全失效比漏失效便宜） */
export function useToolConfirm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { toolId: string; token: string }) => api.confirmTool(input.toolId, input.token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dyn-records'] });
      void qc.invalidateQueries({ queryKey: ['integration-codes'] });
    },
  });
}

export interface IntegrationCodeRow {
  entity: 'sku' | 'partner' | 'warehouse';
  externalCode: string;
  internalCode: string;
}

/** 某个连接器的编码对照。id 不合法时不请求。 */
export function useIntegrationCodes(connectorId: string | null) {
  const enabled = !!connectorId && isConnectorId(connectorId);
  return useQuery({
    queryKey: ['integration-codes', connectorId],
    enabled,
    queryFn: async () => {
      const done = await api.invokeTool('integration.code.list', { connectorId });
      if (done.pending || typeof done.result !== 'object' || done.result === null || !('rows' in done.result)) {
        throw new Error('编码清单没有返回');
      }
      const rows = (done.result as { rows: unknown }).rows;
      if (!Array.isArray(rows)) throw new Error('编码清单没有返回');
      return { rows: rows as IntegrationCodeRow[] };
    },
  });
}
