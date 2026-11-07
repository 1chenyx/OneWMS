/**
 * @one/wms —— 仓储领域包（里程碑 2：出入库 + 状态机 + 库存流水；M10：库位管理；M11：批次/效期）。
 *
 *  - WmsDomain / WmsWorkspace   领域装配与工作区门面（追账 / 重放）
 *  - SkuView / LocationView / OrderView / InventoryView / StocktakeView   五个事件投影
 *  - wms.* 领域工具集           AI 与人机界面的共同通道（业务校验在 handler）
 *
 * 本包只 import @one/core 的公共 API（index.ts）——平台化口子纪律。
 * 本文件是本包公共 API 的唯一出口；分层规则见 docs/ARCHITECTURE.md。
 */
export { WmsDomain, WmsWorkspace } from './wms.js';

export { SkuView, type SkuRecord } from './views/sku-view.js';
export { LocationView, type LocationRecord } from './views/location-view.js';
export {
  OrderView,
  type OrderRecord,
  type OrderLineRecord,
  type OrderConflictRecord,
} from './views/order-view.js';
export {
  InventoryView,
  type InventoryRecord,
  type LedgerRecord,
  type HoldRecord,
  type ReservationRecord,
} from './views/inventory-view.js';
export {
  StocktakeView,
  type StocktakeRecord,
  type StocktakeLineRecord,
} from './views/stocktake-view.js';
export { PartnerView, type PartnerRecord, type PartnerKind } from './views/partner-view.js';
export {
  PickingView,
  type PickingRecord,
  type PickingLineRecord,
} from './views/picking-view.js';

export {
  ORDER_TRANSITIONS,
  WORKFLOW_BY_DIRECTION,
  canTransition,
  assertTransition,
  transitionsFrom,
  isTerminalState,
} from './state/order-state-machine.js';
export type {
  OrderDirection,
  OrderState,
  StateTransition,
  TransitionEdge,
} from './state/order-state-machine.js';

export { stockEffectOf, requiresAvailabilityCheck } from './state/inventory-effect.js';
export type { StockEffect } from './state/inventory-effect.js';

export { WMS_EVENT_TYPES, isWmsEventType, DEFAULT_LOCATION_ID, DEFAULT_BATCH_NO } from './events/catalog.js';
export type {
  WmsEventType,
  SkuCreatedPayload,
  SkuUpdatedPayload,
  LocationCreatedPayload,
  OrderCreatedPayload,
  OrderStateChangedPayload,
  OrderConflictResolvedPayload,
  OrderLinePayload,
  InventoryAdjustedPayload,
  InventoryHeldPayload,
  InventoryReleasedPayload,
  StocktakeCreatedPayload,
  StocktakeCountedPayload,
  StocktakeStateChangedPayload,
  PartnerCreatedPayload,
  PartnerUpdatedPayload,
  PickingCreatedPayload,
  PickingPickedPayload,
  PickingStateChangedPayload,
  PickingLinePayload,
} from './events/catalog.js';

export { migrateWms } from './db/migrations.js';

export { createWmsTools } from './tools/wms-tools.js';
export { readWmsSettings } from './config/wms-settings.js';
export type { WmsSettings } from './config/wms-settings.js';

export { listOrdersWithLines, listOrdersWithLinesPage, withOrderLines } from './queries/order-queries.js';
export { getReturnable } from './queries/return-queries.js';
export { getReplenishment } from './queries/replenish-queries.js';
export type { ReplenishmentSuggestion } from './queries/replenish-queries.js';
export type { ReturnableLine, ReturnableView } from './queries/return-queries.js';
export type { OrderWithLines } from './queries/order-queries.js';
export { toListPage } from './queries/page.js';
export type { ListPage } from './queries/page.js';
export { listPickingsWithLines, withPickingLines } from './queries/picking-queries.js';
export type { PickingWithLines, PickingLineWithMeta } from './queries/picking-queries.js';
export {
  getDashboardOverview,
  getFlowTrend,
  getLocationDistribution,
  getOrderStats,
  getAlertSummary,
} from './queries/dashboard-queries.js';
export type {
  DashboardOverview,
  FlowTrendPoint,
  LocationDistribution,
  OrderStateCount,
  AlertSummary,
} from './queries/dashboard-queries.js';
export {
  getExpiryBoard,
  listHoldRows,
  listInventorySummary,
  listInventorySummaryPage,
  listLedger,
} from './queries/inventory-queries.js';
export type {
  ExpiryBatchRow,
  ExpiryBoard,
  ExpiryLevel,
  HoldListRow,
  InventorySummaryPage,
  InventorySummaryRow,
  LedgerRow,
} from './queries/inventory-queries.js';
export {
  getStocktakeDetail,
  listStocktakeLineStates,
  listStocktakes,
  withStocktakeProgress,
} from './queries/stocktake-queries.js';
export type {
  StocktakeDetail,
  StocktakeLineState,
  StocktakeWithProgress,
} from './queries/stocktake-queries.js';

export {
  SkuAlreadyExistsError,
  SkuNotFoundError,
  SkuBarcodeExistsError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  LocationAlreadyExistsError,
  LocationNotFoundError,
  BatchExpiryMismatchError,
  AllocationInsufficientError,
  ExpiredBatchError,
  InvalidTransitionError,
  WorkflowNotFoundError,
  InsufficientStockError,
  StockHeldError,
  StockReservedError,
  HoldExceedsStockError,
  HoldNotFoundError,
  OrderStateConflictError,
  OrderConflictNotFoundError,
  OrderConflictClosedError,
  StocktakeNotFoundError,
  StocktakeExistsError,
  StocktakeNotOpenError,
  StocktakeLinesUncountedError,
  StocktakeScopeViolationError,
  PartnerAlreadyExistsError,
  PartnerNotFoundError,
  PartnerKindMismatchError,
  PutawayLineNotFoundError,
  PutawaySourceShortError,
  PartialDisabledError,
  PartialLineNotFoundError,
  PartialQtyExceededError,
  PartialUnwindError,
  PartialNotOnPostError,
  ReturnDisabledError,
  ReturnDirectionError,
  ReturnNotPostedError,
  ReturnOfReturnError,
  ReturnLineNotFoundError,
  ReturnQtyExceededError,
  ReturnAllocationError,
  AsnDisabledError,
  AsnDirectionError,
  AsnWithReturnError,
  AsnExpectedAtError,
  ReplenishDisabledError,
  ReplenishEmptyError,
  ReplenishNotShortError,
  PickingNotFoundError,
  PickingExistsError,
  PickingNotOpenError,
  PickingIncompleteError,
  PickingOverPickError,
  PickingOrderStateError,
  PickingLineNotFoundError,
  PickingNoOrdersError,
} from './errors.js';
