import { randomBytes } from 'node:crypto';
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
  parseAiConfigInput,
  type AiConfigCatalog,
  type AiModelProfile,
} from '../ai-config-store.js';

/**
 * AI 模型配置端点（M17：env 只读快照 → 页面可配可测）。
 *
 *  - GET    /models              当前接入点的模型清单（列不到时只回正在用的名字；未配置则空）；
 *  - GET    /                    状态：当前生效配置 + 已保存的多模型（apiKey 只报 apiKeySet）；
 *  - PUT    /                    旧客户端：用这一条替换整份目录并设为当前；
 *  - POST   /profiles            追加一条或多条（同厂商同模型同地址则更新密钥，不重复）；
 *  - POST   /profiles/:id/activate  把这一条设为当前使用；
 *  - PATCH  /profiles/:id        改模型名 / 地址 / 密钥；
 *  - DELETE /profiles/:id        移除一条；删光则回落 env；
 *  - DELETE /                    关掉页面上的全部模型，回落启动时的 env 配置；
 *  - POST   /test                连通测试。密钥留空时，同地址已保存的密钥可以沿用。
 *
 * apiKey 复用：同一 kind + baseUrl 上已有密钥，且本次留空 → 沿用。
 * 地址或接入方式变了就不沿用——旧密钥发给新端点是隐私事故。
 */

/** 状态里的一条模型（不含密钥明文） */
interface PublicProfile {
  id: string;
  vendorId: string;
  label: string;
  kind: AiProviderKind;
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
  active: boolean;
}

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
    id?: string;
    vendorId?: string;
    label?: string;
  };
  profiles: PublicProfile[];
}

function endpointOf(kind: AiProviderKind, baseUrl: string | undefined): string {
  const raw = (baseUrl ?? (kind === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : '')).trim().replace(/\/$/, '');
  return raw;
}

function newProfileId(): string {
  return randomBytes(8).toString('hex');
}

/** 同一种接入、同一个地址上已经存过的密钥（留空时沿用） */
function donorKey(catalog: AiConfigCatalog, kind: AiProviderKind, baseUrl: string | undefined): string | undefined {
  const url = endpointOf(kind, baseUrl);
  return catalog.profiles.find((item) => item.kind === kind && endpointOf(item.kind, item.baseUrl) === url && item.apiKey)
    ?.apiKey;
}

function toPublic(profile: AiModelProfile, activeId: string | null, source: AppContext['aiConfigSource']): PublicProfile {
  return {
    id: profile.id,
    vendorId: profile.vendorId,
    label: profile.label,
    kind: profile.kind,
    model: profile.model,
    baseUrl: endpointOf(profile.kind, profile.baseUrl),
    apiKeySet: Boolean(profile.apiKey),
    active: source === 'file' && profile.id === activeId,
  };
}

function statusOf(ctx: AppContext): AiConfigStatusBody {
  const cfg = ctx.aiConfig;
  const active = ctx.aiCatalog.profiles.find((item) => item.id === ctx.aiCatalog.activeId);
  return {
    configured: cfg !== undefined,
    source: ctx.aiConfigSource,
    config: cfg && {
      kind: cfg.kind,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? (cfg.kind === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : ''),
      apiKeySet: Boolean(cfg.apiKey),
      ...(ctx.aiConfigSource === 'file' && active
        ? { id: active.id, vendorId: active.vendorId, label: active.label }
        : {}),
    },
    profiles: ctx.aiCatalog.profiles.map((item) => toPublic(item, ctx.aiCatalog.activeId, ctx.aiConfigSource)),
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
  const config = parsed.config;
  if (!config.apiKey) {
    const reused = donorKey(ctx.aiCatalog, config.kind, config.baseUrl);
    if (reused) return { ok: true, config: { ...config, apiKey: reused } };
    const prev = ctx.aiConfig;
    if (prev?.apiKey && prev.kind === config.kind && endpointOf(prev.kind, prev.baseUrl) === endpointOf(config.kind, config.baseUrl)) {
      return { ok: true, config: { ...config, apiKey: prev.apiKey } };
    }
  }
  return { ok: true, config };
}

interface ProfileWrite {
  vendorId: string;
  label: string;
  kind: AiProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 追加模型的请求体：model 或 models，至少要有一个模型名 */
function profilesFromBody(raw: unknown): { ok: true; items: ProfileWrite[]; activate: boolean } | { ok: false; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '请求体必须是 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;
  const names = [
    ...(typeof body.model === 'string' && body.model.trim() ? [body.model.trim()] : []),
    ...(Array.isArray(body.models)
      ? body.models.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
      : []),
  ];
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    return { ok: false, message: '请至少选择一个模型' };
  }
  const vendorId = typeof body.vendorId === 'string' && body.vendorId.trim() ? body.vendorId.trim() : 'custom';
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '';
  const items: ProfileWrite[] = [];
  for (const model of unique) {
    const parsed = parseAiConfigInput({
      kind: body.kind,
      model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    if (!parsed.ok) return parsed;
    items.push({
      vendorId,
      label: label || model,
      kind: parsed.config.kind,
      model: parsed.config.model,
      baseUrl: parsed.config.baseUrl,
      apiKey: parsed.config.apiKey,
    });
  }
  return { ok: true, items, activate: body.activate !== false };
}

/** 连通测试上限：不可达端点不该让页面按钮转圈到天荒地老 */
const TEST_TIMEOUT_MS = 20_000;

/** 打一轮最小补全，结果包在 200 里（失败也不是 HTTP 错误） */
async function probeProvider(config: AiProviderConfig): Promise<{
  ok: boolean;
  model: string;
  latencyMs?: number;
  reply?: string;
  message?: string;
}> {
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
        setTimeout(() => reject(new Error(`连接超时（${TEST_TIMEOUT_MS / 1000} 秒无响应）`)), TEST_TIMEOUT_MS),
      ),
    ]);
    return {
      ok: true,
      model: config.model,
      latencyMs: Date.now() - startedAt,
      reply: result.text.slice(0, 100),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, model: config.model, message };
  }
}

