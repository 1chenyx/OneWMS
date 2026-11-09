import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  OLLAMA_DEFAULT_BASE_URL,
  createAgentFromDef,
  createVercelLlmProvider,
  readAgentDefs,
  resolveLanguageModel,
  type AgentMessage,
  type AiProviderConfig,
  type AskReply,
  type LlmProvider,
} from '@one/ai';
import type { AiModelProfile } from '../ai-config-store.js';
import type { AppContext } from '../context.js';
import {
  attachmentSessionTools,
  composeUserText,
  rememberAttachments,
  takeAttachments,
  type StoredAttachment,
} from '../chat-attachments.js';
import { scheduleMemoryExtraction } from '../memory-hook.js';

/**
 * AI 快通道入口（M12：SSE 流式 + 会话化 + ui.ask 挂起/唤醒；M16：多助手）。
 *
 *  - 会话是 server 内存态（不持久化）：id 由前端生成（页面生命周期唯一），
 *    首条消息自动建档；会话承载 AgentMessage[] 历史，跨轮次喂给编排层；
 *  - 每条消息按 body.agentId 读 AgentDefinition 现场装配（缺省 'general'）——
 *    定义经慢通道确认后下一轮即生效；切助手 = 前端换新会话（历史按助手隔离）；
 *  - POST /sessions/:id/message 逐事件推 SSE（text-delta / tool-call /
 *    tool-result / ask / turn-done / error）；turn-done 后才把完整历史提交
 *    会话——失败或中断的轮次不提交，会话回到上一完整轮；
 *  - ui.ask 挂起（步骤3）：流暂停在 ask 事件上（连接保持打开），等
 *    POST /sessions/:id/answer 注入回答（或 5 分钟超时按 declined），
 *    回答经生成器 next(reply) 续流；ui.ask 不穿工具总线，天然不落 oplog；
 *  - 事件 JSON 即协议（event 名与 data.type 一致，便于浏览器直连调试）。
 *
 *  记忆（章节账本的三层注入）：
 *  - T0 常驻：装配时把 personal 全文 + project 章节目录渲染进 System Prompt
 *    （ctx.memory.sections.resident()，快照以消息为粒度）；
 *  - T2 预取：本轮用户消息命中章节关键词/标题 → 直接注入 0–2 节全文
 *    （matchSections 是确定性字符串匹配，零 LLM 成本）；
 *  - T1 按需：细节由模型自己调 memory.read(sectionKey) 取，不在装配期塞；
 *  - turn-done 提交历史后 fire-and-forget 触发提取（scheduleMemoryExtraction
 *    ——不阻塞 SSE、失败静默、模块级串行；落账走工具总线 actor
 *    ai:memory-auto@{nodeId}）。提取只做 memory.append 追加；整节归并只在
 *    T0 超预算或管理页人工「整理」时发生。中断/失败轮不提交也不提取。
 */

/** 空闲会话回收阈值（本地单机量级，内存护栏而非精确策略） */
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

/** ui.ask 挂起等待用户回答的上限（超时按「用户未回答」回传模型） */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** 挂起中的 ask：answer 端点（或超时）结算这个 deferred，续接 SSE 流 */
interface PendingAsk {
  callId: string;
  resolve: (reply: AskReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChatSession {
  id: string;
  history: AgentMessage[];
  /** 本会话已导入的文件（表格全文在这里，模型消息里只有预览） */
  attachments: StoredAttachment[];
  /** streaming = 有一条消息正在处理（含 ask 挂起中；同一会话串行，防止历史交错） */
  status: 'idle' | 'streaming';
  updatedAt: number;
  pendingAsk?: PendingAsk;
}

/** 对话里点选的模型名：空着表示沿用助手或当前配置（旧客户端，同一接入点换名字） */
const MODEL_NAME = /^[\w.:/+@-]{1,80}$/;
/** 已保存模型的 id（随机十六进制，或旧文件升级来的 legacy） */
const PROFILE_ID = /^[\w-]{1,64}$/;

function readRequestedModel(raw: unknown): { ok: true; model?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string' || !MODEL_NAME.test(raw.trim())) {
    return { ok: false, message: '模型名无效' };
  }
  return { ok: true, model: raw.trim() };
}

function readProfileId(raw: unknown): { ok: true; profileId?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string' || !PROFILE_ID.test(raw.trim())) {
    return { ok: false, message: '模型无效' };
  }
  return { ok: true, profileId: raw.trim() };
}

