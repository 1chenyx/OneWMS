import { describe, it, expect } from 'vitest';
import { runAgent, AgentStepLimitError } from '../src/index.js';
import type { AgentToolMeta, LlmProvider, LlmTurnRequest, LlmTurnResponse } from '../src/index.js';

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
