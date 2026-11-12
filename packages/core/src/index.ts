/**
 * @one/core —— OneWMS 领域无关内核（里程碑 1：内核三件套；里程碑 4：慢通道）
 *
 *  - 事件账本（append-only，系统唯一真相）＋ 全局字段注册表
 *    ＋ 工具总线（AI / 界面 / 未来权限的共同通道）
 *    ＋ Profile 慢通道管线（propose → 影响报告 → 人工确认 → 热应用）
 *
 * 本文件是公共 API 的唯一出口——内部文件路径不是 API，变动无需通知调用方。
 * 出口纪律：服务类（OplogStore/FieldRegistry/ToolBus/ProfileService/ProposalStore）
 * 不导出——装配唯一入口是 OneCore，防止外部绕过生命周期与装配口。
 * 分层规则与每文件职责见 docs/ARCHITECTURE.md；系统设计见 docs/DESIGN.md。
 */
export { OneCore } from './core.js';
export { CORE_PROJECTION_VERSION, WorkspaceFacade } from './workspace/workspace.js';
// 投影版本戳（层 1）：机制在 core，各组版本号由拥有该投影的包自己声明
export {
  decideProjectionVersion,
  ensureProjectionVersion,
  projectionAheadMessage,
  projectionMetaKey,
  PROJECTION_META_PREFIX,
} from './projection/projection-version.js';
export type { ProjectionVersionDecision } from './projection/projection-version.js';
// 投影组元数据：组名 + 版本 + 本组拥有的表，整组清理按清单驱动（不再硬编码 DELETE）
export { clearProjectionTables } from './projection/projection-group.js';
export type { ProjectionGroupSpec, ProjectionTable } from './projection/projection-group.js';
export { EventsView } from './workspace/events-view.js';
export { FieldsView } from './workspace/fields-view.js';
export { ToolsView, IDEMPOTENCY_KEY_PARAM } from './workspace/tools-view.js';
export { ProfileView } from './workspace/profile-view.js';
export { ModulesView } from './workspace/modules-view.js';
export { DynView } from './workspace/dyn-view.js';

// 动态记录存储（B.2）：声明式实体的通用存取。DynStore 类不导出——
// 实例唯一入口是 workspace().dyn（出口纪律与 OplogStore 等一致）
export {
  canonicalFieldValue,
  coerceQueryValue,
  DYN_PROJECTION_VERSION,
  dynGroupName,
  isDynRecordEvent,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  RECORD_CREATED_EVENT,
  RECORD_DELETED_EVENT,
  RECORD_UPDATED_EVENT,
} from './dyn/dyn-store.js';
export type {
  DynListOptions,
  DynProjectionPort,
  DynRecordSchema,
  DynStoredRecord,
} from './dyn/dyn-store.js';

export type { ToolContext, ToolDefinition, ToolInvocation } from './bus/tool-bus.js';
export { validateParameters } from './bus/schema-validator.js';
export type { ParameterSchema, ParameterProperty } from './bus/schema-validator.js';
// AI 结果守门（宪法级护栏）：导出供测试与领域复用同一预算口径
export { AI_RESULT_MAX_BYTES, fitResultForAi } from './bus/ai-result-guard.js';

export type {
  FieldDataType,
  FieldDefinition,
  RegisteredField,
  UnregisterReport,
} from './registry/field-registry.js';
export { qualifyKey, privatePrefix } from './registry/key-naming.js';
export type { FieldSharing } from './registry/key-naming.js';

export { applyPatch, parsePointer } from './profile/patch.js';
export { dedupeConfigState } from './profile/heal.js';
export { validatePatch } from './profile/validate.js';
export { buildImpactReport } from './profile/impact.js';
export { evalWhenCondition } from './profile/when.js';
export type {
  ConfigState,
  FieldExtension,
  ModuleConfig,
  PatchOp,
  ProfileFieldType,
  ProfileSchema,
  ProfileSnapshot,
  WorkflowDef,
  WorkflowEffect,
  WorkflowState,
  WorkflowTransition,
} from './profile/profile-types.js';
export type { ValidationIssue, ValidationResult } from './profile/validate.js';
export type { ImpactItem, ImpactReport, ImpactSeverity } from './profile/impact.js';
export type { Proposal, ProposalStatus, ProposalSummary } from './profile/proposal-store.js';

export type { EventEnvelope, EventRow } from './oplog/envelope.js';
export { buildEnvelope, rowToEnvelope } from './oplog/envelope.js';

// 同步协议（M5）：纯函数与类型出口；SyncService 类不导出——
// 实例唯一入口是 OneCore.sync（出口纪律与 OplogStore 等一致）
export { computePullPlan } from './sync/sync-protocol.js';
export type { ActorWatermark, PullRange, SyncHandshake, Watermarks } from './sync/sync-protocol.js';

// 迁移（M7）：迁移服务经 OneCore.migration 提供
// （出口纪律与 SyncService 一致——实例唯一入口是 OneCore）
export {
  MIGRATION_BUNDLE_KIND,
  MIGRATION_BUNDLE_MIN_VERSION,
  MIGRATION_BUNDLE_VERSION,
} from './migration/migration-service.js';
export type { MigrationBundle } from './migration/migration-service.js';

// 模块系统（M6）：manifest 类型族 + 校验纯函数；ModuleRegistry 类不导出——
// 装配唯一入口是 OneCore.exposeModuleRegistry（领域包）/ workspace().modules（应用面）
export { CORE_VERSION, MODULE_CAPABILITIES, UI_PAGE_KINDS, UI_PAGE_PREFIX } from './modules/manifest-types.js';
export type {
  InstalledModule,
  ManifestContribution,
  ManifestFieldProvide,
  ManifestRecord,
  ManifestRecordField,
  ManifestUi,
  ManifestUiPage,
  ManifestWorkflowTransition,
  ManifestFieldRequire,
  ManifestTool,
  ModuleCapability,
  ModuleLifecyclePayload,
  ModuleManifest,
  UiPageKind,
} from './modules/manifest-types.js';
export { compareSemver, isUiPageId, validateManifest } from './modules/manifest-validate.js';
export type { ModuleUninstallReport } from './modules/module-registry.js';

export { migrate, MIN_SCHEMA_VERSION, SCHEMA_VERSION } from './db/migrations.js';

export {
  CoreError,
  DataVersionError,
  DynRecordConflictError,
  DynRecordNotFoundError,
  DynRecordValidationError,
  EventError,
  FieldConflictError,
  FieldNotFoundError,
  MigrationError,
  ModuleConflictError,
  ModuleDependencyError,
  ModuleNotFoundError,
  ModuleValidationError,
  PatchError,
  ProfileValidationError,
  ProposalNotFoundError,
  ProposalStateError,
  StaleProposalError,
  ToolNotFoundError,
  ToolRejectedError,
  ToolValidationError,
} from './errors.js';