function endpointOf(kind: AiProviderConfig['kind'], baseUrl: string | undefined): string {
  return (baseUrl ?? (kind === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : '')).trim().replace(/\/$/, '');
}

/**
 * 旧客户端只传模型名：还在当前接入点上换名字。
 * 没传、或和进程配置相同 → 用进程级通道。
 */
function providerFor(ctx: AppContext, base: LlmProvider, model: string | undefined): LlmProvider {
  const cfg = ctx.aiConfig;
  if (model && cfg && model !== cfg.model) {
    return createVercelLlmProvider(resolveLanguageModel({ ...cfg, model }));
  }
  return base;
}

/**
 * 对话里点的是用户保存的那一条。地址和密钥跟那一条走。
 * 请求里再带了别的模型名，就在这一条上换名字，不把别的厂商的名字套到当前接入点。
 * 换完和进程里正在用的是同一条时直接复用，避免无谓重建。
 */
function providerForProfile(
  ctx: AppContext,
  base: LlmProvider,
  profile: AiModelProfile,
  model?: string,
): LlmProvider {
  const chosen = model && model !== profile.model ? model : profile.model;
  const cfg = ctx.aiConfig;
  const same =
    cfg !== undefined &&
    cfg.kind === profile.kind &&
    cfg.model === chosen &&
    endpointOf(cfg.kind, cfg.baseUrl) === endpointOf(profile.kind, profile.baseUrl) &&
    (cfg.apiKey ?? '') === (profile.apiKey ?? '');
  if (same) return base;
  return createVercelLlmProvider(
    resolveLanguageModel({
      kind: profile.kind,
      model: chosen,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
    }),
  );
}

