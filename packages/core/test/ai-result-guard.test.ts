import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, AI_RESULT_MAX_BYTES, fitResultForAi, type ToolDefinition } from '../src/index.js';

/**
 * AI 结果守门（ToolBus 宪法级护栏）：
 *  - actor 'ai:*' 的调用结果超预算 → 截断并带 _truncated 标记；
 *  - 非 ai actor（REST / 节点默认）→ 原样返回，不受影响；
 *  - ≤ 预算结果零侵入（同一引用直通）。
 */

let core: OneCore;
let ws: ReturnType<OneCore['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = core.workspace('ws-guard');
});

afterEach(() => {
  core.close();
});

/** 返回 1000 项 ~100 字符串的大数组（序列化远超 32KB） */
const bigArrayTool: ToolDefinition = {
  id: 'test.big.array',
  label: '大数组工具',
  description: '测试用',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  handler: () => Array.from({ length: 1000 }, (_, i) => `row-${i}-${'x'.repeat(100)}`),
};

/** 返回含大数组属性的对象 */
const bigObjectTool: ToolDefinition = {
  id: 'test.big.object',
  label: '大对象工具',
  description: '测试用',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  handler: () => ({ summary: 'ok', rows: Array.from({ length: 1000 }, (_, i) => ({ n: i, pad: 'y'.repeat(100) })) }),
};

const smallTool: ToolDefinition = {
  id: 'test.small',
  label: '小结果工具',
  description: '测试用',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  handler: () => ({ ok: true, items: [1, 2, 3] }),
};

describe('AI 结果守门：总线层按 actor 生效', () => {
  it('ai:* actor 调用大数组工具 → 截断为 { items, totalItems, _truncated, _hint }', async () => {
    ws.tools.register(bigArrayTool);
    const result = (await ws.tools.invoke('test.big.array', {}, 'ai:general')) as {
      items: unknown[];
      totalItems: number;
      _truncated: boolean;
      _hint: string;
    };
    expect(result._truncated).toBe(true);
    expect(result.totalItems).toBe(1000);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThan(1000);
    expect(result._hint).toContain('截断');
    // 截断后必须真的装进预算
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(AI_RESULT_MAX_BYTES);
  });

  it('非 ai actor（节点默认）→ 原样返回全量数组', async () => {
    ws.tools.register(bigArrayTool);
    const result = (await ws.tools.invoke('test.big.array', {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1000);
  });

  it('ai:* actor 的 ≤ 预算结果零侵入（同一引用直通）', async () => {
    ws.tools.register(smallTool);
    const result = await ws.tools.invoke('test.small', {}, 'ai:general');
    expect(result).toEqual({ ok: true, items: [1, 2, 3] });
  });

  it('ai:* actor 的大对象 → 数组属性被截断，_truncatedKeys 记名', async () => {
    ws.tools.register(bigObjectTool);
    const result = (await ws.tools.invoke('test.big.object', {}, 'ai:general')) as {
      summary: string;
      rows: unknown[];
      _truncated: boolean;
      _truncatedKeys: string[];
    };
    expect(result._truncated).toBe(true);
    expect(result._truncatedKeys).toContain('rows');
    expect(result.summary).toBe('ok');
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(1000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(AI_RESULT_MAX_BYTES);
  });
});

describe('AI 结果守门：fitResultForAi 纯函数', () => {
  it('巨字符串 → TOOL_RESULT_TOO_LARGE 兜底', () => {
    const out = fitResultForAi('z'.repeat(AI_RESULT_MAX_BYTES * 2)) as { error: string; _hint: string };
    expect(out.error).toBe('TOOL_RESULT_TOO_LARGE');
    expect(out._hint).toContain('截断');
  });

  it('不可序列化（BigInt）→ 拒绝且不抛错', () => {
    const out = fitResultForAi({ bad: 10n }) as { error: string };
    expect(out.error).toBe('TOOL_RESULT_NOT_SERIALIZABLE');
  });

  it('预算内数组 → 同一引用原样返回', () => {
    const small = [1, 2, 3];
    expect(fitResultForAi(small)).toBe(small);
  });
});
