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

// ── 加密与迁移（里程碑 7）────────────────────────────────

/** 加解密失败：密钥格式非法、密钥不一致、密文被篡改（绝不静默给错数据） */
export class CryptoError extends CoreError {
  constructor(message: string) {
    super('CRYPTO_ERROR', message);
  }
}

/** 工作区密钥已存在（generate/import 的幂等拒绝——换密钥会使存量密文不可解） */
export class KeyExistsError extends CoreError {
  constructor(message: string) {
    super('KEY_EXISTS', message);
  }
}

/** 迁移包结构非法 / workspaceId 不一致（跨工作区 = 跨密钥边界，v1 拒绝） */
export class MigrationError extends CoreError {
  constructor(message: string) {
    super('MIGRATION_ERROR', message);
  }
}
