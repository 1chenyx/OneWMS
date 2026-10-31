import type { ProfileSnapshot, Proposal, ProposalSummary } from '@one/core';

/**
 * HTTP 客户端：唯一 fetch 出口。
 * - 契约类型直接 type-import @one/core（编译期擦除，零运行时耦合）；
 * - chat 的响应结构手写（@one/ai 的类型不必引入前端）；
 * - 非 2xx 统一抛 ApiError{code, message}，UI 按 code 分支提示（不 parse message）。
 */

/** 与 @one/wms 的 SkuRecord 同形（前端不依赖 wms 包类型，只镜像 HTTP 契约） */
export interface Sku {
  id: string;
  skuCode: string;
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
}

/** 与 @one/ai 的 AgentInvocation 同形（前端不依赖 ai 包类型） */
export interface ChatInvocation {
  toolId: string;
  args: Record<string, unknown>;
  ok: boolean;
  payload: unknown;
}

export interface ChatResponse {
  text: string;
  steps: number;
  invocations: ChatInvocation[];
}

export interface ConfirmResponse {
  newVersion: number;
  appliedOps: number;
}

// ── 设置页（M8：节点 / 同步 / 中继 / 密钥 / 迁移）──────────

/** GET /api/sync/hello——节点名片 */
export interface NodeHello {
  nodeId: string;
  workspaceId: string;
  profileVersion: number;
  watermarks: Record<string, { seq: number }>;
  eventCount: number;
}

/** POST /api/sync/run 的单节点回合结果 */
export interface SyncRoundResult {
  peer: string;
  status: string;
  pulled: number;
  accepted: number;
  skipped: number;
  replayed: boolean;
  message?: string;
}

/** POST /api/relay/run 的回合结果（RelayRoundResult 同形） */
export interface RelayRoundResult {
  pushed: number;
  pushAccepted: number;
  pushSkipped: number;
  pushConflicted: number;
  pulled: number;
  accepted: number;
  skipped: number;
  replayed: boolean;
}

/** GET /api/keys——密钥存在性与指纹（不回明文） */
export interface KeyStatus {
  exists: boolean;
  fingerprint?: string;
  createdAt?: string;
}

/** POST /api/keys 与 GET /api/keys/export——含明文本体（生成后一次性展示 / 人工搬运） */
export interface KeyMaterial {
  key: string;
  fingerprint: string;
  createdAt: string;
}

/** POST /api/migration/import 的结果 */
export interface MigrationImportResult {
  accepted: number;
  skipped: number;
  replayed: boolean;
  missingManifests: { id: string; version: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? 'UNKNOWN', body.message ?? `请求失败（${res.status}）`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  // ── 管理界面（读直查投影 / 写走工具总线，见 ARCHITECTURE.md） ──
  skus: () => request<Sku[]>('/api/skus'),
  createSku: (body: { skuCode: string; name: string; extData?: Record<string, unknown> }) =>
    request<{ skuId: string; skuCode: string; name: string }>('/api/skus', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
  adjustInventory: (body: { skuCode: string; delta: number; reason?: string }) =>
    request<{ skuCode: string; quantity: number }>('/api/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  profileSnapshot: () => request<ProfileSnapshot>('/api/profile/snapshot'),
  // ── 慢通道 ──
  proposals: () => request<ProposalSummary[]>('/api/proposals'),
  proposalDetail: (id: string) => request<Proposal>(`/api/proposals/${id}`),
  confirmProposal: (id: string, by?: string) =>
    request<ConfirmResponse>(`/api/proposals/${id}/confirm`, {
      method: 'POST',
      // by 缺省由服务端补全 user:local@nodeId（本地界面确认，审计可辨）
      body: JSON.stringify(by === undefined ? {} : { by }),
    }),
  rejectProposal: (id: string) =>
    request<{ ok: boolean }>(`/api/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  chat: (message: string) =>
    request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  // ── 设置页（M8）──
  nodeHello: () => request<NodeHello>('/api/sync/hello'),
  syncRun: (peers: string[]) =>
    request<{ results: SyncRoundResult[] }>('/api/sync/run', {
      method: 'POST',
      body: JSON.stringify({ peers }),
    }),
  relayRun: (relay: string) =>
    request<RelayRoundResult>('/api/relay/run', {
      method: 'POST',
      body: JSON.stringify({ relay }),
    }),
  keyStatus: () => request<KeyStatus>('/api/keys'),
  generateKey: () => request<KeyMaterial>('/api/keys', { method: 'POST' }),
  exportKey: () => request<KeyMaterial>('/api/keys/export'),
  importKey: (key: string) =>
    request<{ fingerprint: string; createdAt: string }>('/api/keys/import', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  migrationExport: () =>
    request<Record<string, unknown>>('/api/migration/export'),
  migrationImport: (bundle: unknown) =>
    request<MigrationImportResult>('/api/migration/import', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    }),
};
