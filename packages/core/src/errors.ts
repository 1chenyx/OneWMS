/**
 * 内核公共错误类型。
 * 所有错误携带 machine-readable 的 code，供 UI / AI 工具层识别处理。
 */
export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 字段类型不兼容（模块声明 requires/provides 与注册表现状冲突） */
export class FieldConflictError extends CoreError {
  constructor(message: string) {
    super('FIELD_CONFLICT', message);
  }
}

/** 字段不存在（require 一个未注册的字段） */
export class FieldNotFoundError extends CoreError {
  constructor(message: string) {
    super('FIELD_NOT_FOUND', message);
  }
}

/** 工具未注册 */
export class ToolNotFoundError extends CoreError {
  constructor(message: string) {
    super('TOOL_NOT_FOUND', message);
  }
}

/** 工具参数不符合声明的 schema */
export class ToolValidationError extends CoreError {
  constructor(message: string) {
    super('TOOL_VALIDATION', message);
  }
}

/** 工具执行期业务校验拒绝（如库存不足、状态机非法——由领域工具 handler 抛出） */
export class ToolRejectedError extends CoreError {
  constructor(message: string) {
    super('TOOL_REJECTED', message);
  }
}

/** oplog 信封非法或重复 */
export class EventError extends CoreError {
  constructor(message: string) {
    super('EVENT_ERROR', message);
  }
}

// ── 慢通道（Profile 管线，里程碑 4）──────────────────────

/** JSON Patch 应用失败（路径不存在 / 索引越界 / 结构非法） */
export class PatchError extends CoreError {
  constructor(message: string) {
    super('PATCH_ERROR', message);
  }
}

/** 校验管线未通过（语法/语义/连通性），message 含全部问题清单 */
export class ProfileValidationError extends CoreError {
  constructor(message: string) {
    super('PROFILE_VALIDATION', message);
  }
}

/** 提议不存在（或不属于该工作区） */
export class ProposalNotFoundError extends CoreError {
  constructor(message: string) {
    super('PROPOSAL_NOT_FOUND', message);
  }
}

/** 提议状态不允许此操作（如对已 applied/rejected 的提议 confirm） */
export class ProposalStateError extends CoreError {
  constructor(message: string) {
    super('PROPOSAL_STATE', message);
  }
}

/** 提议过期：propose 之后配置已发生变化，报告与现状不再一致（§7.3 报告所见即应用所得） */
export class StaleProposalError extends CoreError {
  constructor(message: string) {
    super('PROPOSAL_STALE', message);
  }
}

// ── 模块系统（里程碑 6）──────────────────────────────────

/** manifest 结构校验未通过 / 安装期声明与事实不符（工具不在场、版本不满足等），message 含问题清单 */
export class ModuleValidationError extends CoreError {
  constructor(message: string) {
    super('MODULE_VALIDATION', message);
  }
}

/** 模块未安装（卸载/查询不存在的模块） */
export class ModuleNotFoundError extends CoreError {
  constructor(message: string) {
    super('MODULE_NOT_FOUND', message);
  }
}

/**
 * 安装期冲突：版本冲突（同 id 异版本）、槽位被占（§7.2 择一型）、
 * 贡献状态 id 撞现有状态（§6.3）、字段类型不兼容（§7.1）。
 */
export class ModuleConflictError extends CoreError {
  constructor(message: string) {
    super('MODULE_CONFLICT', message);
  }
}

/** 依赖不满足：依赖模块未安装/停用，或依赖字段未注册（§7.2 循环型在单装模型下结构性消除） */
export class ModuleDependencyError extends CoreError {
  constructor(message: string) {
    super('MODULE_DEPENDENCY', message);
  }
}

// ── 声明式记录存储（B.2）─────────────────────────────────

/** 实体未声明 / 记录不存在（所属模块未安装、模块卸载后、recordId 不在场） */
export class DynRecordNotFoundError extends CoreError {
  constructor(message: string) {
    super('DYN_RECORD_NOT_FOUND', message);
  }
}

/** 记录写入冲突：重复创建、乐观版本号过期 */
export class DynRecordConflictError extends CoreError {
  constructor(message: string) {
    super('DYN_RECORD_CONFLICT', message);
  }
}

/** 记录入参校验未通过（未声明字段、类型不匹配、recordId 非法、过滤非 queryable 字段） */
export class DynRecordValidationError extends CoreError {
  constructor(message: string) {
    super('DYN_RECORD_VALIDATION', message);
  }
}

// ── 迁移（里程碑 7）────────────────────────────────────

/** 迁移包结构非法 / workspaceId 不一致（跨工作区拒绝） */
export class MigrationError extends CoreError {
  constructor(message: string) {
    super('MIGRATION_ERROR', message);
  }
}

// ── 升级闸门 ───────────────────────────────────────────

/**
 * 数据目录比当前程序新（降级启动被拒）。
 *
 * message 是给最终用户看的人话，不是给开发者的堆栈——旧程序打开新数据
 * 只会静默写坏投影（表在、语义变了），所以宁可拒绝启动。
 */
export class DataVersionError extends CoreError {
  constructor(message: string) {
    super('DATA_VERSION_DOWNGRADE', message);
  }
}
