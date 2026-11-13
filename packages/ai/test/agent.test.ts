import { describe, it, expect } from 'vitest';
import { runAgent, streamAgent, AgentStepLimitError } from '../src/index.js';
import type {
  AgentStreamEvent,
  AgentTurnResult,
  AgentToolMeta,
  LlmProvider,
  LlmStreamChunk,
  LlmTurnRequest,
  LlmTurnResponse,
} from '../src/index.js';

/**
 * 编排循环纯逻辑测试：脚本化 mock provider 驱动，不打真实 API。
 * 验证：多轮循环、结果回传格式、错误不中断、maxSteps 保护、旁白保留。
 */

const demoTools: AgentToolMeta[] = [
  {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description: '调整库存',
    parameters: { type: 'object', properties: { skuCode: { type: 'string' }, delta: { type: 'integer' } }, required: ['skuCode', 'delta'] },
    permission: 'write',
  },
  {
    id: 'wms.inventory.query',
    label: '查询库存',
    description: '查询库存',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'read',
  },
];

/** 脚本化 provider：按序返回预设响应，并捕获收到的每轮请求 */
function scriptedProvider(turns: LlmTurnResponse[]) {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async completeTurn(req) {
      requests.push(req);
      return turns[i++] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests };
}

const noopInvoke = async () => ({ ok: true });

describe('runAgent：循环与终态', () => {
  it('无工具调用：单轮即终态，透传 system/tools/user', async () => {
    const { provider, requests } = scriptedProvider([{ text: '你好，需要什么帮助？', toolCalls: [] }]);

    const result = await runAgent('你好', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: noopInvoke,
    });

    expect(result.text).toBe('你好，需要什么帮助？');
    expect(result.steps).toBe(1);
    expect(result.messages).toEqual([{ role: 'user', text: '你好' }]);
    expect(result.invocations).toEqual([]);

    expect(requests).toHaveLength(1);
    expect(requests[0].system).toBe('SYS');
    expect(requests[0].tools.map((t) => t.id)).toEqual(['wms.inventory.adjust', 'wms.inventory.query']);
    expect(requests[0].messages).toEqual([{ role: 'user', text: '你好' }]);
  });

  it('单轮工具调用：结果回传后模型给最终回复', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '好的，我查一下', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      { text: 'A-1 还有 5 个', toolCalls: [] },
    ]);
    const invoked: Array<[string, Record<string, unknown>]> = [];

    const result = await runAgent('A-1 还剩多少？', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async (toolId, args) => {
        invoked.push([toolId, args]);
        return { skuCode: 'A-1', quantity: 5 };
      },
    });

    expect(result.text).toBe('A-1 还有 5 个');
    expect(result.steps).toBe(2);
    expect(invoked).toEqual([['wms.inventory.query', {}]]);
    expect(result.invocations).toEqual([
      { toolId: 'wms.inventory.query', args: {}, ok: true, payload: { skuCode: 'A-1', quantity: 5 } },
    ]);

    // 第二轮请求必须携带完整历史：user → tool-calls（含旁白）→ tool-results
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: 'tool-calls',
      text: '好的，我查一下',
      calls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }],
    });
    expect(second[2]).toEqual({
      role: 'tool-results',
      results: [{ callId: 'c1', toolId: 'wms.inventory.query', ok: true, payload: { skuCode: 'A-1', quantity: 5 } }],
    });
  });

  it('同一轮多个工具调用：逐个执行、结果对齐 callId', async () => {
    const { provider, requests } = scriptedProvider([
      {
        text: '',
        toolCalls: [
          { callId: 'c1', toolId: 'wms.inventory.query', args: {} },
          { callId: 'c2', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 10 } },
        ],
      },
      { text: '完成', toolCalls: [] },
    ]);

    const result = await runAgent('盘点并入库', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async (toolId) => (toolId === 'wms.inventory.query' ? { list: [] } : { quantity: 10 }),
    });

    expect(result.invocations.map((i) => i.toolId)).toEqual(['wms.inventory.query', 'wms.inventory.adjust']);
    const results = (requests[1].messages[2] as { results: Array<{ callId: string }> }).results;
    expect(results.map((r) => r.callId)).toEqual(['c1', 'c2']);
  });

  it('连续多轮工具调用：历史逐轮累积', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 3 } }] },
      { text: '入库 3 个完成', toolCalls: [] },
    ]);

    const result = await runAgent('查一下再入库 3 个', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async () => ({}),
    });

    expect(result.steps).toBe(3);
    expect(requests[2].messages).toHaveLength(5);
    expect(result.invocations).toHaveLength(2);
  });
});

