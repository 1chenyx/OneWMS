import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentMessage, AskReply } from '@one/ai';
import type { AppContext } from '../context.js';

/**
 * AI 快通道入口（M12：SSE 流式 + 会话化 + ui.ask 挂起/唤醒）。
 *
 *  - 会话是 server 内存态（不持久化）：id 由前端生成（页面生命周期唯一），
 *    首条消息自动建档；会话承载 AgentMessage[] 历史，跨轮次喂给编排层；
 *  - POST /sessions/:id/message 逐事件推 SSE（text-delta / tool-call /
 *    tool-result / ask / turn-done / error）；turn-done 后才把完整历史提交
 *    会话——失败或中断的轮次不提交，会话回到上一完整轮；
 *  - ui.ask 挂起（步骤3）：流暂停在 ask 事件上（连接保持打开），等
 *    POST /sessions/:id/answer 注入回答（或 5 分钟超时按 declined），
 *    回答经生成器 next(reply) 续流；ui.ask 不穿工具总线，天然不落 oplog；
 *  - 事件 JSON 即协议（event 名与 data.type 一致，便于浏览器直连调试）。
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
  /** streaming = 有一条消息正在处理（含 ask 挂起中；同一会话串行，防止历史交错） */
  status: 'idle' | 'streaming';
  updatedAt: number;
  pendingAsk?: PendingAsk;
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
    const session: ChatSession = { id, history: [], status: 'idle', updatedAt: now };
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
      if (!ctx.agent) {
        return c.json(
          { code: 'AI_NOT_CONFIGURED', message: '未配置 AI（需设置 ONE_AI_MODEL 等环境变量）' },
          503,
        );
      }
      const body = await c.req.json().catch(() => ({}) as { message?: unknown });
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        return c.json({ code: 'BAD_REQUEST', message: 'message 不能为空' }, 400);
      }
      const session = getOrCreate(c.req.param('id'));
      if (session.status === 'streaming') {
        return c.json(
          { code: 'CHAT_SESSION_BUSY', message: '该会话正在处理上一条消息，请稍候' },
          409,
        );
      }
      session.status = 'streaming';
      const agent = ctx.agent;

      return streamSSE(c, async (stream) => {
        // ask 挂起时收到的用户回答：经 next(reply) 注入生成器（普通恢复时为 undefined）
        let reply: AskReply | undefined;
        try {
          // 手动驱动生成器：yield 的事件推 SSE；return 值是完整历史（turn-done 后提交）
          const run = agent.stream(message, session.history)[Symbol.asyncIterator]();
          for (;;) {
            const { value, done } = reply === undefined ? await run.next() : await run.next(reply);
            reply = undefined;
            if (done) {
              session.history = value.messages;
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
