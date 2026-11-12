import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentMessage, ToolCallRequest, ToolCallResult } from '@one/ai';

/**
 * AI 对话存档（本机文件）。
 *
 * 进行中的一轮仍在路由的内存 Map 里。每一轮成功结束后，把模型上下文
 * （AgentMessage[]）和界面气泡一起写进 dbPath 同目录的 chat-threads.json。
 * 刷新或重启后可以打开旧的一段接着聊。
 *
 * 导入文件的全文不进存档。气泡只留文件名和行数；模型上下文里至多还有
 * 当时拼进消息的预览。接着聊时要再按那张表处理，需要重新导入。
 *
 * 明文 JSON，与 ai-config.json 同级的本地可信域假设。写法 temp + rename。
 * :memory: 宿主没有落盘位，存档只活在进程里。
 */

export const CHAT_THREADS_FILE = 'chat-threads.json';
export const CHAT_THREADS_VERSION = 1;
/** 只留最近这么多段 */
export const CHAT_THREAD_LIMIT = 50;
const TITLE_MAX = 40;
const MAX_TURNS = 200;
const MAX_TEXT = 100_000;
const MAX_INVOCATIONS = 40;
const MAX_FILES = 6;
/** 单段超过这个体积就丢掉工具结果明细，避免一份存档把磁盘撑满 */
const MAX_THREAD_CHARS = 1_500_000;
/** 整份文件的软上限。最新的一段始终保留，更旧的往下丢 */
const MAX_FILE_CHARS = 8_000_000;

export interface ChatThreadChip {
  id: string;
  name: string;
  kind: 'table' | 'text';
  rows?: number;
}

export interface ChatThreadInvocation {
  callId: string;
  toolId: string;
  args: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
}

/** 界面上的一轮。和前端 ChatTurn 同形，服务端不依赖 app 包 */
export interface ChatThreadTurn {
  userText: string;
  attachments?: ChatThreadChip[];
  invocations: ChatThreadInvocation[];
  assistantText: string;
  failed?: string;
  failedCode?: string;
  done: boolean;
}

export interface ChatThreadRecord {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatThreadTurn[];
  history: AgentMessage[];
}

export interface ChatThreadSummary {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ChatThreadFile {
  version: typeof CHAT_THREADS_VERSION;
  threads: ChatThreadRecord[];
}

const THREAD_ID = /^[\w-]{1,80}$/;

export function readThreadId(raw: string): string | undefined {
  const id = raw.trim();
  return THREAD_ID.test(id) ? id : undefined;
}

/** dbPath → 存档路径；:memory: 宿主无落盘位 → null（只在进程内有效） */
export function resolveChatThreadsPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_CHAT_THREADS_PATH === 'string' && env.ONE_CHAT_THREADS_PATH.trim()) {
    return env.ONE_CHAT_THREADS_PATH;
  }
  if (dbPath === ':memory:') return null;
  return resolve(dirname(resolve(dbPath)), CHAT_THREADS_FILE);
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

/** 模型消息里的用户原文。带附件时服务端会把预览拼在前面，标题和气泡只留用户说的那句 */
export function plainUserText(text: string): string {
  const marker = '用户说：';
  const at = text.lastIndexOf(marker);
  if (at !== -1) return text.slice(at + marker.length).trim();
  if (text.includes('【附件')) return '';
  return text.trim();
}

export function titleFromTurns(turns: readonly ChatThreadTurn[]): string {
  const first = turns[0];
  if (!first) return '新对话';
  if (first.userText.trim()) return clip(first.userText, TITLE_MAX);
  const file = first.attachments?.find((item) => item.name.trim());
  if (file) return clip(file.name, TITLE_MAX);
  return '新对话';
}

export function titleFromHistory(history: readonly AgentMessage[]): string {
  const first = history.find((msg) => msg.role === 'user');
  if (!first || first.role !== 'user') return '新对话';
  const said = plainUserText(first.text);
  if (said) return clip(said, TITLE_MAX);
  if (first.text.includes('【附件')) return '文件';
  return clip(first.text, TITLE_MAX) || '新对话';
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function clipString(raw: unknown, max: number): string {
  return typeof raw === 'string' ? Array.from(raw).slice(0, max).join('') : '';
}

function sanitizeChip(raw: unknown): ChatThreadChip | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const id = clipString(row.id, 40);
  const name = clipString(row.name, 120).trim();
  if (!id || !name) return undefined;
  if (row.kind !== 'table' && row.kind !== 'text') return undefined;
  const rows = typeof row.rows === 'number' && Number.isFinite(row.rows) ? Math.max(0, Math.floor(row.rows)) : undefined;
  return { id, name, kind: row.kind, ...(rows === undefined ? {} : { rows }) };
}

