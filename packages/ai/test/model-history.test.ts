import { describe, it, expect } from 'vitest';
import {
  DIALOGUE_TURNS_FULL,
  RECENT_USER_TURNS_FULL,
  TOOL_RESULT_CHAR_BUDGET,
  TOOLS_LOAD_CHAR_BUDGET,
  messagesForModel,
} from '../src/model-history.js';
import type { AgentMessage } from '../src/types.js';

function user(text: string): AgentMessage {
  return { role: 'user', text };
}

function results(payload: unknown, toolId = 'wms.inventory.query'): AgentMessage {
  return {
    role: 'tool-results',
    results: [{ callId: 'c', toolId, ok: true, payload }],
  };
}

describe('messagesForModel', () => {
  it('只保留当前这轮用户消息里的工具结果全文，上一轮收成一句', () => {
    expect(RECENT_USER_TURNS_FULL).toBe(1);
    const payload = { skuCode: 'A-1', quantity: 5 };
    const messages: AgentMessage[] = [
      user('上一问'),
      results(payload),
      { role: 'assistant', text: '好' },
      user('这一问'),
      results({ skuCode: 'A-1', quantity: 8 }),
    ];
    const out = messagesForModel(messages);
    expect(out[1]).not.toBe(messages[1]);
    const older = out[1];
    if (older.role !== 'tool-results') throw new Error('expected tool-results');
    expect(older.results[0].payload).toEqual({ summary: 'wms.inventory.query 成功。skuCode=A-1，quantity=5' });
    expect(out[4]).toBe(messages[4]);
  });

  it('更早的工具结果收成一句，且不改原历史', () => {
    const payload = { rows: [{ skuCode: 'OLD' }], total: 3 };
    const old = results(payload);
    const messages: AgentMessage[] = [
      user('第一问'),
      old,
      { role: 'assistant', text: '第一答' },
      user('第二问'),
      { role: 'assistant', text: '第二答' },
      user('第三问'),
    ];
    const out = messagesForModel(messages);
    expect(out[1]).not.toBe(old);
    expect(out[1]).toEqual({
      role: 'tool-results',
      results: [
        {
          callId: 'c',
          toolId: 'wms.inventory.query',
          ok: true,
          payload: { summary: 'wms.inventory.query 成功。共 3 条，本页 1 条' },
        },
      ],
    });
    expect(old).toEqual(results(payload));
  });

  it('失败结果的一句结论带上错误', () => {
    const messages: AgentMessage[] = [
      user('一'),
      {
        role: 'tool-results',
        results: [{ callId: 'c', toolId: 'wms.order.create', ok: false, payload: { error: '库存不足' } }],
      },
      { role: 'assistant', text: '没做成' },
      user('二'),
      { role: 'assistant', text: '好' },
      user('三'),
    ];
    const out = messagesForModel(messages);
    const first = out[1];
    if (first.role !== 'tool-results') throw new Error('expected tool-results');
    expect(first.results[0].payload).toEqual({ summary: 'wms.order.create 失败。库存不足' });
  });

  it('近处的单次结果超过上限就截断，并提示翻页', () => {
    const payload = { note: 'x'.repeat(TOOL_RESULT_CHAR_BUDGET) };
    const messages: AgentMessage[] = [user('只这一问'), results(payload)];
    const out = messagesForModel(messages);
    const sent = out[1];
    if (sent.role !== 'tool-results') throw new Error('expected tool-results');
    const body = sent.results[0].payload as { truncated: boolean; note: string; preview: string };
    expect(body.truncated).toBe(true);
    expect(body.note).toContain('limit');
    expect(body.preview.length).toBe(TOOL_RESULT_CHAR_BUDGET);
    expect(JSON.stringify(body)).not.toContain('x'.repeat(TOOL_RESULT_CHAR_BUDGET));
    expect(messages[1]).toEqual(results(payload));
  });

  it('tools.load 的说明结果用更大预算：超过普通上限不截，超过自己的上限才截', () => {
    const fits = { group: 'order', toolIds: [], docs: 'x'.repeat(TOOL_RESULT_CHAR_BUDGET + 500) };
    const intact = messagesForModel([user('只这一问'), results(fits, 'tools.load')]);
    const kept = intact[1];
    if (kept.role !== 'tool-results') throw new Error('expected tool-results');
    expect(kept.results[0].payload).toBe(fits);

    const huge = { group: 'order', toolIds: [], docs: 'y'.repeat(TOOLS_LOAD_CHAR_BUDGET) };
    const clipped = messagesForModel([user('只这一问'), results(huge, 'tools.load')]);
    const sent = clipped[1];
    if (sent.role !== 'tool-results') throw new Error('expected tool-results');
    const body = sent.results[0].payload as { truncated: boolean; note: string; preview: string };
    expect(body.truncated).toBe(true);
    expect(body.note).toContain('tools.load');
    expect(body.preview.length).toBe(TOOLS_LOAD_CHAR_BUDGET);
  });

  it('本组工具已经调用成功后，tools.load 的说明收成一句；没调用前保留', () => {
    const docs = { group: 'order', toolIds: ['wms.order.create'], docs: '分配策略的完整规则' };
    const pending = messagesForModel([user('开单'), results(docs, 'tools.load')]);
    const kept = pending[1];
    if (kept.role !== 'tool-results') throw new Error('expected tool-results');
    expect(kept.results[0].payload).toBe(docs);

    const used = messagesForModel([
      user('开单'),
      results(docs, 'tools.load'),
      results({ orderNo: 'IN-1' }, 'wms.order.create'),
    ]);
    const folded = used[1];
    if (folded.role !== 'tool-results') throw new Error('expected tool-results');
    expect(JSON.stringify(folded.results[0].payload)).not.toContain('分配策略');
    expect(folded.results[0].payload).toMatchObject({ group: 'order', folded: true });
    // 别的组先跑，order 的说明还留着
    const other = messagesForModel([
      user('开单'),
      results(docs, 'tools.load'),
      results({ skuCode: 'A-1' }, 'wms.inventory.query'),
    ]);
    const still = other[1];
    if (still.role !== 'tool-results') throw new Error('expected tool-results');
    expect(still.results[0].payload).toBe(docs);
  });

  it('上一轮的 tools.load 只留组名，不带整组说明', () => {
    const docs = { group: 'order', toolIds: ['wms.order.create'], docs: '分配策略的完整规则' };
    const out = messagesForModel([
      user('开单'),
      results(docs, 'tools.load'),
      { role: 'assistant', text: '开好了 IN-1' },
      user('再看看'),
    ]);
    const sent = out[1];
    if (sent.role !== 'tool-results') throw new Error('expected tool-results');
    expect(sent.results[0].payload).toEqual({ summary: 'tools.load 成功。group=order，1 个工具' });
    expect(JSON.stringify(sent)).not.toContain('分配策略');
  });

  it('更早的对话原文和工具参数被截断，近四轮原文保留', () => {
    expect(DIALOGUE_TURNS_FULL).toBe(4);
    const long = '甲'.repeat(400);
    const fat = { lines: '乙'.repeat(400) };
    const messages: AgentMessage[] = [
      user(long),
      {
        role: 'tool-calls',
        text: long,
        calls: [{ callId: 'c', toolId: 'wms.order.create', args: fat }],
      },
      { role: 'assistant', text: long },
      user('二'),
      { role: 'assistant', text: '二答' },
      user('三'),
      { role: 'assistant', text: '三答' },
      user('四'),
      { role: 'assistant', text: '四答' },
      user('五'),
    ];
    const out = messagesForModel(messages);
    const first = out[0];
    if (first.role !== 'user') throw new Error('expected user');
    expect(first.text.endsWith('…')).toBe(true);
    expect(first.text.length).toBeLessThan(long.length);
    const calls = out[1];
    if (calls.role !== 'tool-calls') throw new Error('expected tool-calls');
    expect(calls.calls[0].args).toEqual({
      omitted: true,
      keys: ['lines'],
      note: '参数过长，已从较早的上下文拿掉',
    });
    expect(JSON.stringify(calls)).not.toContain('乙乙');
    const recent = out[3];
    if (recent.role !== 'user') throw new Error('expected user');
    expect(recent.text).toBe('二');
    expect(messages[0]).toEqual(user(long));
  });
});
