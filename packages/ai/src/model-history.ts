import { TOOLS_LOAD_ID, toolGroup } from './tool-catalog.js';
import type { AgentMessage, ToolCallResult } from './types.js';

/**
 * 送给模型的历史窗口。
 *
 * 会话里留着完整工具结果（界面气泡和存档都读那一份）。进模型的副本只保留
 * 当前这一轮用户消息之内的工具结果全文，更早的收成「工具名、成败、一句结论」。
 * 结论里留单号、数量这类标识，明细让模型用工具再查。
 * 近处的单次返回也有字符上限，超出就截断并让模型用 limit / offset 再查。
 * tools.load 的整组说明保留到这组工具被成功调用之前（按说明发调用的那一步
 * 还看得到）。调用之后、以及下一条用户消息，都收成一句，要细则再加载。
 * 更早的用户/助手原文和工具参数也截断。不改入参：编排层返回的 messages 仍是全文。
 */

/** 保留工具结果全文的用户轮数（含当前这轮）。再早的收成一句 */
export const RECENT_USER_TURNS_FULL = 1;

/** 保留用户/助手原文的用户轮数（含当前这轮）。再早的截断 */
export const DIALOGUE_TURNS_FULL = 4;

/** 单次工具结果进模型的 JSON 字符上限 */
export const TOOL_RESULT_CHAR_BUDGET = 4000;

/**
 * tools.load 结果（整组完整说明）的字符上限。实测最大组（order）约 6.3K 字符，
 * 8000 放得下全部；真超了才截断。
 */
export const TOOLS_LOAD_CHAR_BUDGET = 8000;

const CONCLUSION_MAX = 120;

/** 更早对话原文、工具参数的字符上限 */
const OLD_TEXT_MAX = 180;

/** 从完整历史做出进模型的副本。窗口内没改过的消息原样引用。 */
export function messagesForModel(messages: readonly AgentMessage[]): AgentMessage[] {
  const resultsFrom = recentTurnStart(messages, RECENT_USER_TURNS_FULL);
  const dialogueFrom = recentTurnStart(messages, DIALOGUE_TURNS_FULL);
  return messages.map((message, index) => {
    if (message.role === 'tool-results') {
      const recent = index >= resultsFrom;
      const results = message.results.map((result) => shapeResult(messages, index, result, recent));
      if (results.every((result, i) => result === message.results[i])) return message;
      return { ...message, results };
    }
    if (index >= dialogueFrom) return message;
    if (message.role === 'user' || message.role === 'assistant') {
      const text = clip(message.text, OLD_TEXT_MAX);
      return text === message.text ? message : { ...message, text };
    }
    if (message.role === 'tool-calls') {
      const text = message.text ? clip(message.text, OLD_TEXT_MAX) : undefined;
      const calls = message.calls.map((call) => {
        const args = clipArgs(call.args);
        return args === call.args ? call : { ...call, args };
      });
      if (text === message.text && calls.every((call, i) => call === message.calls[i])) return message;
      return { ...message, text, calls };
    }
    return message;
  });
}

/**
 * 这份 tools.load 说明下一跳模型调用还用得着吗。
 * 该组已经被成功调用过（同一次结果或之后），说明文档已经用上，可以收起。
 * 别的组、ui.ask 都不算用过：模型可能还要按这份说明继续调这组工具。
 */
function loadStillNeeded(messages: readonly AgentMessage[], index: number, result: ToolCallResult): boolean {
  const group = groupOf(result.payload);
  if (!group) return true;
  for (let i = index; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'tool-results') continue;
    const used = message.results.some(
      (item) => item.ok && item.toolId !== TOOLS_LOAD_ID && toolGroup(item.toolId) === group,
    );
    if (used) return false;
  }
  return true;
}

function shapeResult(
  messages: readonly AgentMessage[],
  index: number,
  result: ToolCallResult,
  recent: boolean,
): ToolCallResult {
  if (!recent) return summarizeResult(result);
  if (result.ok && result.toolId === TOOLS_LOAD_ID && !loadStillNeeded(messages, index, result)) {
    return foldLoad(result);
  }
  return capResult(result);
}

function foldLoad(result: ToolCallResult): ToolCallResult {
  const group = groupOf(result.payload);
  return {
    ...result,
    payload: {
      group,
      folded: true,
      note: group
        ? `【${group}】完整说明已从本轮上下文拿掉。清单里若还有这组工具可以直接调用；没有就重新 tools.load。`
        : '完整说明已从本轮上下文拿掉。需要时重新 tools.load。',
    },
  };
}

function groupOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const group = (payload as { group?: unknown }).group;
  return typeof group === 'string' ? group : '';
}

function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const json = payloadJson(args);
  if (json === undefined || json.length <= OLD_TEXT_MAX) return args;
  return { omitted: true, keys: Object.keys(args), note: '参数过长，已从较早的上下文拿掉' };
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
  const isLoad = result.toolId === TOOLS_LOAD_ID;
  const budget = isLoad ? TOOLS_LOAD_CHAR_BUDGET : TOOL_RESULT_CHAR_BUDGET;
  if (json.length <= budget) return result;
  return {
    ...result,
    payload: {
      truncated: true,
      note: isLoad
        ? '结果过长，已截断。需要其余说明时再次调用 tools.load。'
        : '结果过长，已截断。需要其余部分时用同一工具带 limit 和 offset 再查。',
      preview: json.slice(0, budget),
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

function payloadJson(payload: unknown): string | undefined {
  try {
    const json = JSON.stringify(payload ?? null);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}
