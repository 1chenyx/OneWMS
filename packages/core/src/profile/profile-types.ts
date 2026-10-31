/**
 * Profile 配置 DSL 的纯类型（DESIGN.md §5）。
 *
 * 本文件是基础层：只有类型与空态构造，无运行时逻辑、无 IO。
 * entity / workflowId / moduleId 对内核是不透明键（领域隔离铁律）——
 * 基础流程内容（如 inbound/outbound）由领域包以种子数据注入。
 */

/** 扩展字段的数据类型（与注册表 FieldDataType 结构一致，独立声明以保持层间独立） */
export type ProfileFieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';

/** §5.2 字段层：实体上的扩展字段（注册表状态的序列化形态） */
export interface FieldExtension {
  /** 实际存储键（private 字段带模块前缀） */
  key: string;
  label: string;
  type: ProfileFieldType;
  /** 软删除语义：false = 隐藏，数据永不物理删除 */
  visible: boolean;
  /** 创建者（owner），如 'core' 或 'module.expiry' */
  providedBy: string;
}

/** §5.1 schema 段：全部实体及其扩展字段 */
export interface ProfileSchema {
  entities: Record<string, { extensions: FieldExtension[] }>;
}

/** §5.3 流程层：状态 + 转移（when 条件只允许引用模块开关，取值域可静态证明） */
export interface WorkflowState {
  id: string;
  label: string;
  /** 贡献来源（模块 contributes）；基础状态无此字段 */
  providedBy?: string;
}

export interface WorkflowTransition {
  from: string;
  to: string;
  /** v1 只认 `module.{id}.enabled` / `!module.{id}.enabled`（§5.3 表达式口子） */
  when?: string;
}

export interface WorkflowDef {
  /** states[0] 为初始态（约定） */
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

/** §5.4 模块层：开关 + 参数（settings 的 schema 校验由模块 manifest 自带，M6） */
export interface ModuleConfig {
  enabled: boolean;
  version?: string;
  settings?: Record<string, unknown>;
}

/**
 * config 部分的可变状态——profile_state 表的存储形态、
 * 也是 JSON Patch 应用器直接操作的对象。
 * schema.entities 不在其中（实时聚合自字段注册表）。
 */
export interface ConfigState {
  workflows: Record<string, WorkflowDef>;
  modules: Record<string, ModuleConfig>;
  /** v1 恒为空对象（§5.1 预留 key，向前兼容规则） */
  roles: Record<string, never>;
}

/** §5.1 Profile 全量快照（聚合视图：schema ← 注册表，其余 ← config.change 投影） */
export interface ProfileSnapshot {
  workspaceId: string;
  /** profileVersion：config.change 的计数，严格 +1 成链（§8.4） */
  version: number;
  schema: ProfileSchema;
  workflows: ConfigState['workflows'];
  modules: ConfigState['modules'];
  roles: ConfigState['roles'];
}

/** JSON Patch 操作（RFC 6902 子集：add / replace / remove） */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

/** patch 允许触碰的路径根（语法关白名单；roles 冻结由语义关拒绝） */
export const PATCH_ROOTS = ['/schema', '/workflows', '/modules', '/roles'] as const;

/** 空的 config 状态（version 0 的基线） */
export function emptyConfigState(): ConfigState {
  return { workflows: {}, modules: {}, roles: {} };
}
