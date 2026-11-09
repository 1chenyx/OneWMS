import { agentApi } from './agent-api';
import { memoryApi } from './memory-api';
import { profileApi } from './profile-api';
import { settingsApi } from './settings-api';
import { wmsApi } from './wms-api';

/**
 * 前端 HTTP API 组合入口：各领域端点独立实现，这里保持既有导入路径与 api 形状。
 * 契约类型直接 type-import @one/core 或镜像 HTTP/SSE 结构，不引入服务端运行时。
 */
export const api = {
  ...wmsApi,
  ...profileApi,
  ...settingsApi,
  ...agentApi,
  ...memoryApi,
};

export { ApiError } from './request';
export { answerChatAsk, streamChatMessage } from './chat-api';
export type { ChatAttachmentChip, ChatAttachmentPayload, ChatInvocation, ChatStreamEvent } from './chat-api';
export type { ConfirmResponse } from './profile-api';
export type {
  AddSyncPeerResult,
  BackupCreateResult,
  BackupEntry,
  BackupListResult,
  LanAddressResult,
  MigrationImportResult,
  NodeHello,
  RemoveSyncPeerResult,
  RestoreBackupResult,
  SyncPeerRecord,
  SyncPeersResult,
  SyncRoundResult,
} from './settings-api';
export type {
  AgentCatalog,
  AgentDef,
  AiConfigInput,
  AiConfigStatus,
  AiProfilePublic,
  AiProfileWrite,
  AiTestResult,
} from './agent-api';
export type {
  MemoryConsolidateResult,
  MemoryConsolidateScopeResult,
  MemoryHistoryEntry,
  MemoryLedgerResponse,
  MemoryRewriteInput,
  MemoryScope,
  MemorySection,
  MemorySettings,
  ResidentMemory,
} from './memory-api';
export type {
  AlertSummary,
  DashboardOverview,
  ExpiryBatchRow,
  ExpiryBoard,
  ExpiryLevel,
  FlowTrendPoint,
  Hold,
  InventoryBucketRow,
  InventoryListPage,
  InventoryRow,
  LedgerRow,
  Location,
  LocationDistribution,
  Warehouse,
  SerialRow,
  LpnRow,
  LpnStock,
  LpnStockLine,
  Order,
  OrderLine,
  ReplenishmentSuggestion,
  ReturnableLine,
  ReturnableView,
  OrderStateCount,
  Partner,
  Picking,
  PickingLine,
  Sku,
  Stocktake,
  StocktakeCloseResult,
  StocktakeDetail,
  StocktakeLine,
} from './wms-api';
