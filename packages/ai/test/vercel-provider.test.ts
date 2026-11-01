import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { createVercelLlmProvider } from '../src/index.js';
import type { AgentMessage, AgentToolMeta, LlmStreamChunk, LlmTurnRequest } from '../src/index.js';

/**
 * Vercel 适配层测试：MockLanguageModelV4 模拟模型响应（不打真实 API）。
 * 锁定三件事：响应解析（toolCalls/text）、请求翻译（消息/工具/schema 透传）、
 * 以及「无 execute 的工具被调用时 SDK 正常返回 toolCalls」这一行为契约。
 */

const demoTools: AgentToolMeta[] = [
  {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description: '对某 SKU 做库存增减',
    parameters: {
      type: 'object',
      properties: { skuCode: { type: 'string' }, delta: { type: 'integer' } },
      required: ['skuCode', 'delta'],
    },
    permission: 'write',
  },
];

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  };
}

function toolCallResult(callId: string, toolName: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  };
}

function baseRequest(messages: AgentMessage[]): LlmTurnRequest {
  return { system: 'SYS-PROMPT', messages, tools: demoTools };
}

/** doStream 结果：分片序列包装成 ReadableStream */
function streamResult(parts: LanguageModelV4StreamPart[]): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  };
}

const FINISH_STOP = { type: 'finish', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, finishReason: { unified: 'stop', raw: 'stop' } } as LanguageModelV4StreamPart;
const FINISH_TOOLS = { type: 'finish', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } } as LanguageModelV4StreamPart;

/** 收集 streamTurn 的全部分片 */
async function collectChunks(provider: ReturnType<typeof createVercelLlmProvider>, req: LlmTurnRequest): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const chunk of provider.streamTurn!(req)) out.push(chunk);
  return out;
}

describe('createVercelLlmProvider：响应解析', () => {
  it('纯文本回复 → text，无 toolCalls', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => textResult('你好') });
    const provider = createVercelLlmProvider(mock as never);

    const res = await provider.completeTurn(baseRequest([{ role: 'user', text: 'hi' }]));

    expect(res.text).toBe('你好');
    expect(res.toolCalls).toEqual([]);
  });

  it('工具调用 → toolCalls（input JSON 串已解为 args 对象）', async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult('call_1', 'wms.inventory.adjust', { skuCode: 'A-1', delta: 10 }),
    });
    const provider = createVercelLlmProvider(mock as never);

    const res = await provider.completeTurn(baseRequest([{ role: 'user', text: '入库 10 个 A-1' }]));

    expect(res.toolCalls).toEqual([
      { callId: 'call_1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 10 } },
    ]);
    // 行为契约：无 execute 的工具被调用时 SDK 不抛错、正常返回（循环主权在编排层）
    expect(mock.doGenerateCalls).toHaveLength(1);
  });
});

describe('createVercelLlmProvider：请求翻译', () => {
  it('system 与 user 消息进入 prompt；工具定义（含 schema）透传', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => textResult('ok') });
    const provider = createVercelLlmProvider(mock as never);

    await provider.completeTurn(baseRequest([{ role: 'user', text: '入库 10 个 A-1' }]));

    const call = mock.doGenerateCalls[0];
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain('SYS-PROMPT');
    expect(prompt).toContain('入库 10 个 A-1');
    // 工具定义与 JSON Schema 关键字段到达 provider 层
    const tools = JSON.stringify(call.tools ?? []);
    expect(tools).toContain('wms.inventory.adjust');
    expect(tools).toContain('库存调整');
    expect(tools).toContain('skuCode');
  });

  it('tool-calls / tool-results 历史正确翻译（含旁白与错误输出）', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => textResult('done') });
    const provider = createVercelLlmProvider(mock as never);

    const messages: AgentMessage[] = [
      { role: 'user', text: '出库 999 个' },
      { role: 'tool-calls', text: '我试试', calls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -999 } }] },
      { role: 'tool-results', results: [{ callId: 'c1', toolId: 'wms.inventory.adjust', ok: false, payload: { error: 'InsufficientStockError: 库存不足' } }] },
    ];
    await provider.completeTurn(baseRequest(messages));

    const prompt = JSON.stringify(mock.doGenerateCalls[0].prompt);
    expect(prompt).toContain('我试试');
    expect(prompt).toContain('tool-call');
    expect(prompt).toContain('tool-result');
    expect(prompt).toContain('error-json');
    expect(prompt).toContain('库存不足');
    expect(prompt).toContain('-999');
  });

  it('多轮往返：第一轮的调用+结果作为历史进入第二轮 prompt', async () => {
    const results = [
      toolCallResult('c1', 'wms.inventory.adjust', { skuCode: 'A-1', delta: 10 }),
      textResult('入库完成'),
    ];
    const mock = new MockLanguageModelV4({ doGenerate: results });
    const provider = createVercelLlmProvider(mock as never);

    const first = await provider.completeTurn(baseRequest([{ role: 'user', text: '入库 10 个 A-1' }]));
    const second = await provider.completeTurn(
      baseRequest([
        { role: 'user', text: '入库 10 个 A-1' },
        { role: 'tool-calls', calls: first.toolCalls },
        { role: 'tool-results', results: [{ callId: 'c1', toolId: 'wms.inventory.adjust', ok: true, payload: { quantity: 10 } }] },
      ]),
    );

    expect(second.text).toBe('入库完成');
    expect(second.toolCalls).toEqual([]);
    const secondPrompt = JSON.stringify(mock.doGenerateCalls[1].prompt);
    expect(secondPrompt).toContain('quantity');
  });
});

describe('createVercelLlmProvider：streamTurn（流式互译）', () => {
  it('文本分片逐段透传（text-start/delta/end）', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: '你' },
          { type: 'text-delta', id: 't1', delta: '好' },
          { type: 'text-end', id: 't1' },
          FINISH_STOP,
        ]),
    });
    const provider = createVercelLlmProvider(mock as never);

    const chunks = await collectChunks(provider, baseRequest([{ role: 'user', text: 'hi' }]));

    expect(chunks).toEqual([
      { type: 'text-delta', text: '你' },
      { type: 'text-delta', text: '好' },
    ]);
  });

  it('工具调用：input JSON 串解为 args，收敛成 tool-calls 终片', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: '我来入库' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'wms.inventory.adjust', input: JSON.stringify({ skuCode: 'A-1', delta: 10 }) },
          FINISH_TOOLS,
        ]),
    });
    const provider = createVercelLlmProvider(mock as never);

    const chunks = await collectChunks(provider, baseRequest([{ role: 'user', text: '入库 10 个 A-1' }]));

    expect(chunks).toEqual([
      { type: 'text-delta', text: '我来入库' },
      { type: 'tool-calls', text: '我来入库', calls: [{ callId: 'call_1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 10 } }] },
    ]);
  });

  it('请求翻译与 completeTurn 一致（system/历史/工具定义透传）', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => streamResult([FINISH_STOP]),
    });
    const provider = createVercelLlmProvider(mock as never);

    await collectChunks(
      provider,
      baseRequest([{ role: 'user', text: '入库 10 个 A-1' }]),
    );

    const call = mock.doStreamCalls[0];
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain('SYS-PROMPT');
    expect(prompt).toContain('入库 10 个 A-1');
    expect(JSON.stringify(call.tools ?? [])).toContain('wms.inventory.adjust');
  });
});
