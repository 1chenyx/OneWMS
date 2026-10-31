import type { AiProviderConfig } from '@one/ai';

/**
 * 环境变量 → AiProviderConfig（§9.2 云 API 与本地 Ollama 双支持）。
 *
 * ONE_AI_MODEL 缺失 → undefined（AI 是可选入口：server 照常启动，仅 /api/chat 503）。
 * ollama 的 baseUrl 缺省由 resolveLanguageModel 处理（OLLAMA_DEFAULT_BASE_URL）。
 */
export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiProviderConfig | undefined {
  const model = env.ONE_AI_MODEL;
  if (!model) return undefined;
  const kind = env.ONE_AI_KIND === 'ollama' ? 'ollama' : 'openai-compatible';
  return {
    kind,
    model,
    baseUrl: env.ONE_AI_BASE_URL,
    apiKey: env.ONE_AI_API_KEY,
  };
}
