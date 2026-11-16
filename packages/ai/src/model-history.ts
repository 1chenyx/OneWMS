import { LOADED_GROUP_KEEP, TOOLS_LOAD_ID, toolGroup } from './tool-catalog.js';
import type { AgentMessage, ToolCallRequest, ToolCallResult } from './types.js';

/**
 * 送给模型的任务框。
 *
 * 会话里留着完整对话和工具结果（界面气泡和存档都读那一份）。
 * 每一次模型调用不重放这段记录，只新组任务框：
 *  - 这一句用户请求
 *  - 上一句助手回复（接「改刚才那单」，超长留结尾）
 *  - 更早的对话：放进用户选的窗口（64K 到 2M）。装得下就留原话，超出后从最旧的一轮压成短行，再装不下就丢掉
 *  - 这一轮已经做成的事，每件一行（单号、数量）。还没用过的 tools.load 说明只出现一次
 *  - 还没处理的最新一批结果
 * 没有这些补充时，原样送出用户消息。不改入参。
 */

/** 上一句回复的字符上限。超长留结尾，单号通常写在句末 */
export const PREVIOUS_REPLY_MAX = 800;

/**
 * 上下文窗口上限，单位是 token。按字符估算（约一字一个 token），用来守住所选窗口。
 * 上一句回复和更早对话的正文一起算，栏目标题不算。
 */
export const CONTEXT_BUDGET = {
  '64k': 64_000,
  '128k': 128_000,
  '256k': 256_000,
  '512k': 512_000,
  '1m': 1_000_000,
  '2m': 2_000_000,
} as const;

/** 用户选的最大上下文。默认 128K */
export type ContextLength = keyof typeof CONTEXT_BUDGET;

export const DEFAULT_CONTEXT_LENGTH: ContextLength = '128k';

/** 更早一轮的用户原话，压成一行时的字数 */
const DIGEST_USER_MAX = 40;

/** 更早一轮的助手回复，压成一行时的字数 */
const DIGEST_REPLY_MAX = 80;

/** 与 wms-agent 的时间行相同。这里单独写，避免和装配层互相引用 */
const TIME_LINE = /^当前时间：\S+\n/;

const USER_SAID = '用户说：';

/** 单次工具结果进任务框的 JSON 字符上限 */
export const TOOL_RESULT_CHAR_BUDGET = 4000;

/**
 * tools.load 说明的字符上限。单据拆开后最大的一组约 3K 字符，
 * 8000 放得下；真超了才截断。
 */
export const TOOLS_LOAD_CHAR_BUDGET = 8000;

const CONCLUSION_MAX = 120;

/** 从完整历史做出这一步的任务框。窗口外的内容不进模型。 */
export function frameForModel(
  messages: readonly AgentMessage[],
  contextLength: ContextLength = DEFAULT_CONTEXT_LENGTH,
): AgentMessage[] {
  const turnAt = lastUserIndex(messages);
  if (turnAt < 0) return [{ role: 'user', text: '' }];
  const request = messages[turnAt];
  if (!request || request.role !== 'user') return [{ role: 'user', text: '' }];

  const prior = previousReply(messages, turnAt);
  const earlier = earlierDigest(messages, turnAt, contextLength, prior?.length ?? 0);
  const done: string[] = [];
  const docs: string[] = [];
  const latest: string[] = [];
  const rounds = resultRounds(messages, turnAt);
  const pending = rounds.flatMap((round) =>
    round.results.filter((result) => isPendingLoad(messages, round.index, result)),
  );
  const shownDocs = new Set(pending.slice(-LOADED_GROUP_KEEP));

  rounds.forEach((round, roundIndex) => {
    const isLatest = roundIndex === rounds.length - 1;
    for (const result of round.results) {
      if (isPendingLoad(messages, round.index, result)) {
        const text = shownDocs.has(result) ? docsText(result) : undefined;
        if (text) docs.push(text);
        else done.push(oneLine(result));
        continue;
      }
      if (isLatest && result.toolId !== TOOLS_LOAD_ID) {
        latest.push(renderLatest(messages, result));
        continue;
      }
      done.push(oneLine(result));
    }
  });

  if (!earlier && !prior && done.length === 0 && docs.length === 0 && latest.length === 0) return [request];

  const parts: string[] = [];
  if (earlier) parts.push(`更早的对话：\n${earlier}`);
  if (prior) parts.push(`上一句回复：\n${prior}`);
  parts.push(`用户请求：\n${request.text}`);
  if (done.length > 0) parts.push(`这一轮已完成：\n${done.map((line) => `- ${line}`).join('\n')}`);
  if (docs.length > 0) parts.push(docs.join('\n\n'));
  if (latest.length > 0) parts.push(`最新结果：\n${latest.join('\n\n')}`);
  return [{ role: 'user', text: parts.join('\n\n') }];
}

function lastUserIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

interface SpokenTurn {
  user: string;
  reply?: string;
}

/**
 * 这一句之前的对话。从最近一轮往前装进所选窗口：整轮放得下就留原话，
 * 放不下就改成短行，短行也放不下就停，更旧的丢掉。
 * 字数只算正文和上一句回复，不算「更早的对话」「上一句回复」这几个字。
 */
function earlierDigest(
  messages: readonly AgentMessage[],
  turnAt: number,
  contextLength: ContextLength,
  priorLength: number,
): string | undefined {
  const room = CONTEXT_BUDGET[contextLength] - priorLength;
  if (room <= 0) return undefined;
  const turns = turnsBefore(messages, turnAt);
  const full: string[] = [];
  let used = 0;
  let index = turns.length - 1;
  for (; index >= 0; index--) {
    const turn = turns[index];
    if (!turn) continue;
    const block = fullBlock(turn, index < turns.length - 1);
    const extra = block.length + (full.length > 0 ? 2 : 0);
    if (used + extra > room) break;
    full.push(block);
    used += extra;
  }
  const compressed: string[] = [];
  for (; index >= 0; index--) {
    const turn = turns[index];
    if (!turn) continue;
    const line = compressedLine(turn, index < turns.length - 1);
    if (!line) continue;
    const extra = line.length + (compressed.length > 0 ? 1 : full.length > 0 ? 2 : 0);
    if (used + extra > room) break;
    compressed.push(line);
    used += extra;
  }
  const older = compressed.reverse().join('\n');
  const recent = full.reverse().join('\n\n');
  if (older && recent) return `${older}\n\n${recent}`;
  return recent || older || undefined;
}

/** 当前这句之前的每一轮用户原话，以及那一轮的助手回复。工具结果不收进来 */
function turnsBefore(messages: readonly AgentMessage[], turnAt: number): SpokenTurn[] {
  const turns: SpokenTurn[] = [];
  for (let i = 0; i < turnAt; i++) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    let reply = '';
    for (let j = i + 1; j < turnAt; j++) {
      const next = messages[j];
      if (!next || next.role === 'user') break;
      if (next.role === 'assistant' && next.text.trim()) reply = next.text.trim();
    }
    const user = spokenUser(message.text);
    if (!user) continue;
    turns.push({ user, reply: reply || undefined });
  }
  return turns;
}

/** 去掉开头的时间行。附件消息只留「用户说：」后面的那句 */
function spokenUser(text: string): string {
  const stripped = text.replace(TIME_LINE, '');
  const at = stripped.lastIndexOf(USER_SAID);
  const said = at >= 0 ? stripped.slice(at + USER_SAID.length) : stripped;
  return said.replace(/\s+/g, ' ').trim();
}

/** 窗口还装得下时，留这一轮的原话。紧挨着的上一轮回复在「上一句回复」里，这里只留用户原话 */
function fullBlock(turn: SpokenTurn, includeReply: boolean): string {
  if (!includeReply || !turn.reply) return `用户：${turn.user}`;
  return `用户：${turn.user}\n助手：${turn.reply.trim()}`;
}

/** 这一轮原话放不下时压成一行。上一轮的回复仍不重复 */
function compressedLine(turn: SpokenTurn, includeReply: boolean): string | undefined {
  const user = clip(turn.user, DIGEST_USER_MAX);
  if (!user) return undefined;
  if (!includeReply) return `用户：${user}`;
  const reply = turn.reply ? clip(turn.reply, DIGEST_REPLY_MAX) : '';
  return reply ? `用户：${user} → ${reply}` : `用户：${user}`;
}

/** 紧挨着这句请求的上一条助手回复。超长留结尾 */
function previousReply(messages: readonly AgentMessage[], turnAt: number): string | undefined {
  for (let i = turnAt - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role === 'user') return undefined;
    if (message.role !== 'assistant') continue;
    const text = message.text.trim();
    if (!text) continue;
    return clipTail(text, PREVIOUS_REPLY_MAX);
  }
  return undefined;
}

interface ResultRound {
  index: number;
  results: ToolCallResult[];
}

function resultRounds(messages: readonly AgentMessage[], turnAt: number): ResultRound[] {
  const rounds: ResultRound[] = [];
  for (let i = turnAt + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === 'tool-results') rounds.push({ index: i, results: message.results });
  }
  return rounds;
}

/**
 * 这份 tools.load 说明下一跳还用得着吗。
 * 该组已经被成功调用过，说明就已经用上，任务框里不再带全文。
 */