describe('runAgent：错误回传（§4.2 规则即护栏）', () => {
  it('工具抛错不中断循环：错误信息作为结果回传模型', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -999 } }] },
      { text: '库存不足，无法出库 999 个', toolCalls: [] },
    ]);

    const result = await runAgent('出库 999 个 A-1', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async () => {
        throw new InsufficientLikeError('InsufficientStockError: SKU A-1 库存不足：出库 -999，当前 5');
      },
    });

    // 循环没被炸断，模型拿到了错误并向用户解释
    expect(result.text).toBe('库存不足，无法出库 999 个');
    expect(result.invocations[0].ok).toBe(false);

    const results = requests[1].messages[2] as {
      results: Array<{ ok: boolean; payload: { error: string } }>;
    };
    expect(results.results[0].ok).toBe(false);
    expect(results.results[0].payload.error).toContain('库存不足');
  });

  it('非 Error 异常也被兜住（String 化）', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      { text: '工具出错了', toolCalls: [] },
    ]);

    await runAgent('查库存', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async () => {
        throw '原始字符串错误'; // eslint-disable-line no-throw-literal
      },
    });

    const results = requests[1].messages[2] as { results: Array<{ payload: { error: string } }> };
    expect(results.results[0].payload.error).toBe('原始字符串错误');
  });

  it('同一工具同一参数失败过就不再执行，键序不同也算同一参数', async () => {
    let calls = 0;
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -1 } }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.inventory.adjust', args: { delta: -1, skuCode: 'A-1' } }] },
      { text: '库存不足', toolCalls: [] },
    ]);

    const result = await runAgent('出库', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async () => {
        calls += 1;
        throw new Error('库存不足');
      },
    });

    expect(calls).toBe(1);
    expect(result.text).toBe('库存不足');
    expect(result.invocations).toHaveLength(2);
    expect(result.invocations[1].ok).toBe(false);
    const second = requests[2].messages[4];
    expect(second.role).toBe('tool-results');
    if (second.role !== 'tool-results') return;
    expect(second.results[0].payload).toMatchObject({ repeated: true });
    expect(JSON.stringify(second.results[0].payload)).toContain('库存不足');
  });

  it('参数不同，或上次已经成功，都会再执行', async () => {
    let calls = 0;
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -1 } }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -2 } }] },
      { text: '', toolCalls: [{ callId: 'c3', toolId: 'wms.inventory.query', args: {} }] },
      { text: '', toolCalls: [{ callId: 'c4', toolId: 'wms.inventory.query', args: {} }] },
      { text: '好', toolCalls: [] },
    ]);

    await runAgent('再试', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async (toolId) => {
        calls += 1;
        if (toolId === 'wms.inventory.adjust') throw new Error('库存不足');
        return { quantity: 5 };
      },
    });

    expect(calls).toBe(4);
  });
});

