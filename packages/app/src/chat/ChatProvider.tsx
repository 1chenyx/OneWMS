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
 *  - contextLength：这一窗的上下文窗口上限（64K 到 2M）。没超过就留更早的原话，超过后从最旧的一轮压缩。
 *    屏幕上的气泡和存档仍是全文。换长度不改历史时间；
 *  - 可以同时开多段。每一段各自流式，停止只打断这一段；
 *  - send() 消费这一段的 SSE。事件归约到这一段的最后一轮；
 *  - ui.ask 挂起时问卡落在这一段，answerAsk 提交后沿原 SSE 回填；
 *  - profile.propose 成功后，当前这一段立刻弹确认。
 */

/** 一轮对话的展示单元：用户消息 → 工具卡片们（流式落卡/回填）→ 助手回复 */
export type ChatTurn = ChatThreadTurn & {
  /** 这一轮开始的时间，只用来显示已运行多久，不写入存档 */
  startedAt?: number;
};

/** 空字符串表示用户刚开了新对话，刷新后留在空白页 */
export const CHAT_OPEN_THREAD_KEY = 'onewms.chat.openThreadId';

/** 同时开着的多段。只有一段时不写，刷新仍走原来的那一个 id */
export const CHAT_WINDOWS_KEY = 'onewms.chat.windows';

/** 上次选的上下文长度。新窗口没单独选过时用这一份 */
export const CHAT_CONTEXT_KEY = 'onewms.chat.contextLength';

/** 同时摆开的对话窗口上限。再多就会挡住仓库页面 */
export const MAX_CHAT_WINDOWS = 4;

/** 上下文窗口上限。默认 128K */
export type ChatContextLength = '64k' | '128k' | '256k' | '512k' | '1m' | '2m';

const CONTEXT_LENGTHS = new Set<ChatContextLength>(['64k', '128k', '256k', '512k', '1m', '2m']);

export const DEFAULT_CHAT_CONTEXT: ChatContextLength = '128k';

interface ChatWindowData {
  id: string;
  threadId: string;
  turns: ChatTurn[];
  agentId: string;
  profileId?: string;
  model?: string;
  contextLength: ChatContextLength;
  streaming: boolean;
}

export interface ChatWindowSummary {
  id: string;
  threadId: string;
  title: string;
  streaming: boolean;
}

