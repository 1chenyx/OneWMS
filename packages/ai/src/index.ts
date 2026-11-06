/**
 * @one/ai —— AI 快通道（里程碑 3：自然语言 ⇄ Tool Calling 出入库）。
 *
 *  - runAgent             编排循环（纯逻辑，Provider 注入可单测）
 *  - createAgentFromDef   按 AgentDefinition 装配助手（M16 多实例 + 工具授权）
 *  - agent-defs           Agent 定义契约 + 内置三件套 + core.ai 模块 manifest
 *  - buildSystemPrompt    System Prompt 组装（v1：业务快照 + 行为规则 + 记忆）
 *  - memory-extract       记忆提取（自动记忆的纯逻辑核心，out-of-band）
 *  - provider/*           LLM 通信薄适配层（Vercel AI SDK；OpenAI 兼容 / Ollama）
 *
 * 分层纪律与每文件职责见 docs/ARCHITECTURE.md 的 @one/ai 章节。
 */
export { runAgent, streamAgent, AgentStepLimitError } from './agent.js';
export type {
  AgentInvocation,
  AgentRunResult,
  RunAgentDeps,
  AgentStreamEvent,
  AgentTurnResult,
  AskReply,
  StreamAgentDeps,
} from './agent.js';

export { createAgentFromDef } from './wms-agent.js';
export type { CreateAgentFromDefOptions, WmsAgent } from './wms-agent.js';

export {
  AI_MODULE_ID,
  aiModuleManifest,
  builtinAgentDefs,
  readAgentDefs,
} from './agent-defs.js';
export type { AgentDefinition, AgentToolRef } from './agent-defs.js';

export { buildSystemPrompt } from './system-prompt.js';

export {
  extractMemoryPlan,
  parseMemoryPlan,
  EMPTY_MEMORY_PLAN,
  MAX_SAVES_PER_EXTRACTION,
} from './memory-extract.js';
export type { MemoryExtractionInput, MemoryPlan } from './memory-extract.js';

export { createVercelLlmProvider } from './provider/vercel.js';
export { resolveLanguageModel, OLLAMA_DEFAULT_BASE_URL } from './provider/config.js';
export type { AiProviderConfig, AiProviderKind } from './provider/config.js';

export type {
  AgentMemoryRef,
  AgentMessage,
  AgentToolMeta,
  LlmProvider,
  LlmStreamChunk,
  LlmTurnRequest,
  LlmTurnResponse,
  ToolCallRequest,
  ToolCallResult,
} from './types.js';
