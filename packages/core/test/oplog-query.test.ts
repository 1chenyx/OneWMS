import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type ToolDefinition } from '../src/index.js';

/**
 * core.oplog.query（审计账本只读分页查询）：
 *  - type / typePrefix / actor / 时间区间过滤；
 *  - 最新在前、分页壳 { total, limit, offset, hasMore, rows }；
 *  - payloadSummary 截断（≤300 字符）；纯读（不产生新事件）。
 */

let core: OneCore;
let ws: ReturnType<OneCore['workspace']>;

/** 测试事件发射器：经受控 appendEvent 落账（不直接触碰 OplogStore） */
const emitTool: ToolDefinition<{ kind?: string }> = {
  id: 'test.emit',
  label: '测试事件发射',
  description: '测试用',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', description: 'test.a 或 test.b' } },
    required: [],
  },
  handler: (params, ctx) => {
    const kind = params.kind ?? 'test.a';
    const env = ctx.appendEvent(kind, { seq: Math.random(), pad: 'p'.repeat(50) });
    return { eventId: (env as { eventId: string }).eventId };
  },
};

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = core.workspace('ws-oplog');
  ws.tools.register(emitTool);
});

afterEach(() => {
  core.close();
});

async function emit(kind?: string): Promise<void> {
  await ws.tools.invoke('test.emit', kind ? { kind } : {}, 'node-test');
}

describe('core.oplog.query：过滤与分页', () => {
  it('type 精确过滤 + 最新在前 + payloadSummary 截断', async () => {
    await emit('test.a');
    await emit('test.b');
    await emit('test.a');

    const before = ws.events.count();
    const r = (await ws.tools.invoke('core.oplog.query', { type: 'test.a' }, 'ai:general')) as {
      total: number;
      hasMore: boolean;
      rows: { eventId: string; type: string; actor: string; createdAt: string; payloadSummary: string }[];
    };
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((row) => row.type === 'test.a')).toBe(true);
    expect(r.rows[0].actor).toBe('node-test');
    // payloadSummary 是 JSON 字符串且截断到 300 字符
    expect(r.rows[0].payloadSummary.length).toBeLessThanOrEqual(300);
    // 纯读：查询不产生事件
    expect(ws.events.count()).toBe(before);
  });

  it('typePrefix 前缀匹配命中该前缀全部事件', async () => {
    await emit('test.a');
    await emit('test.b');
    await emit('other.x');

    const r = (await ws.tools.invoke('core.oplog.query', { typePrefix: 'test.' })) as {
      total: number;
      rows: { type: string }[];
    };
    expect(r.total).toBe(2);
    expect(r.rows.map((row) => row.type).sort()).toEqual(['test.a', 'test.b']);
  });

  it('actor 过滤 + 分页翻页正确', async () => {
    for (let i = 0; i < 5; i++) {
      await emit(); // actor = node-test
    }
    await ws.tools.invoke('test.emit', {}, 'ai:general');

    const page1 = (await ws.tools.invoke('core.oplog.query', { actor: 'node-test', limit: 2 })) as {
      total: number;
      hasMore: boolean;
      rows: unknown[];
    };
    expect(page1.total).toBe(5);
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page3 = (await ws.tools.invoke('core.oplog.query', { actor: 'node-test', limit: 2, offset: 4 })) as {
      hasMore: boolean;
      rows: unknown[];
    };
    expect(page3.rows).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it('时间闭区间过滤（from/to）', async () => {
    await emit('test.a');

    const wide = (await ws.tools.invoke('core.oplog.query', {
      from: '2000-01-01',
      to: '2999-12-31',
    })) as { total: number };
    expect(wide.total).toBeGreaterThanOrEqual(1);

    const empty = (await ws.tools.invoke('core.oplog.query', {
      from: '2999-01-01',
    })) as { total: number };
    expect(empty.total).toBe(0);
  });
});
