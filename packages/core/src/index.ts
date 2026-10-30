/**
 * @one/core —— OneWMS 领域无关内核（里程碑 1：内核三件套）
 *
 *  - OplogStore     事件账本（append-only，系统唯一真相）
 *  - FieldRegistry  全局字段注册表（owner/usedBy，事件投影）
 *  - ToolBus        工具总线（AI / 界面 / 未来权限的共同通道）
 *
 * 本文件是公共 API 的唯一出口——内部文件路径不是 API，变动无需通知调用方。
 * 分层规则与每文件职责见 docs/ARCHITECTURE.md；系统设计见 docs/DESIGN.md。
 */
export { OneCore } from './core.js';
export { WorkspaceFacade } from './workspace/workspace.js';
export { EventsView } from './workspace/events-view.js';
export { FieldsView } from './workspace/fields-view.js';
export { ToolsView } from './workspace/tools-view.js';

export { ToolBus } from './bus/tool-bus.js';
export type { ToolContext, ToolDefinition, ToolInvocation } from './bus/tool-bus.js';
export { validateParameters } from './bus/schema-validator.js';
export type { ParameterSchema, ParameterProperty } from './bus/schema-validator.js';

export { FieldRegistry } from './registry/field-registry.js';
export { qualifyKey, privatePrefix } from './registry/key-naming.js';
export type {
  FieldDataType,
  FieldDefinition,
  FieldSharing,
  RegisteredField,
  UnregisterReport,
} from './registry/field-registry.js';

export { OplogStore } from './oplog/oplog-store.js';
export type { EventEnvelope, EventRow } from './oplog/envelope.js';
export { buildEnvelope, rowToEnvelope } from './oplog/envelope.js';

export { migrate, SCHEMA_VERSION } from './db/migrations.js';

export {
  CoreError,
  EventError,
  FieldConflictError,
  FieldNotFoundError,
  ToolNotFoundError,
  ToolRejectedError,
  ToolValidationError,
} from './errors.js';
