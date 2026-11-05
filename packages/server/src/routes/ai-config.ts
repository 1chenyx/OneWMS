import { Hono } from 'hono';
import {
  OLLAMA_DEFAULT_BASE_URL,
  createVercelLlmProvider,
  resolveLanguageModel,
  type AiProviderConfig,
  type AiProviderKind,
} from '@one/ai';
import type { AppContext } from '../context.js';
import {
  deleteAiConfigFile,
  parseAiConfigInput,
  writeAiConfigFile,
} from '../ai-config-store.js';

/**
 * AI 模型配置端点（M17：env 只读快照 → 页面可配可测）。
 *
 *  - GET    /           状态卡：configured/source + 脱敏配置（apiKey 只报 apiKeySet，不回传明文）；
 *  - PUT    /           保存并热生效：写配置文件 + applyAiConfig 现场重建 provider（无需重启）；
 *  - DELETE /           关闭 AI：删配置文件，回落启动时的 env 配置（有则 source=env，无则 none）；
 *  - POST   /test       连通测试：按 body（缺省用当前配置）打一轮最小补全，
 *                        返回 ok/latencyMs 或失败原文（200 包结果——测试失败不是请求失败）。
 *
 * apiKey 复用约定：PUT/test 的 body 密钥留空，且与现配置 kind 和 baseUrl
 * 都相同 → 沿用已保存密钥（GET 不回传明文，编辑场景无需重输）；kind 或
 * baseUrl 变了就不沿用——旧密钥发给新端点是隐私事故，宁可让用户重填。
 */

/** 状态响应（GET/PUT/DELETE 共用形态——写操作直接回新状态，前端免二次拉取） */
interface AiConfigStatusBody {
  configured: boolean;
  source: 'file' | 'env' | 'none';
  config?: {
    kind: AiProviderKind;
    model: string;
    /** 生效端点（ollama 未填时回显本机缺省，与 resolveLanguageModel 实际使用一致） */
    baseUrl: string;
    apiKeySet: boolean;
  };
}

function statusOf(ctx: AppContext): AiConfigStatusBody {
  const cfg = ctx.aiConfig;
  return {
    configured: cfg !== undefined,
    source: ctx.aiConfigSource,
    config: cfg && {
      kind: cfg.kind,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? (cfg.kind === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : ''),
      apiKeySet: Boolean(cfg.apiKey),
    },
  };
}

/** 校验 body → 完整配置（补 key 复用：kind 与 baseUrl 都未变才沿用）——PUT 与 /test 共用 */
function configFromBody(
  ctx: AppContext,
  raw: unknown,
): { ok: true; config: AiProviderConfig } | { ok: false; message: string } {
  const hasInput = raw !== null && typeof raw === 'object' && Object.keys(raw).length > 0;
  if (!hasInput) {
    return ctx.aiConfig
      ? { ok: true, config: ctx.aiConfig }
      : { ok: false, message: '未提供待测配置（body 为空且当前也未配置 AI）' };
  }
  const parsed = parseAiConfigInput(raw);
  if (!parsed.ok) return parsed;
  const prev = ctx.aiConfig;
  const config = parsed.config;
  if (!config.apiKey && prev && prev.kind === config.kind && prev.baseUrl === config.baseUrl) {
    return { ok: true, config: { ...config, apiKey: prev.apiKey } };
  }
  return { ok: true, config };
}

/** 连通测试上限：不可达端点不该让页面按钮转圈到天荒地老 */
const TEST_TIMEOUT_MS = 20_000;

export function aiConfigRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => c.json(statusOf(ctx)))
    .put('/', async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = parseAiConfigInput(body);
      if (!parsed.ok) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      }
      // key 复用：kind 与 baseUrl 都未变且 body 密钥留空 → 沿用已保存密钥
      const prev = ctx.aiConfig;
      const config =
        !parsed.config.apiKey && prev && prev.kind === parsed.config.kind && prev.baseUrl === parsed.config.baseUrl
          ? { ...parsed.config, apiKey: prev.apiKey }
          : parsed.config;
      if (ctx.aiConfigPath !== null) writeAiConfigFile(ctx.aiConfigPath, config);
      ctx.applyAiConfig(config, 'file');
      return c.json(statusOf(ctx));
    })
    .delete('/', (c) => {
      if (ctx.aiConfigPath !== null) deleteAiConfigFile(ctx.aiConfigPath);
      // 回落面：启动时的 env 配置还在就切回去（关页面配置 ≠ 关 env）
      const fallback = ctx.aiConfigEnv;
      ctx.applyAiConfig(fallback, fallback ? 'env' : 'none');
      return c.json(statusOf(ctx));
    })
    .post('/test', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = configFromBody(ctx, body);
      if (!parsed.ok) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      }
      const config = parsed.config;
      // 现场重建轻量 provider 打一轮最小补全——验证端点可达 + 密钥有效 + 模型存在
      const provider = createVercelLlmProvider(resolveLanguageModel(config));
      const startedAt = Date.now();
      try {
        const result = await Promise.race([
          provider.completeTurn({
            system: '你是连通性测试。请只回复：pong',
            messages: [{ role: 'user', text: 'ping' }],
            tools: [],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`连接超时（${TEST_TIMEOUT_MS / 1000} 秒无响应）`)),
              TEST_TIMEOUT_MS,
            ),
          ),
        ]);
        return c.json({
          ok: true,
          model: config.model,
          latencyMs: Date.now() - startedAt,
          reply: result.text.slice(0, 100),
        });
      } catch (err) {
        // APICallError（401 密钥错/404 模型不存在…）与网络错误统一原文回传——
        // 这是用户排障的唯一线索，不吞不改
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, model: config.model, message });
      }
    });
}