function sanitizeInvocation(raw: unknown): ChatThreadInvocation | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const callId = clipString(row.callId, 80);
  const toolId = clipString(row.toolId, 120);
  if (!callId || !toolId) return undefined;
  const args = asRecord(row.args) ?? {};
  const inv: ChatThreadInvocation = { callId, toolId, args };
  if (typeof row.ok === 'boolean') inv.ok = row.ok;
  if (row.payload !== undefined) inv.payload = row.payload;
  return inv;
}

function sanitizeTurn(raw: unknown): ChatThreadTurn | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.map(sanitizeChip).filter((item): item is ChatThreadChip => item !== undefined).slice(0, MAX_FILES)
    : undefined;
  const invocations = Array.isArray(row.invocations)
    ? row.invocations
        .map(sanitizeInvocation)
        .filter((item): item is ChatThreadInvocation => item !== undefined)
        .slice(0, MAX_INVOCATIONS)
    : [];
  const failed = clipString(row.failed, 2_000);
  const failedCode = clipString(row.failedCode, 80);
  return {
    userText: clipString(row.userText, MAX_TEXT),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    invocations,
    assistantText: clipString(row.assistantText, MAX_TEXT),
    ...(failed ? { failed } : {}),
    ...(failedCode ? { failedCode } : {}),
    done: row.done === true,
  };
}

/** 客户端传来的气泡。不是数组则拒绝；单条坏了就丢掉 */
export function sanitizeTurns(raw: unknown): ChatThreadTurn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(sanitizeTurn).filter((item): item is ChatThreadTurn => item !== undefined).slice(-MAX_TURNS);
}

function sanitizeCall(raw: unknown): ToolCallRequest | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const callId = clipString(row.callId, 80);
  const toolId = clipString(row.toolId, 120);
  if (!callId || !toolId) return undefined;
  return { callId, toolId, args: asRecord(row.args) ?? {} };
}

function sanitizeResult(raw: unknown): ToolCallResult | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const callId = clipString(row.callId, 80);
  const toolId = clipString(row.toolId, 120);
  if (!callId || !toolId || typeof row.ok !== 'boolean') return undefined;
  return { callId, toolId, ok: row.ok, payload: row.payload };
}

function sanitizeMessage(raw: unknown): AgentMessage | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  if (row.role === 'user' || row.role === 'assistant') {
    return { role: row.role, text: clipString(row.text, MAX_TEXT) };
  }
  if (row.role === 'tool-calls') {
    if (!Array.isArray(row.calls)) return undefined;
    const calls = row.calls.map(sanitizeCall).filter((item): item is ToolCallRequest => item !== undefined);
    if (calls.length === 0) return undefined;
    const text = clipString(row.text, MAX_TEXT);
    return { role: 'tool-calls', ...(text ? { text } : {}), calls };
  }
  if (row.role === 'tool-results') {
    if (!Array.isArray(row.results)) return undefined;
    const results = row.results.map(sanitizeResult).filter((item): item is ToolCallResult => item !== undefined);
    if (results.length === 0) return undefined;
    return { role: 'tool-results', results };
  }
  return undefined;
}

export function sanitizeHistory(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeMessage).filter((item): item is AgentMessage => item !== undefined);
}

/** 客户端还没把气泡写回来时，用模型上下文拼一份能看的记录 */
export function turnsFromHistory(history: readonly AgentMessage[]): ChatThreadTurn[] {
  const turns: ChatThreadTurn[] = [];
  let current: ChatThreadTurn | undefined;
  for (const msg of history) {
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = { userText: plainUserText(msg.text), invocations: [], assistantText: '', done: true };
      continue;
    }
    if (!current) continue;
    if (msg.role === 'assistant') {
      current.assistantText += msg.text;
    } else if (msg.role === 'tool-calls') {
      if (msg.text) current.assistantText += msg.text;
      for (const call of msg.calls) {
        current.invocations.push({ callId: call.callId, toolId: call.toolId, args: call.args });
      }
    } else {
      for (const result of msg.results) {
        const found = [...current.invocations].reverse().find((inv) => inv.callId === result.callId && inv.ok === undefined);
        if (!found) continue;
        found.ok = result.ok;
        found.payload = result.payload;
      }
    }
  }
  if (current) turns.push(current);
  return turns.slice(-MAX_TURNS);
}

