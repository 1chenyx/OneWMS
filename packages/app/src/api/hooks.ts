import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Profile 快照：动态列 / 流转按钮的数据源（切页挂载即刷新，配置确认后自然可见） */
export function useProfileSnapshot() {
  return useQuery({ queryKey: ['profile'], queryFn: api.profileSnapshot });
}

// ── SKU ──────────────────────────────────────────────

export function useSkus() {
  return useQuery({ queryKey: ['skus'], queryFn: api.skus });
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

// ── 效期看板（M14）────────────────────────────────────

/** 全仓批次分层清单（切页挂载即刷新；调整/出入库后由对应 mutation 失效重取） */
export function useExpiryBoard() {
  return useQuery({ queryKey: ['expiry-board'], queryFn: api.expiryBoard });
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

/** 节点名片（切页挂载即刷新——同步/中继回合后计数会变） */
export function useNodeHello() {
  return useQuery({ queryKey: ['node-hello'], queryFn: api.nodeHello });
}

export function useSyncRun() {
  return useMutation({ mutationFn: api.syncRun });
}

export function useRelayRun() {
  return useMutation({ mutationFn: api.relayRun });
}

/** 密钥状态（生成/导入成功后 invalidate 刷新指纹展示） */
export function useKeyStatus() {
  return useQuery({ queryKey: ['key-status'], queryFn: api.keyStatus });
}

export function useGenerateKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.generateKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['key-status'] }),
  });
}

export function useImportKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.importKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['key-status'] }),
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
