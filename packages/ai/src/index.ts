/**
 * @one/ai —— AI 快通道（里程碑 3：自然语言 ⇄ Tool Calling 出入库）。
 *
 *  - runAgent             编排循环（纯逻辑，Provider 注入可单测）
 *  - createWmsAgent       WMS 便利工厂（绑定工作区 + actor='ai:模型名' 审计）
 *  - buildSystemPrompt    System Prompt 组装（v1：业务快照 + 行为规则）
 *  - provider/*           LLM 通信薄适配层（Vercel AI SDK；OpenAI 兼容 / Ollama）
 *
 * 分层纪律与每文件职责见 docs/ARCHITECTURE.md 的 @one/ai 章节。
 */
export { runAgent, AgentStepLimitError } from './agent.js';
export type { AgentInvocation, AgentRunResult, RunAgentDeps } from './agent.js';

export { createWmsAgent } from './wms-agent.js';
export type { CreateWmsAgentOptions, WmsAgent } from './wms-agent.js';

export { buildSystemPrompt } from './system-prompt.js';

export { createVercelLlmProvider } from './provider/vercel.js';
export { resolveLanguageModel, OLLAMA_DEFAULT_BASE_URL } from './provider/config.js';
export type { AiProviderConfig, AiProviderKind } from './provider/config.js';

export type {
  AgentMessage,
  AgentToolMeta,
  LlmProvider,
  LlmTurnRequest,
  LlmTurnResponse,
  ToolCallRequest,
  ToolCallResult,
} from './types.js';
