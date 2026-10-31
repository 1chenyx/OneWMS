import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * Provider 配置（DESIGN.md §9.2：云 API 与本地 Ollama 双支持，配置切换）。
 *
 * Ollama 走其原生 OpenAI 兼容端点（/v1，官方支持 chat completions 与 tool
 * calling）——因此两种后端统一用 @ai-sdk/openai-compatible 一个适配器，
 * 差别只是默认端点与无需鉴权。离线时 AI 入口自然降级为表单操作，
 * 系统其余功能不受影响（AI 只是可选入口）。
 */

export type AiProviderKind = 'openai-compatible' | 'ollama';

export interface AiProviderConfig {
  kind: AiProviderKind;
  /** OpenAI 兼容端点；ollama 缺省 http://localhost:11434/v1 */
  baseUrl?: string;
  /** 云 API 密钥（ollama 忽略） */
  apiKey?: string;
  /** 模型名（如 qwen3:8b / gpt-4o-mini / deepseek-chat） */
  model: string;
}

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** 配置 → LanguageModel（Vercel AI SDK 的 provider 无关抽象） */
export function resolveLanguageModel(config: AiProviderConfig): LanguageModel {
  const isOllama = config.kind === 'ollama';
  const provider = createOpenAICompatible({
    name: isOllama ? 'ollama' : 'openai-compatible',
    baseURL: config.baseUrl ?? (isOllama ? OLLAMA_DEFAULT_BASE_URL : requiredBaseUrl()),
    apiKey: config.apiKey ?? (isOllama ? 'ollama' : undefined),
  });
  return provider.chatModel(config.model);
}

function requiredBaseUrl(): string {
  throw new Error('AiProviderConfig.baseUrl 对 openai-compatible 后端是必填项（如 https://api.openai.com/v1）');
}