interface ChatSessionValue {
  windowId: string;
  turns: ChatTurn[];
  isStreaming: boolean;
  /** 当前这段的 id（存档和内存会话用同一个） */
  threadId: string;
  /** 历史列表，新的在前 */
  threads: ChatThreadSummary[];
  /** 当前助手 id（M16；缺省 'general'） */
  agentId: string;
  /** 切换助手：当前段先收进历史，再换新会话并清空画面。这一窗正在回复时不动 */
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
  /** 这一窗送给模型的上下文长度。换它不换会话，也不改历史时间 */
  contextLength: ChatContextLength;
  setContextLength(next: ChatContextLength): void;
  send(text: string, attachments?: ChatAttachmentPayload[]): Promise<void>;
  /** 回答挂起中的 ui.ask（answer 传 null 表示跳过） */
  answerAsk(callId: string, answer: string | null): Promise<void>;
  /** 停掉这一窗正在进行的回复。已经写出的文字留下，模型上下文不收录这一轮 */
  stop(): void;
  /** 当前段收进历史，画面清空。这一窗正在回复时不动 */
  newChat(): void;
  /** 打开存档里的一段。这一窗正在回复时改开到新窗口 */
  openThread(id: string): Promise<void>;
  deleteThread(id: string): Promise<void>;
  /** 删掉其余存档。正在看的这一段留下 */
  clearThreads(): Promise<void>;
  refreshThreads(): Promise<void>;
  windows: ChatWindowSummary[];
  activeWindowId: string;
  /** 任一窗口还在回复 */
  anyStreaming: boolean;
  windowCount: number;
  /** 再开一个空白窗口，正在回复的那一窗继续 */
  openWindow(): void;
  focusWindow(id: string): void;
  /** 关掉这一窗。最后一窗留下一段空白对话 */
  closeWindow(id: string): void;
  /** 绑到指定窗口。页和浮窗各看各的 */
  view(windowId: string): ChatSessionValue;
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

export function readContextLength(): ChatContextLength {
  try {
    const raw = localStorage.getItem(CHAT_CONTEXT_KEY);
    if (raw && CONTEXT_LENGTHS.has(raw as ChatContextLength)) return raw as ChatContextLength;
  } catch {
    // 读不到就用 128K
  }
  return DEFAULT_CHAT_CONTEXT;
}

function writeContextLength(value: ChatContextLength): void {
  try {
    localStorage.setItem(CHAT_CONTEXT_KEY, value);
  } catch {
    // 隐私模式写不进时，这一窗里的选择仍然有效
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
      return patchLast(turns, (t) => ({ ...t, done: true, ...(ev.usage ? { usage: ev.usage } : {}) }));
    case 'error':
      return patchLast(turns, (t) => ({ ...t, failed: ev.message, done: true }));
  }
}

function sortThreads(threads: ChatThreadSummary[]): ChatThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function blankWindow(
  from?: Pick<ChatWindowData, 'agentId' | 'profileId' | 'model' | 'contextLength'>,
): ChatWindowData {
  return {
    id: newSessionId(),
    threadId: newSessionId(),
    turns: [],
    agentId: from?.agentId ?? 'general',
    profileId: from?.profileId,
    model: from?.model,
    contextLength: from?.contextLength ?? readContextLength(),
    streaming: false,
  };
}

function windowTitle(win: ChatWindowData, threads: readonly ChatThreadSummary[]): string {
  const said = [...win.turns].reverse().find((turn) => turn.userText.trim());
  if (said) return said.userText.trim().slice(0, 24);
  return threads.find((thread) => thread.id === win.threadId)?.title ?? '新对话';
}

function markStopped(turns: ChatTurn[]): ChatTurn[] {
  return patchLast(turns, (turn) => (turn.done ? turn : { ...turn, stopped: true, done: true }));
}

/** 这一轮从发出到结束的用时。已经记过的不再改 */
function stampElapsed(turns: ChatTurn[], startedAt: number): ChatTurn[] {
  const elapsedMs = Math.max(0, Math.floor(Date.now() - startedAt));
  return patchLast(turns, (turn) => {
    const { startedAt: _startedAt, ...rest } = turn;
    return turn.elapsedMs !== undefined ? rest : { ...rest, elapsedMs };
  });
}

/** 存档只留用时。开始时刻是界面上的临时字段 */
function archiveTurns(turns: readonly ChatTurn[]): ChatThreadTurn[] {
  return turns.map((turn) => {
    const { startedAt: _startedAt, ...rest } = turn;
    return rest;
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface StoredWindow {
  threadId: string;
  agentId: string;
}

function readStoredWindows(): StoredWindow[] | null {
  try {
    const raw = localStorage.getItem(CHAT_WINDOWS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const windows = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { threadId?: unknown; agentId?: unknown };
      if (typeof row.threadId !== 'string' || !row.threadId) return [];
      return [{ threadId: row.threadId, agentId: typeof row.agentId === 'string' && row.agentId ? row.agentId : 'general' }];
    });
    return windows.length > 1 ? windows : null;
  } catch {
    return null;
  }
}

function writeStoredWindows(list: readonly ChatWindowData[]): void {
  try {
    if (list.length <= 1) localStorage.removeItem(CHAT_WINDOWS_KEY);
    else {
      localStorage.setItem(
        CHAT_WINDOWS_KEY,
        JSON.stringify(list.map((win) => ({ threadId: win.threadId, agentId: win.agentId }))),
      );
    }
  } catch {
    // 隐私模式写不进时，刷新后只恢复当前这一段
  }
}

const ChatScopeContext = createContext<string | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { message } = AntApp.useApp();
  const seedRef = useRef<ChatWindowData[] | null>(null);
  if (seedRef.current === null) seedRef.current = [blankWindow()];
  const seeded = seedRef.current;
  const [windows, setWindows] = useState<ChatWindowData[]>(seeded);
  const [activeId, setActiveId] = useState(seeded[0]!.id);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const windowsRef = useRef(seeded);
  const activeIdRef = useRef(seeded[0]!.id);
  const abortsRef = useRef(new Map<string, AbortController>());
  const viewRef = useRef<(id: string) => ChatSessionValue>(() => {
    throw new Error('对话窗口还没准备好');
  });
  const mountedRef = useRef(true);
  /** 用户在存档还没装回来时发了消息或换了段，过期的装载不再覆盖画面 */
  const epochRef = useRef(0);

  const replaceWindows = useCallback((next: ChatWindowData[]) => {
    windowsRef.current = next;
    setWindows(next);
  }, []);

  const patchWin = useCallback((id: string, patch: (win: ChatWindowData) => ChatWindowData) => {
    const current = windowsRef.current;
    const index = current.findIndex((win) => win.id === id);
    if (index < 0) return;
    const next = current.slice();
    next[index] = patch(current[index]!);
    replaceWindows(next);
  }, [replaceWindows]);

  const focus = useCallback((id: string, persist = false) => {
    if (!windowsRef.current.some((win) => win.id === id)) return;
    const changed = activeIdRef.current !== id;
    if (changed) {
      activeIdRef.current = id;
      setActiveId(id);
    }
    if (!persist) return;
    const win = windowsRef.current.find((item) => item.id === id);
    // 空白新对话记下的是空字符串。点一下输入框不能把它改成新的会话 id
    if (!win || (win.turns.length === 0 && readOpenThread() === '')) return;
    writeOpenThread(win.threadId);
  }, []);

  const remember = useCallback(
    (id: string, agent: string, snapshot: ChatTurn[]) => {
      if (snapshot.length === 0) return;
      void saveChatThread(id, { agentId: agent, turns: archiveTurns(snapshot) })
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
    const still = () => alive && stamp === epochRef.current;
    void (async () => {
      try {
        const stored = readStoredWindows();
        if (stored) {
          const loaded: ChatWindowData[] = [];
          for (const item of stored) {
            if (!still()) return;
            try {
              const detail = await resumeChatThread(item.threadId);
              if (!still()) return;
              loaded.push({
                id: newSessionId(),
                threadId: detail.id,
                turns: detail.turns ?? [],
                agentId: detail.agentId || item.agentId || 'general',
                contextLength: readContextLength(),
                streaming: false,
              });
            } catch {
              if (!still()) return;
              loaded.push({
                id: newSessionId(),
                threadId: item.threadId,
                turns: [],
                agentId: item.agentId || 'general',
                contextLength: readContextLength(),
                streaming: false,
              });
            }
          }
          if (!still() || loaded.length < 2) return;
          replaceWindows(loaded);
          const openId = readOpenThread();
          const match = (openId ? loaded.find((win) => win.threadId === openId) : undefined) ?? loaded[loaded.length - 1]!;
          activeIdRef.current = match.id;
          setActiveId(match.id);
          const list = await listChatThreads();
          if (still()) setThreads(sortThreads(list));
          return;
        }

        const saved = readOpenThread();
        if (saved === '') {
          const list = await listChatThreads();
          if (still() && windowsRef.current.length === 1) setThreads(sortThreads(list));
          return;
        }
        let opened = false;
        if (saved) {
          try {
            const detail = await resumeChatThread(saved);
            if (!still() || windowsRef.current.length !== 1) return;
            const first = windowsRef.current[0];
            if (!first || first.turns.length > 0) return;
            patchWin(first.id, (win) => ({
              ...win,
              threadId: detail.id,
              agentId: detail.agentId || 'general',
              turns: detail.turns ?? [],
            }));
            writeOpenThread(detail.id);
            opened = true;
          } catch {
            writeOpenThread(null);
          }
        }
        const list = await listChatThreads();
        if (!still() || windowsRef.current.length !== 1) return;
        setThreads(sortThreads(list));
        if (opened || readOpenThread() === '') return;
        const latest = list[0];
        if (!latest) return;
        const detail = await resumeChatThread(latest.id);
        if (!still() || windowsRef.current.length !== 1) return;
        const first = windowsRef.current[0];
        if (!first || first.turns.length > 0 || readOpenThread() === '') return;
        patchWin(first.id, (win) => ({
          ...win,
          threadId: detail.id,
          agentId: detail.agentId || 'general',
          turns: detail.turns ?? [],
        }));
        writeOpenThread(detail.id);
      } catch {
        // 存档读不到就从空白对话开始
      }
    })();
    return () => {
      alive = false;
      mountedRef.current = false;
    };
  }, [patchWin, replaceWindows]);

  const openKeyFor = (threadId: string) => (windowsRef.current.length <= 1 ? '' : threadId);

  /** 切换助手：这一窗正在回复时不动。当前段先收进历史，再换新会话并清空这一窗 */
  const setAgentFor = useCallback(
    (windowId: string, next: string) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || next === win.agentId || win.streaming) return;
      epochRef.current += 1;
      remember(win.threadId, win.agentId, win.turns);
      const threadId = newSessionId();
      patchWin(windowId, (item) => ({ ...item, agentId: next, threadId, turns: [] }));
      if (activeIdRef.current === windowId) writeOpenThread(openKeyFor(threadId));
      writeStoredWindows(windowsRef.current);
    },
    [patchWin, remember],
  );

