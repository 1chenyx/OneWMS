import { generateText, isStepCount, jsonSchema, streamText, tool as sdkTool } from 'ai';
import type {
  AssistantContent,
  JSONSchema7,
  JSONValue,
  LanguageModel,
  ModelMessage,
  ToolContent,
  ToolSet,
} from 'ai';
import type {
  AgentMessage,
  AgentToolMeta,
  LlmProvider,
  LlmStreamChunk,
  LlmTurnRequest,
  LlmTurnResponse,
  ToolCallRequest,
} from '../types.js';

/**
 * LlmProvider 的 Vercel AI SDK 实现（薄 IO 适配层，冻结决策 §10）。
 *
 * 职责刻意收窄为「单轮补全」：把一轮请求翻译成 generateText 调用、把结果
 * 翻译回我们的规范类型。步间循环（结果回传后再调模型）在 agent.ts——
 * 那是纯逻辑，必须可单测；本层只做格式互译 + 一次网络往返。
 *
 * 工具不挂 execute（工具执行权在编排层手上的 invoke 闭包）：
 * stopWhen: isStepCount(1) 让 SDK 做完一轮「模型 → toolCalls」即停，
 * 不进入 SDK 内置的多步 agent 循环——循环主权在我们这里。
 */
export function createVercelLlmProvider(model: LanguageModel): LlmProvider {
  return {
    async completeTurn(req: LlmTurnRequest): Promise<LlmTurnResponse> {
      const result = await generateText({
        model,
        system: req.system,
        messages: toModelMessages(req.messages),
        tools: toToolSet(req.tools),
        stopWhen: isStepCount(1),
      });
      return {
        text: result.text,
        toolCalls: result.toolCalls.map((c) => ({
          callId: c.toolCallId,
          toolId: c.toolName,
          args: (c.input ?? {}) as Record<string, unknown>,
        })),
      };
    },

    /**
     * 流式单轮补全：fullStream 边到边翻——text-delta 分片直译为我们的
     * text-delta 分片；tool-call 分片累积，流尽后以一条 tool-calls 终片收尾。
     * 与 completeTurn 同样不挂 execute、stopWhen 单步——循环主权在编排层。
     */
    async *streamTurn(req: LlmTurnRequest): AsyncGenerator<LlmStreamChunk> {
      const result = streamText({
        model,
        system: req.system,
        messages: toModelMessages(req.messages),
        tools: toToolSet(req.tools),
        stopWhen: isStepCount(1),
      });

      let text = '';
      const calls: ToolCallRequest[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text += part.text;
          yield { type: 'text-delta', text: part.text };
        } else if (part.type === 'tool-call') {
          calls.push({
            callId: part.toolCallId,
            toolId: part.toolName,
            args: (part.input ?? {}) as Record<string, unknown>,
          });
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
      if (calls.length > 0) {
        yield { type: 'tool-calls', text: text || undefined, calls };
      }
    },
  };
}

/** 工具元数据 → SDK ToolSet（id 即 toolName；schema 透传，参数校验在工具总线） */
function toToolSet(tools: AgentToolMeta[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.id] = sdkTool({
      description: `${t.label}——${t.description}`,
      // ParameterSchema 是 JSON Schema 的结构子集，运行时兼容；类型系统两边独立演化，此处受控断开
      inputSchema: jsonSchema(t.parameters as unknown as JSONSchema7),
    });
  }
  return set;
}

/** 规范消息 → SDK ModelMessage（编排层不认识 SDK 类型，翻译收敛在此） */
function toModelMessages(messages: AgentMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        out.push({ role: 'user', content: m.text });
        break;
      case 'assistant':
        out.push({ role: 'assistant', content: m.text });
        break;
      case 'tool-calls': {
        const content: AssistantContent = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.calls) {
          content.push({ type: 'tool-call', toolCallId: c.callId, toolName: c.toolId, input: c.args });
        }
        out.push({ role: 'assistant', content });
        break;
      }
      case 'tool-results': {
        const content: ToolContent = m.results.map((r) => ({
          type: 'tool-result',
          toolCallId: r.callId,
          toolName: r.toolId,
          output: r.ok
            ? { type: 'json', value: toJsonValue(r.payload) }
            : { type: 'error-json', value: toJsonValue(r.payload) },
        }));
        out.push({ role: 'tool', content });
        break;
      }
    }
  }
  return out;
}

/** 工具返回值 → JSONValue（不可序列化的返回值降级为错误对象，绝不炸编排循环） */
function toJsonValue(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
  } catch {
    return { error: '工具返回值不可序列化' };
  }
}
