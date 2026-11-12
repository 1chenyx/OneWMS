import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp } from 'antd';
import {
  ApiError,
  answerChatAsk,
  clearChatThreads,
  deleteChatThread,
  listChatThreads,
  resumeChatThread,
  saveChatThread,
  streamChatMessage,
} from '../api/client';
import type { ChatAttachmentPayload, ChatStreamEvent, ChatThreadSummary, ChatThreadTurn } from '../api/client';

/**
 * AI 会话壳（M12：SSE 流式 + 会话化；M16：多助手切换）：
 *  - 状态在 ChatProvider（App 级 context）——切页不丢对话；
 *  - 每一段在服务端存档。刷新后打开上次那一段；新对话会先把当前段收进历史；
 *  - agentId（M16）：当前助手。切换时先存档，再换新 sessionId 并清空画面；
 *  - profileId：这一次对话选用的已保存接入点（地址和密钥）。没选时不传，服务端用当前配置；
 *    model：只在同一条上改模型名时才传。切换厂商或模型都不换会话；
 *  - send() 消费 SSE 流，事件归约到最后一个 turn（单在途流，靠 isStreaming 串行）；
 *  - ui.ask 挂起（步骤3）：ask 事件落一张问卡，answerAsk 提交回答后
 *    tool-result 事件沿原 SSE 流回填卡片（会话仍 isStreaming，输入区锁定）；
 *  - profile.propose 成功的慢通道闭环（步骤4）：提议在对话页立刻弹窗，
 *    人工确认或拒绝（配置确认页已并入，不再跳页）。
 */

/** 一轮对话的展示单元：用户消息 → 工具卡片们（流式落卡/回填）→ 助手回复 */
export type ChatTurn = ChatThreadTurn;

/** 空字符串表示用户刚开了新对话，刷新后留在空白页 */
export const CHAT_OPEN_THREAD_KEY = 'onewms.chat.openThreadId';

