import { describe, it, expect } from 'vitest';
import {
  CONTEXT_BUDGET,
  PREVIOUS_REPLY_MAX,
  TOOL_RESULT_CHAR_BUDGET,
  TOOLS_LOAD_CHAR_BUDGET,
  frameForModel,
} from '../src/model-history.js';
import type { ContextLength } from '../src/model-history.js';
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

function frame(messages: AgentMessage[], length?: ContextLength): string {
  const out = length === undefined ? frameForModel(messages) : frameForModel(messages, length);
  expect(out).toHaveLength(1);
  const message = out[0];
  if (!message || message.role !== 'user') throw new Error('expected user frame');
  return message.text;
}

describe('frameForModel', () => {
  it('还没有工具结果时，原样送出这句请求', () => {
    const messages = [user('你好')];
    expect(frameForModel(messages)).toEqual([messages[0]]);
  });

  it('默认 128K 窗口留更早的原话，工具结果不带', () => {
    const full = { skuCode: 'OLD', quantity: 9, rows: [{ skuCode: 'OLD' }], total: 1 };
    const text = frame([
      user('第一问'),
      results(full),
      { role: 'assistant', text: '第一答' },
      user('第二问'),
      { role: 'assistant', text: '第二答' },
      user('第三问'),
    ]);
    expect(text).toContain('更早的对话：\n用户：第一问\n助手：第一答\n\n用户：第二问');
    expect(text).toContain('上一句回复：\n第二答');
    expect(text).toContain('用户请求：\n第三问');
    expect(text).not.toContain('OLD');
  });

  it('上一句回复超长时留结尾', () => {
    const tail = '单号 OUT-9';
    const text = frame([
      { role: 'assistant', text: `${'甲'.repeat(PREVIOUS_REPLY_MAX)}${tail}` },
      user('改刚才那单'),
    ]);
    expect(text.startsWith('上一句回复：\n…')).toBe(true);
    expect(text).toContain(tail);
    expect(text).toContain('改刚才那单');
  });

  it('这一轮里更早的结果收成一行，最新一批保留全文', () => {
    const text = frame([
      user('查一下再入库'),
      results({ skuCode: 'A-1', quantity: 5 }),
      results({ orderNo: 'IN-1' }, 'wms.order.create'),
    ]);
    expect(text).toContain('这一轮已完成：\n- wms.inventory.query 成功。skuCode=A-1，quantity=5');
    expect(text).toContain('最新结果：\n');
    expect(text).toContain('wms.order.create 成功');
    expect(text).toContain('"orderNo":"IN-1"');
    expect(text).not.toContain('"quantity":5');
  });

  it('同一步的多个结果都留在最新一批', () => {
    const text = frame([
      user('一起查'),
      {
        role: 'tool-results',
        results: [
          { callId: 'c1', toolId: 'wms.inventory.query', ok: true, payload: { skuCode: 'A-1' } },
          { callId: 'c2', toolId: 'wms.order.query', ok: true, payload: { orderNo: 'OUT-1' } },
        ],
      },
    ]);
    expect(text).toContain('wms.inventory.query 成功');
    expect(text).toContain('"skuCode":"A-1"');
    expect(text).toContain('wms.order.query 成功');
    expect(text).toContain('"orderNo":"OUT-1"');
    expect(text).not.toContain('这一轮已完成');
  });

  it('失败的最新结果带上错误全文', () => {
    const text = frame([
      user('出库'),
      {
        role: 'tool-results',
        results: [{ callId: 'c', toolId: 'wms.order.create', ok: false, payload: { error: '库存不足' } }],
      },
    ]);
    expect(text).toContain('wms.order.create 失败');
    expect(text).toContain('库存不足');
  });

  it('近处的单次结果超过上限就截断', () => {
    const payload = { note: 'x'.repeat(TOOL_RESULT_CHAR_BUDGET) };
    const text = frame([user('只这一问'), results(payload)]);
    expect(text).toContain('已截断');
    expect(text).not.toContain('x'.repeat(TOOL_RESULT_CHAR_BUDGET));
  });

  it('还没用过的说明留在任务框里，调用成功后只留一行', () => {
    const docs = { group: 'order', toolIds: ['wms.order.create'], docs: '分配策略的完整规则' };
    const pending = frame([user('开单'), results(docs, 'tools.load')]);
    expect(pending).toContain('分配策略的完整规则');
    expect(pending).not.toContain('最新结果');

    const used = frame([
      user('开单'),
      results(docs, 'tools.load'),
      results({ orderNo: 'IN-1' }, 'wms.order.create'),
    ]);
    expect(used).not.toContain('分配策略');
    expect(used).toContain('group=order，1 个工具');
    expect(used).toContain('"orderNo":"IN-1"');

    const other = frame([
      user('开单'),
      results(docs, 'tools.load'),
      results({ skuCode: 'A-1' }, 'wms.inventory.query'),
    ]);
    expect(other).toContain('分配策略的完整规则');
    expect(other).toContain('"skuCode":"A-1"');
  });

  it('说明超过自己的上限才截断', () => {
    const huge = { group: 'order', toolIds: [], docs: 'y'.repeat(TOOLS_LOAD_CHAR_BUDGET + 20) };
    const text = frame([user('开单'), results(huge, 'tools.load')]);
    expect(text).toContain('说明过长已截断');
    expect(text).not.toContain('y'.repeat(TOOLS_LOAD_CHAR_BUDGET + 20));
  });

  it('上一轮加载过的说明不进下一句', () => {
    const docs = { group: 'order', toolIds: ['wms.order.create'], docs: '分配策略的完整规则' };
    const text = frame([
      user('开单'),
      results(docs, 'tools.load'),
      { role: 'assistant', text: '开好了 IN-1' },
      user('再看看'),
    ]);
    expect(text).toContain('上一句回复：\n开好了 IN-1');
    expect(text).toContain('用户请求：\n再看看');
    expect(text).not.toContain('分配策略');
    expect(text).not.toContain('group=order');
  });

  it('向用户提问的回答带上原来的问题', () => {
    const text = frame([
      user('入库'),
      { role: 'tool-calls', calls: [{ callId: 'c', toolId: 'ui.ask', args: { question: '要入多少个？' } }] },
      {
        role: 'tool-results',
        results: [{ callId: 'c', toolId: 'ui.ask', ok: true, payload: { answer: '20 个' } }],
      },
    ]);
    expect(text).toContain('问题：要入多少个？');
    expect(text).toContain('回答：20 个');
  });

  it('没超过窗口时保留更早的原话，工具原文和时间前缀不带', () => {
    const earlier = [
      user('当前时间：2026-01-01T00:00:00.000Z\n【附件 a】表.xlsx\n\n用户说：第一问'),
      results({ skuCode: 'SECRET-SKU', rows: [{ skuCode: 'SECRET-SKU' }] }),
      { role: 'assistant' as const, text: '第一答' },
      user('当前时间：2026-01-01T00:00:01.000Z\n第二问'),
      { role: 'assistant' as const, text: '第二答' },
      user('第三问'),
    ];
    const text = frame(earlier, '1m');
    expect(text).toContain('更早的对话：\n用户：第一问\n助手：第一答\n\n用户：第二问');
    expect(text).toContain('上一句回复：\n第二答');
    expect(text).toContain('用户请求：\n第三问');
    expect(text).not.toContain('SECRET-SKU');
    expect(text).not.toContain('当前时间');
    expect(text).not.toContain('表.xlsx');
  });

  it('超过所选窗口时压缩最旧的轮次', () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(user(`${'甲'.repeat(20_000)}问尾${i}`));
      messages.push({ role: 'assistant', text: `${'乙'.repeat(20_000)}答尾${i}` });
    }
    messages.push(user('现在问'));
    const text = frame(messages, '64k');
    expect(text).toContain('问尾3');
    expect(text).toContain('问尾2');
    expect(text).toContain(' → ');
    expect(text).not.toContain('问尾0');
    expect(text).not.toContain('答尾0');
    expect(sectionLengths(text).total).toBeLessThanOrEqual(CONTEXT_BUDGET['64k']);
  });
});

function sectionLengths(text: string): { total: number } {
  const earlier = text.split('更早的对话：\n')[1]?.split('\n\n上一句回复：')[0] ?? '';
  const reply = text.split('上一句回复：\n')[1]?.split('\n\n用户请求：')[0] ?? '';
  return { total: earlier.length + reply.length };
}
