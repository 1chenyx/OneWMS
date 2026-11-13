import { describe, it, expect } from 'vitest';
import {
  RECENT_USER_TURNS_FULL,
  TOOL_RESULT_CHAR_BUDGET,
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
  it('最近两轮用户消息之内的工具结果保持全文', () => {
    expect(RECENT_USER_TURNS_FULL).toBe(2);
    const payload = { skuCode: 'A-1', quantity: 5 };
    const messages: AgentMessage[] = [user('上一问'), results(payload), { role: 'assistant', text: '好' }, user('这一问')];
    const out = messagesForModel(messages);
    expect(out[1]).toBe(messages[1]);
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
});
