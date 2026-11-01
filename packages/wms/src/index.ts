/**
 * @one/wms —— 仓储领域包（里程碑 2：出入库 + 状态机 + 库存流水；M10：库位管理；M11：批次/效期）。
 *
 *  - WmsDomain / WmsWorkspace   领域装配与工作区门面（追账 / 重放）
 *  - SkuView / LocationView / OrderView / InventoryView   四个事件投影
 *  - wms.* 工具十件套           AI 与人机界面的共同通道（业务校验在 handler）
 *
 * 本包只 import @one/core 的公共 API（index.ts）——平台化口子纪律。
 * 本文件是本包公共 API 的唯一出口；分层规则见 docs/ARCHITECTURE.md。
 */
export { WmsDomain, WmsWorkspace } from './wms.js';

export { SkuView, type SkuRecord } from './views/sku-view.js';
export { LocationView, type LocationRecord } from './views/location-view.js';
export { OrderView, type OrderRecord, type OrderLineRecord } from './views/order-view.js';
export { InventoryView, type InventoryRecord, type LedgerRecord } from './views/inventory-view.js';

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
  OrderLinePayload,
  InventoryAdjustedPayload,
} from './events/catalog.js';

export { migrateWms } from './db/migrations.js';

export { createWmsTools } from './tools/wms-tools.js';

export {
  SkuAlreadyExistsError,
  SkuNotFoundError,
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
  OrderStateConflictError,
} from './errors.js';
