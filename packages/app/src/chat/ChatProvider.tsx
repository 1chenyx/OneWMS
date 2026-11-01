import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp } from 'antd';
import { ApiError, answerChatAsk, streamChatMessage } from '../api/client';
import type { ChatInvocation, ChatStreamEvent } from '../api/client';

/**
 * AI 会话壳（M12）：对话状态提升到 App 级 context——切页不丢对话。
 *
 *  - sessionId 页面生命周期唯一（server 内存会话的 key，刷新即新会话）；
 *  - send() 消费 SSE 流，事件归约到最后一个 turn（单在途流，靠 isStreaming 串行）；
 *  - ui.ask 挂起（步骤3）：ask 事件落一张问卡，answerAsk 提交回答后
 *    tool-result 事件沿原 SSE 流回填卡片（会话仍 isStreaming，输入区锁定）；
 *  - profile.propose 成功的慢通道引导（步骤4）：工具卡上的「去确认提议」
 *    跳转按钮（ToolInvocationCard 后置动作），不再用全局提示条。
 */

/** 一轮对话的展示单元：用户消息 → 工具卡片们（流式落卡/回填）→ 助手回复 */
export interface ChatTurn {
  userText: string;
  invocations: ChatInvocation[];
  assistantText: string;
  failed?: string;
  done: boolean;
}

interface ChatSessionValue {
  turns: ChatTurn[];
  isStreaming: boolean;
  send(text: string): Promise<void>;
  /** 回答挂起中的 ui.ask（answer 传 null 表示跳过） */
  answerAsk(callId: string, answer: string | null): Promise<void>;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

/** jsdom/旧浏览器兜底：randomUUID 不可用时退化为时间戳+随机串 */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function patchLast(turns: ChatTurn[], patch: (t: ChatTurn) => ChatTurn): ChatTurn[] {
  if (turns.length === 0) return turns;
  return [...turns.slice(0, -1), patch(turns[turns.length - 1])];
}

/** 事件 → 最后一个 turn 的状态归约（工具卡按 callId 对齐回填结果） */
function applyEvent(turns: ChatTurn[], ev: ChatStreamEvent): ChatTurn[] {
  switch (ev.type) {
    case 'text-delta':
      return patchLast(turns, (t) => ({ ...t, assistantText: t.assistantText + ev.text }));
    case 'tool-call':
      return patchLast(turns, (t) => ({
        ...t,
        invocations: [...t.invocations, { callId: ev.callId, toolId: ev.toolId, args: ev.args }],
      }));
    case 'ask':
      // 挂起提问落一张 ui.ask 卡（args.question 供渲染）；tool-result 到达后回填
      return patchLast(turns, (t) => ({
        ...t,
        invocations: [...t.invocations, { callId: ev.callId, toolId: 'ui.ask', args: { question: ev.question } }],
      }));
    case 'tool-result':
      return patchLast(turns, (t) => ({
        ...t,
        invocations: t.invocations.map((inv) =>
          inv.callId === ev.callId && inv.ok === undefined
            ? { ...inv, ok: ev.ok, payload: ev.payload }
            : inv,
        ),
      }));
    case 'turn-done':
      return patchLast(turns, (t) => ({ ...t, done: true }));
    case 'error':
      return patchLast(turns, (t) => ({ ...t, failed: ev.message, done: true }));
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { message } = AntApp.useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string>(newSessionId());
  const streamingRef = useRef(false);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;
      streamingRef.current = true;
      setIsStreaming(true);
      setTurns((prev) => [
        ...prev,
        { userText: trimmed, invocations: [], assistantText: '', done: false },
      ]);

      try {
        await streamChatMessage(sessionIdRef.current, trimmed, (ev) => {
          setTurns((prev) => applyEvent(prev, ev));
        });
      } catch (e) {
        const errMsg =
          e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED'
            ? '未配置 AI 服务（需要在服务端设置 ONE_AI_MODEL 等环境变量）。'
            : `请求失败：${e instanceof Error ? e.message : String(e)}`;
        setTurns((prev) => patchLast(prev, (t) => ({ ...t, failed: errMsg, done: true })));
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
      }
    },
    [],
  );

  /** 回答挂起中的 ui.ask：走 answer 端点注入 server 侧挂起的流，
   *  终态 tool-result 事件沿原 SSE 连接回来、由归约器回填问卡 */
  const answerAsk = useCallback(
    async (callId: string, answer: string | null) => {
      try {
        await answerChatAsk(sessionIdRef.current, callId, answer);
      } catch (e) {
        message.error(`回答提交失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [message],
  );

  const value = useMemo(
    () => ({ turns, isStreaming, send, answerAsk }),
    [turns, isStreaming, send, answerAsk],
  );
  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatSessionValue {
  const v = useContext(ChatSessionContext);
  if (!v) throw new Error('useChatSession 必须在 <ChatProvider> 内使用');
  return v;
}