  /** 换这一窗送给模型的上下文长度。不换会话，不改历史时间。正在回复时不动 */
  const setContextFor = useCallback(
    (windowId: string, next: ChatContextLength) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || win.streaming || next === win.contextLength) return;
      writeContextLength(next);
      patchWin(windowId, (item) => ({ ...item, contextLength: next }));
    },
    [patchWin],
  );

  /** 切换已保存的接入点，或同一条上的模型名。不换会话。这一窗正在回复时不动 */
  const setProfileFor = useCallback(
    (windowId: string, next: string | undefined, nextModel?: string) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || win.streaming) return;
      const id = next?.trim() || undefined;
      const picked = id && nextModel?.trim() ? nextModel.trim() : undefined;
      if (id === win.profileId && picked === win.model) return;
      patchWin(windowId, (item) => ({ ...item, profileId: id, model: picked }));
    },
    [patchWin],
  );

  const newChatFor = useCallback(
    (windowId: string) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || win.streaming || win.turns.length === 0) return;
      epochRef.current += 1;
      remember(win.threadId, win.agentId, win.turns);
      const threadId = newSessionId();
      patchWin(windowId, (item) => ({ ...item, threadId, turns: [] }));
      if (activeIdRef.current === windowId) writeOpenThread(openKeyFor(threadId));
      writeStoredWindows(windowsRef.current);
    },
    [patchWin, remember],
  );

  const loadInto = useCallback(
    async (windowId: string, id: string, stamp: number) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || win.streaming) return;
      try {
        if (win.turns.length > 0 && win.threadId !== id) {
          const saved = await saveChatThread(win.threadId, { agentId: win.agentId, turns: archiveTurns(win.turns) });
          if (mountedRef.current) {
            setThreads((prev) => sortThreads([saved, ...prev.filter((item) => item.id !== saved.id)]));
          }
        }
        const detail = await resumeChatThread(id);
        if (!mountedRef.current || stamp !== epochRef.current) return;
        const latest = windowsRef.current.find((item) => item.id === windowId);
        if (!latest || latest.streaming) return;
        patchWin(windowId, (item) => ({
          ...item,
          threadId: detail.id,
          agentId: detail.agentId || 'general',
          turns: detail.turns ?? [],
        }));
        if (activeIdRef.current === windowId) writeOpenThread(detail.id);
        writeStoredWindows(windowsRef.current);
      } catch (err) {
        if (mountedRef.current) {
          message.error(`打不开这段对话：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    [message, patchWin],
  );

  const openThreadFor = useCallback(
    async (windowId: string, id: string) => {
      const current = windowsRef.current.find((item) => item.id === windowId);
      if (!current) return;
      if (current.streaming) {
        const existing = windowsRef.current.find((item) => item.threadId === id);
        if (existing) {
          focus(existing.id, true);
          return;
        }
        if (windowsRef.current.length >= MAX_CHAT_WINDOWS) {
          message.warning('最多同时打开 4 个对话窗口');
          return;
        }
        epochRef.current += 1;
        const created = blankWindow({
          agentId: current.agentId,
          profileId: current.profileId,
          model: current.model,
          contextLength: current.contextLength,
        });
        const next = [...windowsRef.current, created];
        replaceWindows(next);
        activeIdRef.current = created.id;
        setActiveId(created.id);
        writeStoredWindows(next);
        await loadInto(created.id, id, epochRef.current);
        return;
      }
      const other = windowsRef.current.find((item) => item.id !== windowId && item.threadId === id);
      if (other) {
        focus(other.id, true);
        return;
      }
      if (id === current.threadId && current.turns.length > 0) return;
      epochRef.current += 1;
      await loadInto(windowId, id, epochRef.current);
    },
    [focus, loadInto, message, replaceWindows],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      const owner = windowsRef.current.find((win) => win.threadId === id);
      if (owner?.streaming) return;
      epochRef.current += 1;
      if (owner) {
        const threadId = newSessionId();
        patchWin(owner.id, (win) => ({ ...win, threadId, turns: [] }));
        if (owner.id === activeIdRef.current) writeOpenThread(openKeyFor(threadId));
        writeStoredWindows(windowsRef.current);
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
    [message, patchWin, refreshThreads],
  );

  const clearThreads = useCallback(async () => {
    if (windowsRef.current.some((win) => win.streaming)) return;
    const active = windowsRef.current.find((win) => win.id === activeIdRef.current) ?? windowsRef.current[0];
    if (!active) return;
    try {
      if (active.turns.length > 0) {
        const saved = await saveChatThread(active.threadId, { agentId: active.agentId, turns: archiveTurns(active.turns) });
        if (mountedRef.current) {
          setThreads((prev) => sortThreads([saved, ...prev.filter((item) => item.id !== saved.id)]));
        }
      }
      await clearChatThreads(active.turns.length > 0 ? active.threadId : undefined);
      if (mountedRef.current) await refreshThreads();
    } catch (err) {
      if (mountedRef.current) message.error(`清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [message, refreshThreads]);

  const stop = useCallback((id: string) => {
    abortsRef.current.get(id)?.abort();
  }, []);

  const sendFor = useCallback(
    async (windowId: string, text: string, attachments?: ChatAttachmentPayload[]) => {
      const trimmed = text.trim();
      const files = attachments && attachments.length > 0 ? attachments : undefined;
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win || win.streaming || (!trimmed && !files)) return;
      epochRef.current += 1;
      const controller = new AbortController();
      abortsRef.current.set(windowId, controller);
      const threadId = win.threadId;
      const agentId = win.agentId;
      const profileId = win.profileId;
      const model = win.model;
      const contextLength = win.contextLength;
      const startedAt = Date.now();
      let localTurns: ChatTurn[] = [
        ...win.turns,
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
          startedAt,
        },
      ];
      patchWin(windowId, (item) => ({ ...item, turns: localTurns, streaming: true }));
      focus(windowId, true);

      const onEvent = (ev: ChatStreamEvent) => {
        if (controller.signal.aborted) return;
        localTurns = applyEvent(localTurns, ev);
        patchWin(windowId, (item) => ({ ...item, turns: localTurns }));
      };
      try {
        if (contextLength === DEFAULT_CHAT_CONTEXT) {
          await streamChatMessage(threadId, trimmed, agentId, onEvent, files, profileId, model, controller.signal);
        } else {
          await streamChatMessage(
            threadId,
            trimmed,
            agentId,
            onEvent,
            files,
            profileId,
            model,
            controller.signal,
            contextLength,
          );
        }
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) {
          localTurns = markStopped(localTurns);
        } else {
          const errMsg =
            e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED'
              ? '未配置 AI 服务——请在左侧「AI 模型」页面完成配置。'
              : e instanceof ApiError && e.code === 'AGENT_NOT_FOUND'
                ? '该助手不存在，可能定义已被修改——请重新选择助手。'
                : `请求失败：${e instanceof Error ? e.message : String(e)}`;
          const apiCode = e instanceof ApiError ? e.code : undefined;
          localTurns = patchLast(localTurns, (turn) => ({ ...turn, failed: errMsg, failedCode: apiCode, done: true }));
        }
        patchWin(windowId, (item) => ({ ...item, turns: localTurns }));
      } finally {
        if (controller.signal.aborted) localTurns = markStopped(localTurns);
        localTurns = stampElapsed(localTurns, startedAt);
        abortsRef.current.delete(windowId);
        patchWin(windowId, (item) => ({ ...item, streaming: false, turns: localTurns }));
        if (activeIdRef.current === windowId) writeOpenThread(threadId);
        remember(threadId, agentId, localTurns);
        writeStoredWindows(windowsRef.current);
      }
    },
    [focus, patchWin, remember],
  );

  /** 回答挂起中的 ui.ask。终态沿原来的 SSE 回来，回填这一窗的问卡 */
  const answerFor = useCallback(
    async (windowId: string, callId: string, answer: string | null) => {
      const win = windowsRef.current.find((item) => item.id === windowId);
      if (!win) return;
      try {
        await answerChatAsk(win.threadId, callId, answer);
      } catch (e) {
        message.error(`回答提交失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [message],
  );

  const openWindow = useCallback(() => {
    if (windowsRef.current.length >= MAX_CHAT_WINDOWS) {
      message.warning('最多同时打开 4 个对话窗口');
      return;
    }
    epochRef.current += 1;
    const active = windowsRef.current.find((item) => item.id === activeIdRef.current) ?? windowsRef.current[0];
    const created = blankWindow(
      active
        ? {
            agentId: active.agentId,
            profileId: active.profileId,
            model: active.model,
            contextLength: active.contextLength,
          }
        : undefined,
    );
    const next = [...windowsRef.current, created];
    replaceWindows(next);
    activeIdRef.current = created.id;
    setActiveId(created.id);
    writeStoredWindows(next);
    writeOpenThread(created.threadId);
  }, [message, replaceWindows]);

  const focusWindow = useCallback(
    (id: string) => {
      focus(id, true);
    },
    [focus],
  );

  const closeWindow = useCallback(
    (id: string) => {
      const win = windowsRef.current.find((item) => item.id === id);
      if (!win) return;
      stop(id);
      if (win.turns.length > 0) remember(win.threadId, win.agentId, win.turns);
      epochRef.current += 1;
      const index = windowsRef.current.findIndex((item) => item.id === id);
      const rest = windowsRef.current.filter((item) => item.id !== id);
      if (rest.length === 0) {
        const fresh = blankWindow({
          agentId: win.agentId,
          profileId: win.profileId,
          model: win.model,
          contextLength: win.contextLength,
        });
        replaceWindows([fresh]);
        activeIdRef.current = fresh.id;
        setActiveId(fresh.id);
        writeOpenThread('');
        writeStoredWindows([fresh]);
        return;
      }
      replaceWindows(rest);
      if (activeIdRef.current === id) {
        const neighbor = rest[Math.min(index, rest.length - 1)] ?? rest[0]!;
        activeIdRef.current = neighbor.id;
        setActiveId(neighbor.id);
        writeOpenThread(neighbor.threadId);
      }
      writeStoredWindows(rest);
    },
    [remember, replaceWindows, stop],
  );

  const view = useCallback(
    (windowId: string): ChatSessionValue => {
      const win = windows.find((item) => item.id === windowId) ?? windows[0];
      if (!win) throw new Error('没有对话窗口');
      return {
        windowId: win.id,
        turns: win.turns,
        isStreaming: win.streaming,
        threadId: win.threadId,
        threads,
        agentId: win.agentId,
        setAgentId: (next) => setAgentFor(win.id, next),
        profileId: win.profileId,
        model: win.model,
        setProfileId: (next, nextModel) => setProfileFor(win.id, next, nextModel),
        contextLength: win.contextLength,
        setContextLength: (next) => setContextFor(win.id, next),
        send: (text, files) => sendFor(win.id, text, files),
        answerAsk: (callId, answer) => answerFor(win.id, callId, answer),
        stop: () => stop(win.id),
        newChat: () => newChatFor(win.id),
        openThread: (id) => openThreadFor(win.id, id),
        deleteThread,
        clearThreads,
        refreshThreads,
        windows: windows.map((item) => ({
          id: item.id,
          threadId: item.threadId,
          title: windowTitle(item, threads),
          streaming: item.streaming,
        })),
        activeWindowId: activeId,
        anyStreaming: windows.some((item) => item.streaming),
        windowCount: windows.length,
        openWindow,
        focusWindow,
        closeWindow,
        view: (id: string) => viewRef.current(id),
      };
    },
    [
      activeId,
      answerFor,
      clearThreads,
      closeWindow,
      deleteThread,
      focusWindow,
      newChatFor,
      openThreadFor,
      openWindow,
      refreshThreads,
      sendFor,
      setAgentFor,
      setContextFor,
      setProfileFor,
      stop,
      threads,
      windows,
    ],
  );
  viewRef.current = view;

  const value = useMemo(() => view(activeId), [activeId, view]);
  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatSessionValue {
  const v = useContext(ChatSessionContext);
  if (!v) throw new Error('useChatSession 必须在 <ChatProvider> 内使用');
  return v;
}

/** 把历史、新对话、新窗口绑到点下去的那一窗。没包的时候看当前窗 */
export function ChatScope({ windowId, children }: { windowId?: string; children: ReactNode }) {
  const session = useChatSession();
  const id = windowId ?? session.activeWindowId;
  return <ChatScopeContext.Provider value={id}>{children}</ChatScopeContext.Provider>;
}

export function useChatScope(): ChatSessionValue {
  const session = useChatSession();
  const id = useContext(ChatScopeContext);
  if (!id || id === session.windowId) return session;
  return session.view(id);
}