function isPendingLoad(messages: readonly AgentMessage[], index: number, result: ToolCallResult): boolean {
  if (!result.ok || result.toolId !== TOOLS_LOAD_ID) return false;
  const group = groupOf(result.payload);
  if (!group) return false;
  for (let i = index; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'tool-results') continue;
    const after = i === index ? message.results.slice(message.results.indexOf(result) + 1) : message.results;
    const used = after.some(
      (item) => item.ok && item.toolId !== TOOLS_LOAD_ID && toolGroup(item.toolId) === group,
    );
    if (used) return false;
  }
  return true;
}

function docsText(result: ToolCallResult): string | undefined {
  if (!result.payload || typeof result.payload !== 'object') return undefined;
  const docs = (result.payload as { docs?: unknown }).docs;
  if (typeof docs !== 'string' || !docs.trim()) return undefined;
  if (docs.length <= TOOLS_LOAD_CHAR_BUDGET) return docs;
  return `${docs.slice(0, TOOLS_LOAD_CHAR_BUDGET)}\n…说明过长已截断。需要其余时再 tools.load。`;
}

function renderLatest(messages: readonly AgentMessage[], result: ToolCallResult): string {
  const status = result.ok ? '成功' : '失败';
  const lines = [`${result.toolId} ${status}`];
  const question = askedQuestion(messages, result);
  if (question) lines.push(`问题：${question}`);
  const answer = askAnswer(result);
  if (answer) {
    lines.push(answer);
    return lines.join('\n');
  }
  lines.push(JSON.stringify(cappedPayload(result)));
  return lines.join('\n');
}

function askAnswer(result: ToolCallResult): string | undefined {
  if (result.toolId !== 'ui.ask' || !result.payload || typeof result.payload !== 'object') return undefined;
  const record = result.payload as { answer?: unknown; declined?: unknown };
  if (typeof record.answer === 'string') return `回答：${record.answer}`;
  if (record.declined === true) return '用户没有回答';
  return undefined;
}

function askedQuestion(messages: readonly AgentMessage[], result: ToolCallResult): string | undefined {
  if (result.toolId !== 'ui.ask') return undefined;
  for (const message of messages) {
    if (message.role !== 'tool-calls') continue;
    const call = message.calls.find((item) => item.callId === result.callId);
    const question = questionOf(call);
    if (question) return question;
  }
  return undefined;
}

function questionOf(call: ToolCallRequest | undefined): string | undefined {
  const question = call?.args.question;
  return typeof question === 'string' && question.trim() ? question.trim() : undefined;
}

function cappedPayload(result: ToolCallResult): unknown {
  const json = payloadJson(result.payload);
  if (json === undefined) return { truncated: true, note: '结果无法序列化，已省略。需要时重新查询。' };
  if (json.length <= TOOL_RESULT_CHAR_BUDGET) return result.payload;
  return {
    truncated: true,
    note: '结果过长，已截断。需要其余部分时用同一工具带 limit 和 offset 再查。',
    preview: json.slice(0, TOOL_RESULT_CHAR_BUDGET),
  };
}

function groupOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const group = (payload as { group?: unknown }).group;
  return typeof group === 'string' ? group : '';
}

function oneLine(result: ToolCallResult): string {
  const status = result.ok ? '成功' : '失败';
  const detail = clip(conclusion(result.payload), CONCLUSION_MAX);
  return detail ? `${result.toolId} ${status}。${detail}` : `${result.toolId} ${status}`;
}

function conclusion(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (Array.isArray(payload)) return `${payload.length} 条`;
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.answer === 'string') return record.answer;
  if (record.declined === true) return '用户没有回答';
  if (typeof record.group === 'string' && typeof record.docs === 'string') {
    const n = Array.isArray(record.toolIds) ? record.toolIds.length : 0;
    return n > 0 ? `group=${record.group}，${n} 个工具` : `group=${record.group}`;
  }
  if (typeof record.total === 'number' && Array.isArray(record.rows)) {
    return `共 ${record.total} 条，本页 ${record.rows.length} 条`;
  }
  if (Array.isArray(record.rows)) return `${record.rows.length} 条`;
  const bits: string[] = [];
  for (const key of ['orderNo', 'skuCode', 'name', 'title', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) bits.push(`${key}=${value.trim()}`);
    else if (typeof value === 'number') bits.push(`${key}=${value}`);
  }
  if (typeof record.quantity === 'number') bits.push(`quantity=${record.quantity}`);
  return bits.join('，');
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

function payloadJson(payload: unknown): string | undefined {
  try {
    const json = JSON.stringify(payload ?? null);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}
