import { describe, it, expect } from 'vitest';
import { runAgent, streamAgent, AgentStepLimitError } from '../src/index.js';
import { TOOL_CATALOG_DEFER_AT } from '../src/tool-catalog.js';
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

function frameText(messages: LlmTurnRequest['messages']): string {
  expect(messages).toHaveLength(1);
  const message = messages[0];
  if (!message || message.role !== 'user') throw new Error('expected task frame');
  return message.text;
}

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

    // 第二轮只带任务框：请求 + 最新结果。会话记录仍留着旁白和全文
    const second = requests[1].messages;
    expect(second).toHaveLength(1);
    const sent = frameText(second);
    expect(sent).toContain('A-1 还剩多少？');
    expect(sent).toContain('"skuCode":"A-1"');
    expect(sent).toContain('"quantity":5');
    expect(sent).not.toContain('好的，我查一下');
    expect(result.messages[1]).toEqual({
      role: 'tool-calls',
      text: '好的，我查一下',
      calls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }],
    });
    expect(result.messages[2]).toEqual({
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
    const sent = frameText(requests[1].messages);
    expect(sent).toContain('wms.inventory.query');
    expect(sent).toContain('wms.inventory.adjust');
    expect(sent).toContain('"quantity":10');
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
    // 会话逐轮累积；进模型的仍是一份任务框，不把前一步的原文再叠上去
    expect(result.messages).toHaveLength(5);
    expect(requests[2].messages).toHaveLength(1);
    const sent = frameText(requests[2].messages);
    expect(sent).toContain('这一轮已完成');
    expect(sent).toContain('wms.inventory.query');
    expect(sent).toContain('最新结果');
    expect(sent).toContain('wms.inventory.adjust');
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

    const sent = frameText(requests[1].messages);
    expect(sent).toContain('库存不足');
    expect(sent).toContain('wms.inventory.adjust 失败');
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

    expect(frameText(requests[1].messages)).toContain('原始字符串错误');
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
    const sent = frameText(requests[2].messages);
    expect(sent).toContain('"repeated":true');
    expect(sent).toContain('库存不足');
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

  it('中间有写成功后，同参数重试真正再执行（失败缓存随写清空）', async () => {
    // 复现线上场景：上架被质检拦截 → transition 推进到已质检（写成功）→
    // 同参数重试上架，不应重放旧错误，而应真正执行
    const transitionTool: AgentToolMeta = {
      id: 'wms.order.transition',
      label: '推进单据',
      description: '推进单据',
      parameters: { type: 'object', properties: {} },
      permission: 'write',
    };
    let adjustAttempts = 0;
    let inspected = false;
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 1 } }] },
      { text: '', toolCalls: [{ callId: 'c2', toolId: 'wms.order.transition', args: { to: 'inspected' } }] },
      { text: '', toolCalls: [{ callId: 'c3', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 1 } }] },
      { text: '好了', toolCalls: [] },
    ]);

    const result = await runAgent('上架', {
      provider,
      system: 'SYS',
      tools: [...demoTools, transitionTool],
      invoke: async (toolId) => {
        if (toolId === 'wms.order.transition') {
          inspected = true;
          return { to: 'inspected' };
        }
        adjustAttempts += 1;
        if (!inspected) throw new Error('WMS_QC_REQUIRED: 需先质检');
        return { quantity: 1 };
      },
    });

    expect(adjustAttempts).toBe(2); // 重试真正执行了，不是缓存重放
    expect(result.invocations[2]).toMatchObject({ toolId: 'wms.inventory.adjust', ok: true });
    // 第四次模型调用的任务框里是这次重试的成功结果，不是整段工具原文
    expect(requests[3].messages).toHaveLength(1);
    expect(frameText(requests[3].messages)).toContain('"quantity":1');
    expect(result.text).toBe('好了');
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

  it('默认上限 20 步', async () => {
    const loop: LlmTurnResponse = { text: '', toolCalls: [{ callId: 'c', toolId: 'wms.inventory.query', args: {} }] };
    const endless: LlmTurnResponse[] = Array.from({ length: 20 }, () => loop);
    const { provider, requests } = scriptedProvider(endless);

    await expect(
      runAgent('默认上限测试', { provider, system: 'SYS', tools: demoTools, invoke: noopInvoke }),
    ).rejects.toThrow(/上限 20/);

    expect(requests).toHaveLength(20);
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

  it('历史参数：窗口内留更早的原话和上一句回复，会话记录仍是全文', async () => {
    const history = [
      { role: 'user' as const, text: 'A-1 还剩多少？' },
      { role: 'assistant' as const, text: '5 个' },
    ];
    const seen: string[] = [];
    const provider: LlmProvider = {
      async completeTurn(req) {
        const message = req.messages[0];
        seen.push(message?.role === 'user' ? message.text : '');
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

    expect(seen).toEqual(['更早的对话：\n用户：A-1 还剩多少？\n\n上一句回复：\n5 个\n\n用户请求：\n是这批新到的吗？']);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('更大的窗口仍把更早的原话放进任务框，会话记录仍是全文', async () => {
    const history = [
      { role: 'user' as const, text: '第一问' },
      { role: 'assistant' as const, text: '第一答' },
      { role: 'user' as const, text: '第二问' },
      { role: 'assistant' as const, text: '第二答' },
    ];
    const seen: string[] = [];
    const provider: LlmProvider = {
      async completeTurn(req) {
        const message = req.messages[0];
        seen.push(message?.role === 'user' ? message.text : '');
        return { text: '接着办', toolCalls: [] };
      },
    };

    const { result } = await collect(
      streamAgent('第三问', {
        provider,
        system: 'SYS',
        tools: demoTools,
        invoke: noopInvoke,
        history,
        contextLength: '256k',
      }),
    );

    expect(seen[0]).toContain('更早的对话：\n用户：第一问\n助手：第一答\n\n用户：第二问');
    expect(seen[0]).toContain('上一句回复：\n第二答');
    expect(seen[0]).toContain('用户请求：\n第三问');
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
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

  it('一轮里各次模型调用的 token 加总后随 turn-done 送出', async () => {
    const { provider } = scriptedProvider([
      {
        text: '',
        toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      { text: '还有 5 个', toolCalls: [], usage: { inputTokens: 140, outputTokens: 8 } },
    ]);

    const { events } = await collect(
      streamAgent('查一下', { provider, system: 'SYS', tools: demoTools, invoke: async () => 5 }),
    );

    expect(events.at(-1)).toEqual({
      type: 'turn-done',
      steps: 2,
      usage: { inputTokens: 240, outputTokens: 18 },
    });
  });

  it('流式分片里的 usage 同样加进 turn-done', async () => {
    const { provider } = scriptedStreamProvider([
      [
        { type: 'text-delta', text: '查' },
        { type: 'usage', inputTokens: 50, outputTokens: 4 },
        { type: 'tool-calls', calls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      ],
      [
        { type: 'text-delta', text: '好' },
        { type: 'usage', inputTokens: 70, outputTokens: 6 },
      ],
    ]);

    const { events } = await collect(
      streamAgent('查一下', { provider, system: 'SYS', tools: demoTools, invoke: async () => 5 }),
    );

    expect(events.at(-1)).toEqual({
      type: 'turn-done',
      steps: 2,
      usage: { inputTokens: 120, outputTokens: 10 },
    });
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

  it('更早轮次的原话留在窗口里，工具结果不进模型，返回的历史仍是全文', async () => {
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
    const sent = frameText(requests[0].messages);
    expect(sent).toContain('上一句回复：\n第二答');
    expect(sent).toContain('用户：第一问');
    expect(sent).toContain('助手：第一答');
    expect(sent).toContain('第三问');
    expect(sent).not.toContain('OLD');
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

    // 回答回传模型：任务框带上问题和回答
    const sent = frameText(requests[1].messages);
    expect(sent).toContain('要入多少个？');
    expect(sent).toContain('20 个');
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

    expect(frameText(requests[1].messages)).toContain('用户没有回答');
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

  it('常驻只给摘要；tools.load 不进总线，完整说明随结果返回，tools 数组字节稳定', async () => {
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
    // 加载不改变工具清单（前缀缓存的前提），完整说明在结果里进历史
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(result.invocations[0]).toMatchObject({ toolId: 'tools.load', ok: true });
    expect(JSON.stringify(result.invocations[0].payload)).toContain('分配策略');
    expect(frameText(requests[1].messages)).toContain('分配策略');
    // 工具已经调用成功，回复这一步不再带整组说明，只留一行
    expect(frameText(requests[2].messages)).not.toContain('分配策略');
    expect(frameText(requests[2].messages)).toContain('group=order');
    expect(frameText(requests[2].messages)).toContain('IN-1');
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

  it('流式：下一条用户消息不再带上一轮的整组说明', async () => {
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
        { role: 'tool-results', results: [{ callId: 'c0', toolId: 'tools.load', ok: true, payload: { group: 'order', toolIds: ['wms.order.create'], docs: '### wms.order.create——创建出入库单\n…分配策略的完整规则…' } }] },
        { role: 'assistant', text: '要开哪种？' },
      ],
      invoke: async () => ({}),
    });
    await gen.next();
    // 工具数没过延迟线，摘要仍在清单里；上一轮的整组说明不进这一轮
    expect(requests[0].tools.find((t) => t.id === 'wms.order.create')?.description).toBe('创建一张入库单或出库单');
    expect(frameText(requests[0].messages)).not.toContain('分配策略');
    expect(frameText(requests[0].messages)).toContain('要开哪种？');
    expect(frameText(requests[0].messages)).not.toContain('group=order');
    expect(requests[0].tools.map((t) => t.id)).toContain('ui.ask');
  });

  it('连续加载多组不改变工具清单：整轮字节稳定（前缀缓存前提）', async () => {
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
    const result = await runAgent('加载说明', {
      provider,
      system: 'SYS',
      tools,
      catalog: true,
      invoke: async () => ({}),
    });

    // 每一轮的工具清单完全一致；加载结果只带本组说明
    for (const req of requests) expect(req.tools).toEqual(requests[0].tools);
    expect(requests[4].tools.find((tool) => tool.id === 'wms.order.create')?.description).toBe('开单');
    expect(requests[4].tools.find((tool) => tool.id === 'tools.load')?.description).toContain('order（1）');
    expect(requests[4].tools.find((tool) => tool.id === 'tools.load')?.description).not.toContain('开单');
    expect(JSON.stringify(result.invocations[3].payload)).toContain('wms.location.create');
    expect(JSON.stringify(result.invocations[3].payload)).not.toContain('wms.order.create');
  });

  it('延迟目录：本轮加载的组下一跳进清单，下一条用户消息重新加载', async () => {
    const spec = (id: string): AgentToolMeta => ({
      id,
      label: id,
      description: `${id} 的完整说明。后半不进摘要。`,
      parameters: { type: 'object', properties: {} },
      permission: 'read',
    });
    const tools = Array.from({ length: TOOL_CATALOG_DEFER_AT + 1 }, (_, i) => spec(`wms.extra.t${i}`));
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'tools.load', args: { group: 'extra' } }] },
      { text: '好', toolCalls: [] },
    ]);
    await runAgent('用一下', {
      provider,
      system: 'SYS',
      tools,
      catalog: true,
      invoke: async () => ({}),
    });
    expect(requests[0].tools.some((tool) => tool.id === 'wms.extra.t0')).toBe(false);
    expect(requests[1].tools.some((tool) => tool.id === 'wms.extra.t0')).toBe(true);

    const next = scriptedProvider([{ text: '好', toolCalls: [] }]);
    const gen = streamAgent('下一句', {
      provider: next.provider,
      system: 'SYS',
      tools,
      catalog: true,
      history: [
        { role: 'user', text: '用一下' },
        { role: 'tool-calls', calls: [{ callId: 'c1', toolId: 'tools.load', args: { group: 'extra' } }] },
        {
          role: 'tool-results',
          results: [
            {
              callId: 'c1',
              toolId: 'tools.load',
              ok: true,
              payload: { group: 'extra', toolIds: ['wms.extra.t0'], docs: '整组说明很长' },
            },
          ],
        },
        { role: 'assistant', text: '好' },
      ],
      invoke: async () => ({}),
    });
    await gen.next();
    expect(next.requests[0].tools.some((tool) => tool.id === 'wms.extra.t0')).toBe(false);
    expect(frameText(next.requests[0].messages)).not.toContain('整组说明很长');
    expect(frameText(next.requests[0].messages)).not.toContain('group=extra');
    expect(frameText(next.requests[0].messages)).toContain('上一句回复');
  });
});