describe('runAgent：同一步的读并行、写按顺序', () => {
  const locationTool: AgentToolMeta = {
    id: 'wms.location.list',
    label: '库位',
    description: '列出库位',
    parameters: { type: 'object', properties: {} },
    permission: 'read',
  };

  it('相邻的读一起开始，写等它们都结束', async () => {
    const trace: string[] = [];
    const { provider } = scriptedProvider([
      {
        text: '',
        toolCalls: [
          { callId: 'r1', toolId: 'wms.inventory.query', args: { skuCode: 'A' } },
          { callId: 'r2', toolId: 'wms.location.list', args: {} },
          { callId: 'w1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A', delta: 1 } },
        ],
      },
      { text: '好', toolCalls: [] },
    ]);

    const result = await runAgent('查完再改', {
      provider,
      system: 'SYS',
      tools: [...demoTools, locationTool],
      invoke: async (toolId) => {
        trace.push(`start:${toolId}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        trace.push(`end:${toolId}`);
        return {};
      },
    });

    const startQuery = trace.indexOf('start:wms.inventory.query');
    const startList = trace.indexOf('start:wms.location.list');
    const endQuery = trace.indexOf('end:wms.inventory.query');
    const endList = trace.indexOf('end:wms.location.list');
    const startAdjust = trace.indexOf('start:wms.inventory.adjust');
    expect(startList).toBeGreaterThanOrEqual(0);
    expect(startList).toBeLessThan(endQuery);
    expect(startQuery).toBeLessThan(endList);
    expect(startAdjust).toBeGreaterThan(endQuery);
    expect(startAdjust).toBeGreaterThan(endList);
    expect(result.invocations.map((item) => item.toolId)).toEqual([
      'wms.inventory.query',
      'wms.location.list',
      'wms.inventory.adjust',
    ]);
  });

  it('同一步的两笔写按顺序做完', async () => {
    let active = 0;
    let max = 0;
    const { provider } = scriptedProvider([
      {
        text: '',
        toolCalls: [
          { callId: 'w1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A', delta: 1 } },
          { callId: 'w2', toolId: 'wms.inventory.adjust', args: { skuCode: 'B', delta: 1 } },
        ],
      },
      { text: '好', toolCalls: [] },
    ]);

    await runAgent('两笔调整', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return {};
      },
    });

    expect(max).toBe(1);
  });
});

describe('runAgent：maxSteps 保护', () => {
  it('模型无限调用工具时按上限中止', async () => {
    const loop: LlmTurnResponse = { text: '', toolCalls: [{ callId: 'c', toolId: 'wms.inventory.query', args: {} }] };
    const { provider, requests } = scriptedProvider([loop, loop, loop, loop, loop]);

    await expect(
      runAgent('死循环测试', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke, maxSteps: 2 }),
    ).rejects.toBeInstanceOf(AgentStepLimitError);

    expect(requests).toHaveLength(2);
  });

  it('默认上限 8 步', async () => {
    const loop: LlmTurnResponse = { text: '', toolCalls: [{ callId: 'c', toolId: 'wms.inventory.query', args: {} }] };
    const endless: LlmTurnResponse[] = Array.from({ length: 20 }, () => loop);
    const { provider, requests } = scriptedProvider(endless);

    await expect(
      runAgent('默认上限测试', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke }),
    ).rejects.toThrow(/上限 8/);

    expect(requests).toHaveLength(8);
  });
});

class InsufficientLikeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientStockError';
  }
}

// ── streamAgent：流式编排（M12）─────────────────────────

/** 驱动生成器：收集全部事件并捕获 return 值 */
async function collect(gen: AsyncGenerator<AgentStreamEvent, AgentTurnResult>) {
  const events: AgentStreamEvent[] = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, result: value };
    events.push(value);
  }
}

/** 脚本化流式 provider：每轮吐一组分片 */
function scriptedStreamProvider(turns: LlmStreamChunk[][]) {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async completeTurn() {
      throw new Error('不应回退到 completeTurn');
    },
    async *streamTurn(req) {
      requests.push(req);
      yield* turns[i++] ?? [];
    },
  };
  return { provider, requests };
}

describe('streamAgent：事件序与终态', () => {
  it('非流式 provider 回退：整轮文本单个 text-delta，事件序完整', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '我查一下', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      { text: 'A-1 还有 5 个', toolCalls: [] },
    ]);

    const { events, result } = await collect(
      streamAgent('A-1 还剩多少？', { provider, system: 'SYS', tools: demoTools, invoke: async () => 5 }),
    );

    expect(events).toEqual([
      { type: 'text-delta', text: '我查一下' },
      { type: 'tool-call', callId: 'c1', toolId: 'wms.inventory.query', args: {} },
      { type: 'tool-result', callId: 'c1', toolId: 'wms.inventory.query', ok: true, payload: 5 },
      { type: 'text-delta', text: 'A-1 还有 5 个' },
      { type: 'turn-done', steps: 2 },
    ]);
    expect(result.text).toBe('A-1 还有 5 个');
    expect(result.steps).toBe(2);
    // 终态把最终回复追加为 assistant 消息（多轮会话历史的一部分）
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'tool-calls', 'tool-results', 'assistant']);
    expect(requests).toHaveLength(2);
  });

  it('流式 provider：text-delta 逐片透传，tool-calls 收敛为终片后执行', async () => {
    const { provider } = scriptedStreamProvider([
      [
        { type: 'text-delta', text: '好的' },
        { type: 'text-delta', text: '，我查一下' },
        { type: 'tool-calls', calls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      ],
      [{ type: 'text-delta', text: '共 5 个' }],
    ]);

    const { events, result } = await collect(
      streamAgent('查库存', { provider, system: 'SYS', tools: demoTools, invoke: async () => 5 }),
    );

    expect(events).toEqual([
      { type: 'text-delta', text: '好的' },
      { type: 'text-delta', text: '，我查一下' },
      { type: 'tool-call', callId: 'c1', toolId: 'wms.inventory.query', args: {} },
      { type: 'tool-result', callId: 'c1', toolId: 'wms.inventory.query', ok: true, payload: 5 },
      { type: 'text-delta', text: '共 5 个' },
      { type: 'turn-done', steps: 2 },
    ]);
    expect(result.text).toBe('共 5 个');
    // tool-calls 终片未流过旁白（本例已流过）——messages 里 tool-calls 携带完整旁白
    expect((result.messages[1] as { text?: string }).text).toBe('好的，我查一下');
  });

  it('历史参数：messages 以 history 为前缀（多轮会话上下文）', async () => {
    const history = [
      { role: 'user' as const, text: 'A-1 还剩多少？' },
      { role: 'assistant' as const, text: '5 个' },
    ];
    // 快照调用时的消息角色序列（messages 数组会被编排层继续追加，不能存引用）
    const seenRoles: string[][] = [];
    const provider: LlmProvider = {
      async completeTurn(req) {
        seenRoles.push(req.messages.map((m) => m.role));
        return { text: '还是同一批', toolCalls: [] };
      },
    };

    const { result } = await collect(
      streamAgent('是这批新到的吗？', {
        provider,
        system: 'SYS',
        tools: demoTools,
        invoke: noopInvoke,
        history,
      }),
    );

    expect(seenRoles).toEqual([['user', 'assistant', 'user']]);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('工具抛错 → ok=false 的 tool-result 事件（循环不中断）', async () => {
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { delta: -9 } }] },
      { text: '库存不足', toolCalls: [] },
    ]);

    const { events } = await collect(
      streamAgent('出库', {
        provider,
        system: 'SYS',
        tools: demoTools,
        invoke: async () => {
          throw new InsufficientLikeError('InsufficientStockError: SKU A-1 库存不足');
        },
      }),
    );

    expect(events[1]).toMatchObject({ type: 'tool-result', toolId: 'wms.inventory.adjust', ok: false });
    expect((events[1] as { payload: { error: string } }).payload.error).toContain('库存不足');
    expect(events.at(-1)).toEqual({ type: 'turn-done', steps: 2 });
  });

  it('模型调用抛错 → 生成器 rejects（server 层转 error 事件）', async () => {
    const provider: LlmProvider = {
      async completeTurn() {
        throw new Error('LLM_DOWN');
      },
    };
    const gen = streamAgent('你好', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke });
    await expect(collect(gen)).rejects.toThrow('LLM_DOWN');
  });

  it('maxSteps 保护与 runAgent 同语义', async () => {
    const loop: LlmTurnResponse = { text: '', toolCalls: [{ callId: 'c', toolId: 'wms.inventory.query', args: {} }] };
    const { provider } = scriptedProvider([loop, loop, loop]);
    const gen = streamAgent('死循环测试', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: noopInvoke,
      maxSteps: 2,
    });
    await expect(collect(gen)).rejects.toBeInstanceOf(AgentStepLimitError);
  });

  it('更早轮次的工具结果进模型时收成一句，返回的历史仍是全文', async () => {
    const full = { skuCode: 'OLD', quantity: 9, rows: [{ skuCode: 'OLD' }], total: 1 };
    const { provider, requests } = scriptedProvider([{ text: '第三答', toolCalls: [] }]);
    const { result } = await collect(
      streamAgent('第三问', {
        provider,
        system: 'SYS',
        tools: demoTools,
        invoke: noopInvoke,
        history: [
          { role: 'user', text: '第一问' },
          { role: 'tool-calls', calls: [{ callId: 'c0', toolId: 'wms.inventory.query', args: {} }] },
          {
            role: 'tool-results',
            results: [{ callId: 'c0', toolId: 'wms.inventory.query', ok: true, payload: full }],
          },
          { role: 'assistant', text: '第一答' },
          { role: 'user', text: '第二问' },
          { role: 'assistant', text: '第二答' },
        ],
      }),
    );
    const sent = requests[0].messages[2];
    expect(sent.role).toBe('tool-results');
    if (sent.role !== 'tool-results') return;
    expect(sent.results[0].payload).toEqual({
      summary: 'wms.inventory.query 成功。共 1 条，本页 1 条',
    });
    expect(JSON.stringify(sent)).not.toContain('OLD');
    const stored = result.messages[2];
    expect(stored.role).toBe('tool-results');
    if (stored.role !== 'tool-results') return;
    expect(stored.results[0].payload).toEqual(full);
  });
});

// ── streamAgent：ui.ask 挂起/唤醒（M12 步骤3）─────────────

describe('streamAgent：ui.ask 挂起/唤醒', () => {
  it('ask 事件 → next({answer}) 注入回答 → tool-result 回传模型', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '要入多少个？' } }] },
      { text: '好的，入库 20 个完成。', toolCalls: [] },
    ]);
    const gen = streamAgent('入库 A-1', {
      provider,
      system: 'SYS',
      tools: demoTools,
      // ui.ask 不应穿工具总线（穿总线会落 oplog——审计豁免被破坏）
      invoke: async () => {
        throw new Error('ui.ask 不应进 invoke');
      },
    });

    const e1 = await gen.next();
    expect(e1.done).toBe(false);
    expect(e1.value).toEqual({ type: 'ask', callId: 'c1', question: '要入多少个？' });

    const e2 = await gen.next({ answer: '20 个' }); // 注入用户回答
    expect(e2.value).toEqual({
      type: 'tool-result',
      callId: 'c1',
      toolId: 'ui.ask',
      ok: true,
      payload: { answer: '20 个' },
    });

    const e3 = await gen.next();
    expect(e3.value).toEqual({ type: 'text-delta', text: '好的，入库 20 个完成。' });
    const e4 = await gen.next();
    expect(e4.value).toEqual({ type: 'turn-done', steps: 2 });
    const e5 = await gen.next();
    expect(e5.done).toBe(true);

    // 回答回传模型：第二轮请求的 tool-results 携带 answer
    const results = (requests[1].messages[2] as { results: Array<{ payload: unknown }> }).results;
    expect(results[0].payload).toEqual({ answer: '20 个' });
  });

  it('declined 注入（跳过/超时）→ payload { declined: true } 回传模型', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '批次？' } }] },
      { text: '好的，放默认批次。', toolCalls: [] },
    ]);
    const gen = streamAgent('入库 A-1', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke });

    expect((await gen.next()).value).toMatchObject({ type: 'ask' });
    const e2 = await gen.next({ declined: true });
    expect(e2.value).toMatchObject({ type: 'tool-result', ok: true, payload: { declined: true } });
    await gen.next(); // text-delta
    await gen.next(); // turn-done

    const results = (requests[1].messages[2] as { results: Array<{ payload: unknown }> }).results;
    expect(results[0].payload).toEqual({ declined: true });
  });

  it('普通 next() 恢复（未注入回答）→ 兜底按 declined 处理', async () => {
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '数量？' } }] },
      { text: '好。', toolCalls: [] },
    ]);
    const gen = streamAgent('入库', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke });
    await gen.next(); // ask
    const e2 = await gen.next(); // 不带参数恢复（驱动方误用）
    expect(e2.value).toMatchObject({ type: 'tool-result', payload: { declined: true } });
  });

  it('同一轮 ui.ask 与普通工具混排：逐个顺序执行，事件序完整', async () => {
    const { provider } = scriptedProvider([
      {
        text: '',
        toolCalls: [
          { callId: 'c1', toolId: 'ui.ask', args: { question: '入多少个？' } },
          { callId: 'c2', toolId: 'wms.inventory.query', args: {} },
        ],
      },
      { text: '完成', toolCalls: [] },
    ]);
    const invoked: string[] = [];
    const gen = streamAgent('入库 A-1', {
      provider,
      system: 'SYS',
      tools: demoTools,
      invoke: async (toolId) => {
        invoked.push(toolId);
        return { quantity: 5 };
      },
    });

    const e1 = await gen.next();
    expect(e1.value).toMatchObject({ type: 'ask', callId: 'c1' });
    const e2 = await gen.next({ answer: '5 个' });
    expect(e2.value).toMatchObject({ type: 'tool-result', callId: 'c1', payload: { answer: '5 个' } });
    const e3 = await gen.next();
    expect(e3.value).toMatchObject({ type: 'tool-call', callId: 'c2' });
    const e4 = await gen.next();
    expect(e4.value).toMatchObject({ type: 'tool-result', callId: 'c2', ok: true });
    // 只有普通工具穿了总线
    expect(invoked).toEqual(['wms.inventory.query']);
  });
});

describe('工具目录：瘦 schema 与 tools.load', () => {
  const orderTool: AgentToolMeta = {
    id: 'wms.order.create',
    label: '创建出入库单',
    description: '创建一张入库单或出库单。预报、退货和分配策略的完整规则在这里。',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向' },
        lines: { type: 'array', description: '每行 { skuCode, quantity }', items: { type: 'object' } },
      },
      required: ['direction', 'lines'],
    },
    permission: 'write',
  };

  it('常驻只给摘要；tools.load 不进总线，下一轮附上完整说明', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'tools.load', args: { group: 'order' } }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.order.create', args: { direction: 'in', lines: [] } }] },
      { text: '开好了', toolCalls: [] },
    ]);
    const invoked: string[] = [];
    const result = await runAgent('开一张入库单', {
      provider,
      system: 'SYS',
      tools: [orderTool],
      catalog: true,
      invoke: async (toolId) => {
        invoked.push(toolId);
        return { orderNo: 'IN-1' };
      },
    });

    expect(invoked).toEqual(['wms.order.create']);
    expect(requests[0].tools.find((t) => t.id === 'wms.order.create')?.description).toBe('创建一张入库单或出库单');
    expect(requests[0].tools.find((t) => t.id === 'wms.order.create')?.parameters.properties?.direction?.description).toBeUndefined();
    expect(requests[1].tools.find((t) => t.id === 'wms.order.create')?.description).toContain('分配策略');
    expect(result.invocations[0]).toMatchObject({ toolId: 'tools.load', ok: true });
    expect(result.text).toBe('开好了');
  });

  it('未知组和不在授权里的工具都不进总线', async () => {
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'tools.load', args: { group: 'nope' } }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.inventory.adjust', args: {} }] },
      { text: '不行', toolCalls: [] },
    ]);
    const invoked: string[] = [];
    const result = await runAgent('试试', {
      provider,
      system: 'SYS',
      tools: [orderTool],
      catalog: true,
      invoke: async (toolId) => {
        invoked.push(toolId);
        return {};
      },
    });
    expect(invoked).toEqual([]);
    expect(result.invocations[0].ok).toBe(false);
    expect(result.invocations[1].ok).toBe(false);
    expect(JSON.stringify(result.invocations[1].payload)).toContain('不在该助手的授权范围内');
  });

  it('流式：历史里加载过的组，下一句直接带完整说明', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好', toolCalls: [] }]);
    const gen = streamAgent('继续开单', {
      provider,
      system: 'SYS',
      tools: [orderTool, { ...demoTools[0], id: 'ui.ask', label: '问', description: '问', parameters: { type: 'object', properties: {} }, permission: 'read' }],
      catalog: true,
      sessionToolIds: ['ui.ask'],
      history: [
        { role: 'user', text: '开单' },
        { role: 'tool-calls', calls: [{ callId: 'c0', toolId: 'tools.load', args: { group: 'order' } }] },
        { role: 'tool-results', results: [{ callId: 'c0', toolId: 'tools.load', ok: true, payload: { group: 'order', toolIds: ['wms.order.create'] } }] },
        { role: 'assistant', text: '要开哪种？' },
      ],
      invoke: async () => ({}),
    });
    await gen.next();
    expect(requests[0].tools.find((t) => t.id === 'wms.order.create')?.description).toContain('分配策略');
    expect(requests[0].tools.map((t) => t.id)).toContain('ui.ask');
  });

  it('连续加载超过三组时，最久没用的组回到摘要', async () => {
    const spec = (id: string, name: string): AgentToolMeta => ({
      id,
      label: name,
      description: `${name}。完整规则 ${id}。`,
      parameters: { type: 'object', properties: {} },
      permission: 'write',
    });
    const tools = [
      spec('wms.order.create', '开单'),
      spec('wms.sku.create', '建档'),
      spec('wms.partner.create', '建往来'),
      spec('wms.location.create', '建库位'),
    ];
    const load = (callId: string, group: string): LlmTurnResponse => ({
      text: '',
      toolCalls: [{ callId, toolId: 'tools.load', args: { group } }],
    });
    const { provider, requests } = scriptedProvider([
      load('c1', 'order'),
      load('c2', 'sku'),
      load('c3', 'partner'),
      load('c4', 'location'),
      { text: '好', toolCalls: [] },
    ]);
    await runAgent('加载说明', {
      provider,
      system: 'SYS',
      tools,
      catalog: true,
      invoke: async () => ({}),
    });

    const full = (id: string) => requests[4].tools.find((tool) => tool.id === id)?.description ?? '';
    expect(full('wms.order.create')).toBe('开单');
    expect(full('wms.sku.create')).toContain('完整规则');
    expect(full('wms.partner.create')).toContain('完整规则');
    expect(full('wms.location.create')).toContain('完整规则');
    expect(requests[4].tools.find((tool) => tool.id === 'tools.load')?.description).toContain('order（1）');
    expect(requests[4].tools.find((tool) => tool.id === 'tools.load')?.description).not.toContain('开单');
  });
});
