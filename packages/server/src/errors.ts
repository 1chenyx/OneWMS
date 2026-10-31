import type { ErrorHandler } from 'hono';
import { CoreError } from '@one/core';

/**
 * core 错误 code → HTTP 状态码映射（唯一对照表）。
 * 前端按响应体 { code, message } 的 code 分支提示文案，不 parse message。
 */
const STATUS_BY_CODE: Record<string, 404 | 409 | 422> = {
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_STALE: 409, // 新鲜度：报告所见 ≠ 应用所得，请让 AI 重新提议
  PROPOSAL_STATE: 409, // 终态不可逆（已确认/已拒绝）
  PROFILE_VALIDATION: 422,
  KEY_EXISTS: 409, // 工作区密钥已存在（换密钥会使存量密文不可解，M7）
};

export const apiErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof CoreError) {
    const status = STATUS_BY_CODE[err.code] ?? 400; // 工具/领域错误统一 400（快通道护栏语义）
    return c.json({ code: err.code, message: err.message }, status);
  }
  // 工具 handler 深层校验（schema 校验器不深入的结构）抛普通 Error，
  // 约定 'TOOL_REJECTED:' 前缀——同为客户端输入问题，映射 400 而非 500
  if (err instanceof Error && err.message.startsWith('TOOL_REJECTED:')) {
    return c.json({ code: 'TOOL_REJECTED', message: err.message.slice('TOOL_REJECTED:'.length).trim() }, 400);
  }
  return c.json({ code: 'INTERNAL', message: String(err) }, 500);
};
