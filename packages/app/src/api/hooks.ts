import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Profile 快照：动态列 / 流转按钮的数据源（切页挂载即刷新，配置确认后自然可见） */
export function useProfileSnapshot() {
  return useQuery({ queryKey: ['profile'], queryFn: api.profileSnapshot });
}

// ── SKU ──────────────────────────────────────────────

/** SKU 清单（q = 编码/名称/条码 模糊搜索，M18；空串 = 全量）。queryKey 带 q，
 *  搜索翻页互不串缓存；invalidateQueries({ queryKey: ['skus'] }) 前缀匹配仍全失效。 */
export function useSkus(q?: string) {
  return useQuery({
    queryKey: ['skus', q ?? ''],
    queryFn: () => api.skus(q ? { q } : undefined),
  });
}

export function useCreateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createSku,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skus'] }),
  });
}

// ── 单据 ─────────────────────────────────────────────

export function useOrders(direction?: 'in' | 'out') {
  return useQuery({ queryKey: ['orders', direction ?? 'all'], queryFn: () => api.orders(direction) });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createOrder,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useTransitionOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { orderNo: string; to: string }) => api.transitionOrder(params.orderNo, params.to),
    // 出库扣减改桶余量 → 效期看板随之变（M14）
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['expiry-board'] });
    },
  });
}

// ── 库存 ─────────────────────────────────────────────

export function useInventory() {
  return useQuery({ queryKey: ['inventory'], queryFn: api.inventory });
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

/** 实体库位清单（盘点范围勾选的数据源；DEFAULT 虚拟桶不在列） */
export function useLocations() {
  return useQuery({ queryKey: ['locations'], queryFn: api.locations });
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
  return useMutation({ mutationFn: api.createStocktake, onSuccess: invalidate });
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
  const invalidate = useInvalidateProposals();
  return useMutation({
    // by 可省：服务端默认补全 user:local@nodeId（本地界面确认）
    mutationFn: (params: { id: string; by?: string }) =>
      api.confirmProposal(params.id, params.by),
    onSuccess: invalidate,
  });
}

export function useRejectProposal() {
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: (id: string) => api.rejectProposal(id),
    onSuccess: invalidate,
  });
}

// ── 设置页（M8）──────────────────────────────────────

/** 节点名片（切页挂载即刷新——同步回合后计数会变）。
 *  pollMs：轮询间隔（全局顶栏状态灯传 15s 常驻刷新；不传 = 不轮询，设置页行为不变）。 */
export function useNodeHello(pollMs?: number) {
  return useQuery({ queryKey: ['node-hello'], queryFn: api.nodeHello, refetchInterval: pollMs });
}

export function useSyncRun() {
  return useMutation({ mutationFn: api.syncRun });
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

export function useSaveAiConfig() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.saveAiConfig, onSuccess: invalidate });
}

export function useClearAiConfig() {
  const invalidate = useInvalidateAiConfig();
  return useMutation({ mutationFn: api.clearAiConfig, onSuccess: invalidate });
}

/** 连通测试不改变服务端状态——无需失效缓存 */
export function useTestAiConfig() {
  return useMutation({ mutationFn: api.testAiConfig });
}
