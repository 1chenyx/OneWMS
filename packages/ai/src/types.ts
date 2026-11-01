import type { ParameterSchema } from '@one/core';

/**
 * @one/ai 的纯类型层（零运行时依赖——编排循环与 Provider 适配层的接缝）。
 *
 * 分层纪律（ARCHITECTURE.md @one/ai 章）：
 *  - agent.ts（编排循环）只 import 本文件——纯逻辑，可单测；
 *  - provider/vercel.ts（LLM 通信）只 import 本文件 + 'ai' 包——薄 IO 适配层；
 *  测试两边都不打真实 API：编排循环注入脚本化 mock，适配层用 ai/test 的 MockLanguageModelV4。
 */

/** 工具元数据（tools.list() 的形状；handler 不可见——AI 上下文安全） */
export interface AgentToolMeta {
  id: string;
  label: string;
  description: string;
  parameters: ParameterSchema;
  permission: 'read' | 'write';
}

/** 模型发起的一次工具调用（callId 用于结果回传对齐） */
export interface ToolCallRequest {
  callId: string;
  toolId: string;
  args: Record<string, unknown>;
}

/** 工具执行结果（ok=false 时 payload 为 { error } 结构，回传给模型解释） */
export interface ToolCallResult {
  callId: string;
  toolId: string;
  ok: boolean;
  payload: unknown;
}

/**
 * 编排循环持有的对话消息（我们的规范格式）。
 * Provider 适配层负责与具体 SDK 的消息格式互译——编排循环不认识 SDK 类型。
 */
export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  /** 模型发起工具调用（text 是可选旁白，如「好的，我来查一下」） */
  | { role: 'tool-calls'; text?: string; calls: ToolCallRequest[] }
  /** 一轮工具调用的全部结果（callId 与 tool-calls 对齐） */
  | { role: 'tool-results'; results: ToolCallResult[] };

/** 单轮补全请求：完整消息历史 + 工具清单（function calling 通道） */
export interface LlmTurnRequest {
  system: string;
  messages: AgentMessage[];
  tools: AgentToolMeta[];
}

/** 单轮补全响应：text 与 toolCalls 可并存（旁白 + 调用）；toolCalls 为空 = 会话终态 */
export interface LlmTurnResponse {
  text: string;
  toolCalls: ToolCallRequest[];
}

/**
 * 流式单轮补全的分片序列（streamTurn 的产出）。
 *  - text-delta：增量旁白文本（可能有多片）；
 *  - tool-calls：本轮流到的全部工具调用（终片——模型决定调用工具时，
 *    分片以一条完整调用清单收尾，供编排层去执行）。
 */
export type LlmStreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-calls'; text?: string; calls: ToolCallRequest[] };

/**
 * LLM 通信的 Provider 抽象（IO 边界的唯一口子）。
 * 实现：provider/vercel.ts（OpenAI 兼容 / Ollama）；测试：脚本化 mock。
 * streamTurn 是可选增强：未实现时编排层回退到 completeTurn（整轮文本
 * 作为单个 text-delta 事件发出）——老 mock 与非流式实现无需改动。
 */
export interface LlmProvider {
  completeTurn(req: LlmTurnRequest): Promise<LlmTurnResponse>;
  streamTurn?(req: LlmTurnRequest): AsyncGenerator<LlmStreamChunk>;
}
