import type { AgentMessage, ToolCallResult } from './types.js';

/**
 * 送给模型的历史窗口。
 *
 * 会话里留着完整工具结果（界面气泡和存档都读那一份）。进模型的副本只保留
 * 最近两轮用户消息之内的工具结果全文，更早的收成「工具名、成败、一句结论」。
 * 近处的单次返回也有字符上限，超出就截断并让模型用 limit / offset 再查。
 * 不改入参：编排层返回的 messages 仍是全文。
 */

/** 保留全文的用户轮数（含当前这轮）。再早的工具结果收成一句 */
export const RECENT_USER_TURNS_FULL = 2;

/** 单次工具结果进模型的 JSON 字符上限 */
export const TOOL_RESULT_CHAR_BUDGET = 8000;

const CONCLUSION_MAX = 120;

/** 从完整历史做出进模型的副本。非工具消息原样引用。 */
export function messagesForModel(messages: readonly AgentMessage[]): AgentMessage[] {
  const keepFrom = recentTurnStart(messages, RECENT_USER_TURNS_FULL);
  return messages.map((message, index) => {
    if (message.role !== 'tool-results') return message;
    const recent = index >= keepFrom;
    const results = message.results.map((result) => (recent ? capResult(result) : summarizeResult(result)));
    if (results.every((result, i) => result === message.results[i])) return message;
    return { ...message, results };
  });
}

/** 倒数第 turns 条用户消息的下标。不够则从开头保留。 */
function recentTurnStart(messages: readonly AgentMessage[], turns: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    seen += 1;
    if (seen === turns) return i;
  }
  return 0;
}

function capResult(result: ToolCallResult): ToolCallResult {
  const json = payloadJson(result.payload);
  if (json === undefined) {
    return {
      ...result,
      payload: { truncated: true, note: '结果无法序列化，已省略。需要时重新查询。' },
    };
  }
  if (json.length <= TOOL_RESULT_CHAR_BUDGET) return result;
  return {
    ...result,
    payload: {
      truncated: true,
      note: '结果过长，已截断。需要其余部分时用同一工具带 limit 和 offset 再查。',
      preview: json.slice(0, TOOL_RESULT_CHAR_BUDGET),
    },
  };
}

function summarizeResult(result: ToolCallResult): ToolCallResult {
  return { ...result, payload: { summary: oneLine(result) } };
}

function oneLine(result: ToolCallResult): string {
  const status = result.ok ? '成功' : '失败';
  const detail = clip(conclusion(result.payload), CONCLUSION_MAX);
  return detail ? `${result.toolId} ${status}。${detail}` : `${result.toolId} ${status}`;
}

function conclusion(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
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

function payloadJson(payload: unknown): string | undefined {
  try {
    const json = JSON.stringify(payload ?? null);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}
