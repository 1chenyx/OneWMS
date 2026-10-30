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
