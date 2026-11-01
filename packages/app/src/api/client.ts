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

// ── 效期看板（M14：临期分层预警）──────────────────────

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
  locations: string[];
}

/** GET /api/inventory/expiry 响应（today 供前端展示「截至」语境） */
export interface ExpiryBoard {
  today: string;
  rows: ExpiryBatchRow[];
}

/** 与 @one/ai 的 AgentStreamEvent 同形（前端不依赖 ai 包类型，只镜像 SSE 契约） */
export type ChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; callId: string; toolId: string; args: Record<string, unknown> }
  /** ui.ask 挂起：渲染回答输入卡，回答经 answerChatAsk 提交后流继续 */
  | { type: 'ask'; callId: string; question: string }
  | { type: 'tool-result'; callId: string; toolId: string; ok: boolean; payload: unknown }
  | { type: 'turn-done'; steps: number }
  | { type: 'error'; message: string };

/** 一轮对话里的一次工具调用（流式推进：tool-call 事件先落卡，tool-result 回填结果） */
export interface ChatInvocation {
  callId: string;
  toolId: string;
  args: Record<string, unknown>;
  /** undefined = 执行中（tool-result 事件未到） */
  ok?: boolean;
  payload?: unknown;
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

// ── AI 对话 SSE 流（M12：POST /api/chat/sessions/:id/message）──

/**
 * 发送一条消息并逐事件消费 SSE 流。
 * 非流式错误（503/400/409 等 JSON 响应）统一抛 ApiError——UI 按 code 分支提示。
 */
export async function streamChatMessage(
  sessionId: string,
  message: string,
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? 'UNKNOWN', body.message ?? `请求失败（${res.status}）`, res.status);
  }
  await consumeSse(res.body, onEvent);
}

/** 回答挂起的 ui.ask（answer 为 null 表示跳过）——原 SSE 连接收回答后继续 */
export async function answerChatAsk(
  sessionId: string,
  callId: string,
  answer: string | null,
): Promise<void> {
  await request<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    body: JSON.stringify(answer === null ? { callId, declined: true } : { callId, answer }),
  });
}

/** 解析 text/event-stream 响应体：按空行切块、拼 data 行、JSON 反序列化后回调 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent);
      } catch {
        // 无法解析的块直接丢弃（协议外噪音，不让流消费中断）
      }
    }
  }
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
  /** 效期看板（M14）：全仓批次分层清单（读直查投影，切页挂载即刷新） */
  expiryBoard: () => request<ExpiryBoard>('/api/inventory/expiry'),
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