/** 拉模型清单的上限。列不出来就只回当前正在用的名字。 */
const MODELS_TIMEOUT_MS = 1_500;

const MODEL_NAME = /^[\w.:/+@-]{1,80}$/;

/** 向当前接入点要模型清单（OpenAI 兼容的 GET /models）。密钥只放在请求头里。 */
async function listProviderModels(cfg: AiProviderConfig | undefined): Promise<string[]> {
  if (!cfg) return [];
  const base = (cfg.baseUrl ?? (cfg.kind === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : '')).replace(/\/$/, '');
  if (!base) return [cfg.model];
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    if (!res.ok) return [cfg.model];
    const body = (await res.json()) as { data?: unknown };
    const ids = Array.isArray(body.data)
      ? body.data.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const id = (item as { id?: unknown }).id;
          return typeof id === 'string' && MODEL_NAME.test(id) ? [id] : [];
        })
      : [];
    const rest = [...new Set(ids)].filter((id) => id !== cfg.model);
    return [cfg.model, ...rest].slice(0, 80);
  } catch {
    return [cfg.model];
  }
}

export function aiConfigRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/models', async (c) => c.json({ models: await listProviderModels(ctx.aiConfig) }))
    .get('/', (c) => c.json(statusOf(ctx)))
    .put('/', async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = parseAiConfigInput(body);
      if (!parsed.ok) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      }
      // 旧客户端只有一条配置：整份目录换成这一条。同地址留空密钥才沿用。
      const sameEndpoint =
        ctx.aiConfig !== undefined &&
        ctx.aiConfig.kind === parsed.config.kind &&
        endpointOf(ctx.aiConfig.kind, ctx.aiConfig.baseUrl) === endpointOf(parsed.config.kind, parsed.config.baseUrl);
      const stored = parsed.config.apiKey
        ? parsed.config
        : {
            ...parsed.config,
            apiKey: sameEndpoint
              ? (donorKey(ctx.aiCatalog, parsed.config.kind, parsed.config.baseUrl) ?? ctx.aiConfig?.apiKey)
              : undefined,
          };
      const id = newProfileId();
      ctx.commitCatalog({
        version: 2,
        activeId: id,
        profiles: [
          {
            id,
            vendorId: 'custom',
            label: stored.model,
            kind: stored.kind,
            model: stored.model,
            baseUrl: stored.baseUrl,
            apiKey: stored.apiKey,
          },
        ],
      });
      return c.json(statusOf(ctx));
    })
    .post('/profiles', async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = profilesFromBody(body);
      if (!parsed.ok) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      }
      const next: AiModelProfile[] = [...ctx.aiCatalog.profiles];
      let activeId = ctx.aiCatalog.activeId;
      parsed.items.forEach((item, index) => {
        const apiKey = item.apiKey ?? donorKey({ version: 2, activeId, profiles: next }, item.kind, item.baseUrl);
        const url = endpointOf(item.kind, item.baseUrl);
        const existing = next.find(
          (profile) =>
            profile.vendorId === item.vendorId &&
            profile.model === item.model &&
            endpointOf(profile.kind, profile.baseUrl) === url,
        );
        if (existing) {
          if (apiKey) existing.apiKey = apiKey;
          existing.label = item.label;
          existing.kind = item.kind;
          existing.baseUrl = item.baseUrl;
          if (parsed.activate && index === 0) activeId = existing.id;
          return;
        }
        const id = newProfileId();
        next.push({
          id,
          vendorId: item.vendorId,
          label: item.label,
          kind: item.kind,
          model: item.model,
          baseUrl: item.baseUrl,
          apiKey,
        });
        if (parsed.activate && index === 0) activeId = id;
        if (!activeId) activeId = id;
      });
      ctx.commitCatalog({ version: 2, activeId, profiles: next });
      return c.json(statusOf(ctx));
    })
    .post('/profiles/:id/activate', (c) => {
      const id = c.req.param('id');
      const profile = ctx.aiCatalog.profiles.find((item) => item.id === id);
      if (!profile) return c.json({ code: 'AI_CONFIG_NOT_FOUND', message: '没有这条模型' }, 404);
      ctx.commitCatalog({ ...ctx.aiCatalog, activeId: id });
      return c.json(statusOf(ctx));
    })
    .patch('/profiles/:id', async (c) => {
      const id = c.req.param('id');
      const current = ctx.aiCatalog.profiles.find((item) => item.id === id);
      if (!current) return c.json({ code: 'AI_CONFIG_NOT_FOUND', message: '没有这条模型' }, 404);
      const body = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: '请求体必须是 JSON 对象' }, 400);
      }
      const patch = body as Record<string, unknown>;
      const parsed = parseAiConfigInput({
        kind: patch.kind ?? current.kind,
        model: typeof patch.model === 'string' ? patch.model : current.model,
        baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : current.baseUrl,
        apiKey: typeof patch.apiKey === 'string' ? patch.apiKey : undefined,
      });
      if (!parsed.ok) return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      const sameEndpoint =
        parsed.config.kind === current.kind &&
        endpointOf(parsed.config.kind, parsed.config.baseUrl) === endpointOf(current.kind, current.baseUrl);
      const apiKey = parsed.config.apiKey ?? (sameEndpoint ? current.apiKey : undefined);
      const label = typeof patch.label === 'string' && patch.label.trim() ? patch.label.trim() : current.label;
      const profiles = ctx.aiCatalog.profiles.map((item) =>
        item.id === id
          ? {
              ...item,
              label,
              kind: parsed.config.kind,
              model: parsed.config.model,
              baseUrl: parsed.config.baseUrl,
              apiKey,
            }
          : item,
      );
      ctx.commitCatalog({ ...ctx.aiCatalog, profiles });
      return c.json(statusOf(ctx));
    })
    .delete('/profiles/:id', (c) => {
      const id = c.req.param('id');
      const profiles = ctx.aiCatalog.profiles.filter((item) => item.id !== id);
      if (profiles.length === ctx.aiCatalog.profiles.length) {
        return c.json({ code: 'AI_CONFIG_NOT_FOUND', message: '没有这条模型' }, 404);
      }
      const activeId =
        ctx.aiCatalog.activeId === id ? (profiles[0]?.id ?? null) : ctx.aiCatalog.activeId;
      ctx.commitCatalog({ version: 2, activeId, profiles });
      return c.json(statusOf(ctx));
    })
    .delete('/', (c) => {
      ctx.commitCatalog({ version: 2, activeId: null, profiles: [] });
      return c.json(statusOf(ctx));
    })
    .post('/test', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const profileId =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>).profileId
          : undefined;
      if (typeof profileId === 'string' && profileId) {
        const profile = ctx.aiCatalog.profiles.find((item) => item.id === profileId);
        if (!profile) return c.json({ code: 'AI_CONFIG_NOT_FOUND', message: '没有这条模型' }, 404);
        const override =
          body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).model === 'string'
            ? ((body as Record<string, unknown>).model as string).trim()
            : '';
        return c.json(await probeProvider({
          kind: profile.kind,
          model: override || profile.model,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
        }));
      }
      const parsed = configFromBody(ctx, body);
      if (!parsed.ok) {
        return c.json({ code: 'AI_CONFIG_INVALID', message: parsed.message }, 400);
      }
      return c.json(await probeProvider(parsed.config));
    });
}