interface ChatSessionValue {
  turns: ChatTurn[];
  isStreaming: boolean;
  /** 当前这段的 id（存档和内存会话用同一个） */
  threadId: string;
  /** 历史列表，新的在前 */
  threads: ChatThreadSummary[];
  /** 当前助手 id（M16；缺省 'general'） */
  agentId: string;
  /** 切换助手：当前段先收进历史，再换新会话并清空画面 */
  setAgentId(agentId: string): void;
  /** 用户在输入框里选定的已保存接入点；未选为 undefined（沿用当前配置） */
  profileId?: string;
  /** 同一接入点上改用的模型名。和这条保存的模型名相同时不传。 */
  model?: string;
  /**
   * 切换厂商或模型：下一轮用这一条的地址和密钥，对话历史保留。
   * model 只在和这条保存的模型名不同时传入。profileId 传空表示回到当前配置。
   */
  setProfileId(profileId: string | undefined, model?: string): void;
  send(text: string, attachments?: ChatAttachmentPayload[]): Promise<void>;
  /** 回答挂起中的 ui.ask（answer 传 null 表示跳过） */
  answerAsk(callId: string, answer: string | null): Promise<void>;
  /** 当前段收进历史，画面清空 */
  newChat(): void;
  /** 打开存档里的一段，可以接着聊 */
  openThread(id: string): Promise<void>;
  deleteThread(id: string): Promise<void>;
  /** 删掉其余存档。正在看的这一段留下 */
  clearThreads(): Promise<void>;
  refreshThreads(): Promise<void>;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

/** jsdom/旧浏览器兜底：randomUUID 不可用时退化为时间戳+随机串 */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readOpenThread(): string | null {
  try {
    return localStorage.getItem(CHAT_OPEN_THREAD_KEY);
  } catch {
    return null;
  }
}

function writeOpenThread(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
    else localStorage.setItem(CHAT_OPEN_THREAD_KEY, id);
  } catch {
    // 隐私模式写不进本地存储时，这一次刷新不再自动打开
  }
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

function sortThreads(threads: ChatThreadSummary[]): ChatThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { message } = AntApp.useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentId, setAgentIdState] = useState('general');
  const [profileId, setProfileState] = useState<string | undefined>(undefined);
  const [model, setModelState] = useState<string | undefined>(undefined);
  const [threadId, setThreadId] = useState(newSessionId);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const sessionIdRef = useRef(threadId);
  const turnsRef = useRef<ChatTurn[]>([]);
  const agentIdRef = useRef('general');
  const profileRef = useRef<string | undefined>(undefined);
  const modelRef = useRef<string | undefined>(undefined);
  const streamingRef = useRef(false);
  const mountedRef = useRef(true);
  /** 用户在存档还没装回来时发了消息或换了段，过期的装载不再覆盖画面 */
  const epochRef = useRef(0);

  const commitTurns = useCallback((next: ChatTurn[]) => {
    turnsRef.current = next;
    setTurns(next);
  }, []);

  const adoptThread = useCallback((id: string) => {
    sessionIdRef.current = id;
    setThreadId(id);
  }, []);

  const remember = useCallback(
    (id: string, agent: string, snapshot: ChatTurn[]) => {
      if (snapshot.length === 0) return;
      void saveChatThread(id, { agentId: agent, turns: snapshot })
        .then((saved) => {
          if (!mountedRef.current) return;
          setThreads((prev) => sortThreads([saved, ...prev.filter((item) => item.id !== saved.id)]));
        })
        .catch(() => {
          if (mountedRef.current) message.warning('这段对话没能存进历史');
        });
    },
    [message],
  );

  const refreshThreads = useCallback(async () => {
    try {
      const list = await listChatThreads();
      if (mountedRef.current) setThreads(sortThreads(list));
    } catch {
      // 清单暂时读不到就留着屏幕上的一份
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const stamp = epochRef.current;
    let alive = true;
    void (async () => {
      try {
        const saved = readOpenThread();
        if (saved === '') {
          const list = await listChatThreads();
          if (alive && stamp === epochRef.current) setThreads(sortThreads(list));
          return;
        }
        let opened = false;
        if (saved) {
          try {
            const detail = await resumeChatThread(saved);
            if (!alive || stamp !== epochRef.current) return;
            adoptThread(detail.id);
            agentIdRef.current = detail.agentId || 'general';
            setAgentIdState(agentIdRef.current);
            commitTurns(detail.turns ?? []);
            writeOpenThread(detail.id);
            opened = true;
          } catch {
            writeOpenThread(null);
          }
        }
        const list = await listChatThreads();
        if (!alive || stamp !== epochRef.current) return;
        setThreads(sortThreads(list));
        if (opened || readOpenThread() === '') return;
        const latest = list[0];
        if (!latest) return;
        const detail = await resumeChatThread(latest.id);
        if (!alive || stamp !== epochRef.current || turnsRef.current.length > 0 || readOpenThread() === '') return;
        adoptThread(detail.id);
        agentIdRef.current = detail.agentId || 'general';
        setAgentIdState(agentIdRef.current);
        commitTurns(detail.turns ?? []);
        writeOpenThread(detail.id);
      } catch {
        // 存档读不到就从空白对话开始
      }
    })();
    return () => {
      alive = false;
      mountedRef.current = false;
    };
  }, [adoptThread, commitTurns]);

  /** 切换助手（M16）：流式中不切。当前段先收进历史，画面马上清空 */
  const setAgentId = useCallback(
    (next: string) => {
      if (next === agentIdRef.current || streamingRef.current) return;
      epochRef.current += 1;
      const snapshot = turnsRef.current;
      const sid = sessionIdRef.current;
      const agent = agentIdRef.current;
      agentIdRef.current = next;
      adoptThread(newSessionId());
      commitTurns([]);
      setAgentIdState(next);
      writeOpenThread('');
      remember(sid, agent, snapshot);
    },
    [adoptThread, commitTurns, remember],
  );

  /** 切换已保存的接入点，或同一条上的模型名。不换会话。流式中锁定。 */
  const setProfileId = useCallback((next: string | undefined, nextModel?: string) => {
    if (streamingRef.current) return;
    const id = next?.trim() || undefined;
    const picked = id && nextModel?.trim() ? nextModel.trim() : undefined;
    if (id === profileRef.current && picked === modelRef.current) return;
    profileRef.current = id;
    modelRef.current = picked;
    setProfileState(id);
    setModelState(picked);
  }, []);

  const newChat = useCallback(() => {
    if (streamingRef.current || turnsRef.current.length === 0) return;
    epochRef.current += 1;
    const snapshot = turnsRef.current;
    const sid = sessionIdRef.current;
    const agent = agentIdRef.current;
    adoptThread(newSessionId());
    commitTurns([]);
    writeOpenThread('');
    remember(sid, agent, snapshot);
  }, [adoptThread, commitTurns, remember]);

  const openThread = useCallback(
    async (id: string) => {
      if (streamingRef.current) return;
      if (id === sessionIdRef.current && turnsRef.current.length > 0) return;
      epochRef.current += 1;
      const stamp = epochRef.current;
      const snapshot = turnsRef.current;
      const sid = sessionIdRef.current;
      const agent = agentIdRef.current;
      try {
        if (snapshot.length > 0 && sid !== id) {
          const saved = await saveChatThread(sid, { agentId: agent, turns: snapshot });
          if (mountedRef.current) {
            setThreads((prev) => sortThreads([saved, ...prev.filter((item) => item.id !== saved.id)]));
          }
        }
        const detail = await resumeChatThread(id);
        if (!mountedRef.current || stamp !== epochRef.current) return;
        adoptThread(detail.id);
        agentIdRef.current = detail.agentId || 'general';
        setAgentIdState(agentIdRef.current);
        commitTurns(detail.turns ?? []);
        writeOpenThread(detail.id);
      } catch (err) {
        if (mountedRef.current) {
          message.error(`打不开这段对话：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    [adoptThread, commitTurns, message],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      if (streamingRef.current && id === sessionIdRef.current) return;
      epochRef.current += 1;
      if (id === sessionIdRef.current) {
        adoptThread(newSessionId());
        commitTurns([]);
        writeOpenThread('');
      }
      setThreads((prev) => prev.filter((item) => item.id !== id));
      try {
        await deleteChatThread(id);
      } catch (err) {
        if (!mountedRef.current) return;
        message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
        await refreshThreads();
      }
    },
    [adoptThread, commitTurns, message, refreshThreads],
  );

  const clearThreads = useCallback(async () => {
    if (streamingRef.current) return;
    const snapshot = turnsRef.current;
    const sid = sessionIdRef.current;
    const agent = agentIdRef.current;
    try {
      if (snapshot.length > 0) {
        const saved = await saveChatThread(sid, { agentId: agent, turns: snapshot });
        if (mountedRef.current) {
          setThreads((prev) => sortThreads([saved, ...prev.filter((item) => item.id !== saved.id)]));
        }
      }
      await clearChatThreads(snapshot.length > 0 ? sid : undefined);
      if (mountedRef.current) await refreshThreads();
    } catch (err) {
      if (mountedRef.current) message.error(`清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [message, refreshThreads]);

  const send = useCallback(
    async (text: string, attachments?: ChatAttachmentPayload[]) => {
      const trimmed = text.trim();
      const files = attachments && attachments.length > 0 ? attachments : undefined;
      if ((!trimmed && !files) || streamingRef.current) return;
      epochRef.current += 1;
      streamingRef.current = true;
      setIsStreaming(true);
      commitTurns([
        ...turnsRef.current,
        {
          userText: trimmed,
          attachments: files?.map((file) => ({
            id: file.id,
            name: file.name,
            kind: file.kind,
            rows: file.kind === 'table' ? file.rows.length : undefined,
          })),
          invocations: [],
          assistantText: '',
          done: false,
        },
      ]);

      try {
        const onEvent = (ev: ChatStreamEvent) => {
          commitTurns(applyEvent(turnsRef.current, ev));
        };
        const chosen = profileRef.current;
        const override = modelRef.current;
        if (chosen && override) {
          await streamChatMessage(
            sessionIdRef.current,
            trimmed,
            agentIdRef.current,
            onEvent,
            files,
            chosen,
            override,
          );
        } else if (chosen) {
          await streamChatMessage(sessionIdRef.current, trimmed, agentIdRef.current, onEvent, files, chosen);
        } else {
          await streamChatMessage(sessionIdRef.current, trimmed, agentIdRef.current, onEvent, files);
        }
      } catch (e) {
        const errMsg =
          e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED'
            ? '未配置 AI 服务——请在左侧「AI 模型」页面完成配置。'
            : e instanceof ApiError && e.code === 'AGENT_NOT_FOUND'
              ? '该助手不存在，可能定义已被修改——请重新选择助手。'
              : `请求失败：${e instanceof Error ? e.message : String(e)}`;
        const apiCode = e instanceof ApiError ? e.code : undefined;
        commitTurns(patchLast(turnsRef.current, (t) => ({ ...t, failed: errMsg, failedCode: apiCode, done: true })));
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
        const sid = sessionIdRef.current;
        const agent = agentIdRef.current;
        const snapshot = turnsRef.current;
        writeOpenThread(sid);
        remember(sid, agent, snapshot);
      }
    },
    [commitTurns, remember],
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
    () => ({
      turns,
      isStreaming,
      threadId,
      threads,
      agentId,
      setAgentId,
      profileId,
      model,
      setProfileId,
      send,
      answerAsk,
      newChat,
      openThread,
      deleteThread,
      clearThreads,
      refreshThreads,
    }),
    [
      turns,
      isStreaming,
      threadId,
      threads,
      agentId,
      setAgentId,
      profileId,
      model,
      setProfileId,
      send,
      answerAsk,
      newChat,
      openThread,
      deleteThread,
      clearThreads,
      refreshThreads,
    ],
  );
  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatSessionValue {
  const v = useContext(ChatSessionContext);
  if (!v) throw new Error('useChatSession 必须在 <ChatProvider> 内使用');
  return v;
}