/**
 * 已有气泡比模型上下文短，说明最新一轮还没从客户端写回，先用上下文补上。
 * 气泡更长时保留它（失败的一轮只在界面上，不进模型上下文）。
 */
export function mergeTurns(history: readonly AgentMessage[], previous: readonly ChatThreadTurn[] | undefined): ChatThreadTurn[] {
  const synthesized = turnsFromHistory(history);
  if (!previous || previous.length === 0) return synthesized;
  if (synthesized.length > previous.length) return synthesized;
  return [...previous];
}

function shrinkThread(record: ChatThreadRecord): ChatThreadRecord {
  if (JSON.stringify(record).length <= MAX_THREAD_CHARS) return record;
  const note = { note: '结果过长，存档时省略了明细' };
  return {
    ...record,
    history: record.history.map((msg) =>
      msg.role === 'tool-results'
        ? { ...msg, results: msg.results.map((result) => ({ ...result, payload: note })) }
        : msg,
    ),
    turns: record.turns.map((turn) => ({
      ...turn,
      invocations: turn.invocations.map((inv) => (inv.payload === undefined ? inv : { ...inv, payload: note })),
    })),
  };
}

function trimThreads(threads: ChatThreadRecord[]): ChatThreadRecord[] {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  const kept: ChatThreadRecord[] = [];
  let size = 2;
  for (const thread of sorted) {
    if (kept.length >= CHAT_THREAD_LIMIT) break;
    const chunk = JSON.stringify(thread).length;
    if (kept.length > 0 && size + chunk > MAX_FILE_CHARS) break;
    kept.push(thread);
    size += chunk;
  }
  return kept;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toSummary(record: ChatThreadRecord): ChatThreadSummary {
  return {
    id: record.id,
    agentId: record.agentId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isThreadFile(raw: unknown): raw is ChatThreadFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const file = raw as { version?: unknown; threads?: unknown };
  return file.version === CHAT_THREADS_VERSION && Array.isArray(file.threads);
}

function readFile(path: string): ChatThreadRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  if (!isThreadFile(raw)) {
    console.warn(`[one-server] 对话存档不合法，已忽略（${path}）`);
    return [];
  }
  const records: ChatThreadRecord[] = [];
  for (const item of raw.threads) {
    const row = asRecord(item);
    if (!row || typeof row.id !== 'string' || !readThreadId(row.id)) continue;
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
    const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : createdAt;
    const turns = sanitizeTurns(row.turns) ?? [];
    const history = sanitizeHistory(row.history);
    if (turns.length === 0 && history.length === 0) continue;
    records.push({
      id: row.id,
      agentId: clipString(row.agentId, 80) || 'general',
      title: clipString(row.title, TITLE_MAX + 1) || titleFromTurns(turns),
      createdAt,
      updatedAt,
      turns,
      history,
    });
  }
  return trimThreads(records);
}

function writeFile(path: string, threads: ChatThreadRecord[]): void {
  const file: ChatThreadFile = { version: CHAT_THREADS_VERSION, threads };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(file), 'utf-8');
  renameSync(tmp, path);
}

export interface ChatThreadStore {
  readonly path: string | null;
  list(): ChatThreadSummary[];
  get(id: string): ChatThreadRecord | undefined;
  upsert(record: ChatThreadRecord): ChatThreadSummary;
  remove(id: string): boolean;
  clearExcept(exceptId?: string): void;
}

export function createChatThreadStore(path: string | null): ChatThreadStore {
  let threads = path === null ? [] : readFile(path);

  const persist = (): void => {
    threads = trimThreads(threads);
    if (path !== null) writeFile(path, threads);
  };

  return {
    path,
    list() {
      return trimThreads(threads).map(toSummary);
    },
    get(id) {
      const found = threads.find((item) => item.id === id);
      return found ? clone(found) : undefined;
    },
    upsert(record) {
      const next = shrinkThread(clone(record));
      const rest = threads.filter((item) => item.id !== next.id);
      threads = trimThreads([next, ...rest]);
      persist();
      const saved = threads.find((item) => item.id === next.id) ?? next;
      return toSummary(saved);
    },
    remove(id) {
      const before = threads.length;
      threads = threads.filter((item) => item.id !== id);
      if (threads.length === before) return false;
      persist();
      return true;
    },
    clearExcept(exceptId) {
      threads = exceptId ? threads.filter((item) => item.id === exceptId) : [];
      persist();
    },
  };
}