export function chatRoutes(ctx: AppContext): Hono {
  const sessions = new Map<string, ChatSession>();

  /** 取会话；不存在则建档，顺带清理过期空闲会话 */
  const getOrCreate = (id: string): ChatSession => {
    const found = sessions.get(id);
    if (found) return found;
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (s.status === 'idle' && now - s.updatedAt > SESSION_IDLE_MS) sessions.delete(sid);
    }
    const session: ChatSession = { id, history: [], attachments: [], status: 'idle', updatedAt: now };
    sessions.set(id, session);
    return session;
  };

  /** 结束挂起的 ask：摘字段、清 timer、回 deferred（幂等——已结算是空操作） */
  const settleAsk = (session: ChatSession, reply: AskReply): void => {
    const pending = session.pendingAsk;
    if (!pending) return;
    session.pendingAsk = undefined;
    clearTimeout(pending.timer);
    pending.resolve(reply);
  };

  return new Hono()
    .post('/sessions/:id/message', async (c) => {
      const base = ctx.provider;
      if (!base) {
        return c.json(
          { code: 'AI_NOT_CONFIGURED', message: '未配置 AI（在「AI 模型」页面配置，或设置 ONE_AI_MODEL 等环境变量）' },
          503,
        );
      }
      const body = await c.req.json().catch(() => ({}) as {
        message?: unknown;
        agentId?: unknown;
        attachments?: unknown;
        model?: unknown;
        profileId?: unknown;
      });
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const picked = readProfileId(body.profileId);
      if (!picked.ok) {
        return c.json({ code: 'BAD_REQUEST', message: picked.message }, 400);
      }
      const requested = readRequestedModel(body.model);
      if (!requested.ok) {
        return c.json({ code: 'BAD_REQUEST', message: requested.message }, 400);
      }
      const profile = picked.profileId
        ? ctx.aiCatalog.profiles.find((item) => item.id === picked.profileId)
        : undefined;
      if (picked.profileId && !profile) {
        return c.json({ code: 'BAD_REQUEST', message: '没有这条已配置的模型' }, 400);
      }
      const taken = takeAttachments(body.attachments);
      if (!taken.ok) {
        return c.json({ code: 'BAD_REQUEST', message: taken.message }, 400);
      }
      if (!message && taken.items.length === 0) {
        return c.json({ code: 'BAD_REQUEST', message: 'message 不能为空' }, 400);
      }
      const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : 'general';
      const def = readAgentDefs(ctx.ws).find((d) => d.id === agentId);
      if (!def) {
        return c.json(
          { code: 'AGENT_NOT_FOUND', message: `助手 "${agentId}" 不存在（GET /api/agents 查看可用清单）` },
          404,
        );
      }
      const session = getOrCreate(c.req.param('id'));
      if (session.status === 'streaming') {
        return c.json(
          { code: 'CHAT_SESSION_BUSY', message: '该会话正在处理上一条消息，请稍候' },
          409,
        );
      }
      session.status = 'streaming';
      session.attachments = rememberAttachments(session.attachments, taken.items);
      const userText = composeUserText(message, taken.items, session.attachments);
      // 现场装配（M16）：定义 → 工具授权 + 人设 prompt + 模型覆盖 + actor；
      // 记忆注入（快照以消息为粒度——上轮提取结果下一轮对话即生效）
      // 本会话有附件时才挂查看/落库工具。只读助手没有业务写权限，不能落库。
      // 点了已保存的厂商就用那一条的地址和密钥；请求里的模型名只在这一条上换。
      // 没点已保存的，仍是当前配置，模型名可被助手定义覆盖。
      const agentProvider = profile
        ? providerForProfile(ctx, base, profile, requested.model)
        : providerFor(ctx, base, requested.model ?? def.model);
      ctx.memory.sync();
      // T0 常驻段（personal 全文 + project 目录）：装配期取一次快照，随消息发给模型
      const resident = ctx.memory.sections.resident();
      // T2 预取：本轮用户消息命中的 project 章节直接带全文（确定性匹配，零 LLM 成本）
      const prefetched = ctx.memory.sections
        .matchSections(userText, 2)
        .map((s) => ({ title: s.title, bodyMd: s.bodyMd }));
      const catalog = ctx.ws.tools.list();
      const allowApply = def.tools.some((id) => {
        const tool = catalog.find((item) => item.id === id);
        return tool?.permission === 'write' && id.startsWith('wms.');
      });
      const agent = createAgentFromDef(ctx.ws, agentProvider, def, {
        nodeId: ctx.core.nodeId,
        memory: { resident: resident.text, prefetched },
        sessionTools:
          session.attachments.length > 0
            ? attachmentSessionTools({
                getFiles: () => session.attachments,
                allowApply,
                ws: ctx.ws,
              })
            : undefined,
      });

      return streamSSE(c, async (stream) => {
        // ask 挂起时收到的用户回答：经 next(reply) 注入生成器（普通恢复时为 undefined）
        let reply: AskReply | undefined;
        try {
          // 手动驱动生成器：yield 的事件推 SSE；return 值是完整历史（turn-done 后提交）
          const run = agent.stream(userText, session.history)[Symbol.asyncIterator]();
          for (;;) {
            const { value, done } = reply === undefined ? await run.next() : await run.next(reply);
            reply = undefined;
            if (done) {
              session.history = value.messages;
              // 自动记忆（fire-and-forget）：turn-done 历史提交后排队提取，
              // 不阻塞 SSE；autoMemory 关闭/空轮/失败均静默（memory-hook 纪律）
              void scheduleMemoryExtraction(ctx, agentProvider, value.messages);
              break;
            }
            if (stream.aborted) break; // 客户端断开：停止消费（本轮历史不提交）
            await stream.writeSSE({ event: value.type, data: JSON.stringify(value) });
            if (value.type === 'ask') {
              // 挂起等待用户回答：answer 端点（或超时）settle 后，reply 注入下一轮 next()
              reply = await new Promise<AskReply>((resolve) => {
                const timer = setTimeout(
                  () => settleAsk(session, { declined: true }),
                  ASK_TIMEOUT_MS,
                );
                session.pendingAsk = { callId: value.callId, resolve, timer };
              });
            }
          }
        } catch (err) {
          const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          try {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ type: 'error', message: text }),
            });
          } catch {
            // 客户端已断开——错误事件无处可送，本轮不提交历史
          }
        } finally {
          session.status = 'idle';
          session.updatedAt = Date.now();
          settleAsk(session, { declined: true }); // 兜底：异常退出时释放挂起
        }
      });
    })
    .post('/sessions/:id/answer', async (c) => {
      const session = sessions.get(c.req.param('id'));
      if (!session) {
        return c.json({ code: 'CHAT_SESSION_NOT_FOUND', message: '会话不存在或已过期' }, 404);
      }
      const pending = session.pendingAsk;
      if (!pending) {
        return c.json(
          { code: 'NO_PENDING_ASK', message: '该会话当前没有等待回答的问题' },
          409,
        );
      }
      const body = await c.req.json().catch(() => ({}) as { callId?: unknown; answer?: unknown });
      if (typeof body.callId === 'string' && body.callId !== pending.callId) {
        return c.json({ code: 'ASK_MISMATCH', message: '该问题已不在等待回答' }, 409);
      }
      const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
      settleAsk(session, answer ? { answer } : { declined: true });
      return c.json({ ok: true });
    });
}
