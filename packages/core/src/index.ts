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
export { WorkspaceFacade } from './workspace/workspace.js';
export { EventsView } from './workspace/events-view.js';
export { FieldsView } from './workspace/fields-view.js';
export { ToolsView } from './workspace/tools-view.js';
export { ProfileView } from './workspace/profile-view.js';
export { ModulesView } from './workspace/modules-view.js';

export type { ToolContext, ToolDefinition, ToolInvocation } from './bus/tool-bus.js';
export { validateParameters } from './bus/schema-validator.js';
export type { ParameterSchema, ParameterProperty } from './bus/schema-validator.js';

export type {
  FieldDataType,
  FieldDefinition,
  RegisteredField,
  UnregisterReport,
} from './registry/field-registry.js';
export { qualifyKey, privatePrefix } from './registry/key-naming.js';
export type { FieldSharing } from './registry/key-naming.js';

export { applyPatch, parsePointer } from './profile/patch.js';
export { validatePatch } from './profile/validate.js';
export { buildImpactReport } from './profile/impact.js';
export type {
  ConfigState,
  FieldExtension,
  ModuleConfig,
  PatchOp,
  ProfileFieldType,
  ProfileSchema,
  ProfileSnapshot,
  WorkflowDef,
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

// 加密与迁移（M7）：密封纯函数 + 密钥/迁移服务经 OneCore.keys / OneCore.migration 提供
// （出口纪律与 SyncService 一致——实例唯一入口是 OneCore）
export { isValidKeyHex, keyFingerprint, sealEnvelope, unsealEnvelope } from './crypto/seal.js';
export type { SealedEvent } from './crypto/seal.js';
export type { WorkspaceKey, WorkspaceKeyInfo } from './crypto/key-service.js';
export { MIGRATION_BUNDLE_KIND, MIGRATION_BUNDLE_VERSION } from './migration/migration-service.js';
export type { MigrationBundle } from './migration/migration-service.js';

// 模块系统（M6）：manifest 类型族 + 校验纯函数；ModuleRegistry 类不导出——
// 装配唯一入口是 OneCore.exposeModuleRegistry（领域包）/ workspace().modules（应用面）
export { CORE_VERSION, MODULE_CAPABILITIES } from './modules/manifest-types.js';
export type {
  InstalledModule,
  ManifestContribution,
  ManifestFieldProvide,
  ManifestFieldRequire,
  ManifestTool,
  ModuleCapability,
  ModuleLifecyclePayload,
  ModuleManifest,
} from './modules/manifest-types.js';
export { compareSemver, validateManifest } from './modules/manifest-validate.js';
export type { ModuleUninstallReport } from './modules/module-registry.js';

export { migrate, SCHEMA_VERSION } from './db/migrations.js';

export {
  CoreError,
  CryptoError,
  EventError,
  FieldConflictError,
  FieldNotFoundError,
  KeyExistsError,
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
