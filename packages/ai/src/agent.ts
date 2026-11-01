import type {
  AgentMessage,
  AgentToolMeta,
  LlmProvider,
  LlmTurnResponse,
  ToolCallRequest,
  ToolCallResult,
} from './types.js';

/**
 * AI 快通道编排循环（DESIGN.md §4.2 / §9）。
 *
 * 这是「意图 → tool_calls → 工具总线 → 结果回传 → 循环 → 最终回复」的纯逻辑：
 *  - LLM 通信全部收敛在注入的 LlmProvider（IO 边界），本文件零 SDK 依赖、可单测；
 *  - 工具执行全部穿过注入的 invoke 闭包（→ ToolsView.invoke，规则即护栏）；
 *  - 工具被拒（ToolRejectedError 族等任何异常）不中断循环——错误信息回传模型，
 *    由它向用户解释（§9.3 审计免费：拒绝的操作本来就不落事件）。
 */
export class AgentStepLimitError extends Error {
  constructor(readonly maxSteps: number) {
    super(`AI 编排步数超过上限 ${maxSteps}，已中止（防止模型无限循环调用工具）`);
    this.name = 'AgentStepLimitError';
  }
}

/** 一次工具调用的执行记录（结果可观测/测试断言用） */
export interface AgentInvocation {
  toolId: string;
  args: Record<string, unknown>;
  ok: boolean;
  payload: unknown;
}

export interface AgentRunResult {
  /** 模型的最终回复文本 */
  text: string;
  /** LLM 调用轮数（含最终回复那轮） */
  steps: number;
  /** 本轮会话的完整消息历史（含工具调用与结果） */
  messages: AgentMessage[];
  /** 全部工具调用记录（成功与失败都在） */
  invocations: AgentInvocation[];
}

export interface RunAgentDeps {
  provider: LlmProvider;
  system: string;
  tools: AgentToolMeta[];
  /** 工具执行入口（绑定 workspace 与 actor——审计在 ToolsView 落 oplog） */
  invoke: (toolId: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 编排步数上限，默认 8 */
  maxSteps?: number;
}

/**
 * 运行一次 AI 任务：从用户输入出发，驱动「模型 ⇄ 工具」循环直到模型给出最终回复。
 * 单轮任务式（无跨次会话记忆）——会话管理是前端壳（M5+）的职责。
 */
export async function runAgent(userText: string, deps: RunAgentDeps): Promise<AgentRunResult> {
  const { provider, system, tools, invoke } = deps;
  const maxSteps = deps.maxSteps ?? 8;

  const messages: AgentMessage[] = [{ role: 'user', text: userText }];
  const invocations: AgentInvocation[] = [];
  let steps = 0;

  for (;;) {
    if (++steps > maxSteps) throw new AgentStepLimitError(maxSteps);

    const res = await provider.completeTurn({ system, messages, tools });

    // 终态：模型不再调用工具 → 本轮文本即最终回复
    if (res.toolCalls.length === 0) {
      return { text: res.text, steps, messages, invocations };
    }

    // 记录模型的工具调用（保留旁白文本，翻给下一轮请求时模型能看见自己说过什么）
    messages.push({ role: 'tool-calls', text: res.text || undefined, calls: res.toolCalls });

    // 逐个执行：任何异常都转为 ok=false 的结果回传——循环不中断（§4.2 快通道护栏语义）
    const results: ToolCallResult[] = [];
    for (const call of res.toolCalls) {
      let result: ToolCallResult;
      try {
        const payload = await invoke(call.toolId, call.args);
        result = { callId: call.callId, toolId: call.toolId, ok: true, payload };
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        result = { callId: call.callId, toolId: call.toolId, ok: false, payload: { error: message } };
      }
      results.push(result);
      invocations.push({ toolId: call.toolId, args: call.args, ok: result.ok, payload: result.payload });
    }
    messages.push({ role: 'tool-results', results });
  }
}

// ── 流式编排（M12：SSE 会话化）──────────────────────────

/** ui.ask 的用户应答：{ answer } = 用户输入；{ declined: true } = 跳过或超时 */
export type AskReply = { answer: string } | { declined: true };

/** 流式编排对外的事件协议（server 层直译为 SSE 事件；callId 供前端对齐卡片） */
export type AgentStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; callId: string; toolId: string; args: Record<string, unknown> }
  /** ui.ask 挂起：驱动方暂停消费本流，等用户回答（或超时）经 next(reply) 注入 */
  | { type: 'ask'; callId: string; question: string }
  | { type: 'tool-result'; callId: string; toolId: string; ok: boolean; payload: unknown }
  | { type: 'turn-done'; steps: number };

/** 一次流式任务的终态结果：messages 是完整历史（含最终 assistant 回复），供会话续跑 */
export interface AgentTurnResult {
  text: string;
  steps: number;
  messages: AgentMessage[];
}

export interface StreamAgentDeps extends RunAgentDeps {
  /** 会话历史（此前各轮的完整消息序列）——多轮上下文的来源 */
  history?: AgentMessage[];
}

/**
 * 流式运行一次 AI 任务：与 runAgent 同一条「模型 ⇄ 工具」循环，但逐事件产出：
 * text-delta（旁白/最终回复的增量）→ tool-call / tool-result（每个工具一对）→
 * turn-done。生成器 return 值携带完整 messages——server 会话在 turn-done 后
 * 用它提交历史（失败/中止的轮次不提交，会话回到上一完整轮）。
 *
 * 与 runAgent 的三点差异：
 *  - Provider 走可选的 streamTurn（未实现则回退 completeTurn，整轮文本单个 delta）；
 *  - 终态时把最终回复追加为 assistant 消息（多轮会话需要；runAgent 保持旧语义不动）；
 *  - ui.ask 分流（M12 步骤3）：模型调用 ui.ask 时 yield ask 事件后挂起，用户的
 *    回答由驱动方经 next(reply) 注入（yield 表达式的值），作为 tool-result 回传
 *    模型——ui.ask 不进 invoke（不穿工具总线，不落 oplog，审计豁免）。
 */
export async function* streamAgent(
  userText: string,
  deps: StreamAgentDeps,
): AsyncGenerator<AgentStreamEvent, AgentTurnResult, AskReply> {
  const { provider, system, tools, invoke } = deps;
  const maxSteps = deps.maxSteps ?? 8;

  const messages: AgentMessage[] = [...(deps.history ?? []), { role: 'user', text: userText }];
  let steps = 0;

  for (;;) {
    if (++steps > maxSteps) throw new AgentStepLimitError(maxSteps);

    // 单轮模型调用：yield 增量文本（直译为 text-delta 事件），return 完整响应
    const turn = streamOneTurn(provider, { system, messages, tools });
    let res: LlmTurnResponse;
    for (;;) {
      const { value, done } = await turn.next();
      if (done) {
        res = value;
        break;
      }
      yield { type: 'text-delta', text: value };
    }

    // 终态：模型不再调用工具 → 追加 assistant 消息后收尾
    if (res.toolCalls.length === 0) {
      messages.push({ role: 'assistant', text: res.text });
      yield { type: 'turn-done', steps };
      return { text: res.text, steps, messages };
    }

    messages.push({ role: 'tool-calls', text: res.text || undefined, calls: res.toolCalls });

    // 逐个执行：任何异常都转为 ok=false 的结果回传——循环不中断（与 runAgent 一致）
    const results: ToolCallResult[] = [];
    for (const call of res.toolCalls) {
      // ui.ask 分流（M12 步骤3）：挂起等待用户回答（经 next(reply) 注入），
      // 回答原样作为 payload 回传模型；不进 invoke——提问不是业务操作，
      // 不穿工具总线、不落 oplog（审计豁免）
      if (call.toolId === 'ui.ask') {
        const question = typeof call.args.question === 'string' ? call.args.question : '';
        const reply = yield { type: 'ask', callId: call.callId, question };
        const payload = isAskReply(reply) ? reply : { declined: true };
        const result: ToolCallResult = { callId: call.callId, toolId: call.toolId, ok: true, payload };
        results.push(result);
        yield {
          type: 'tool-result',
          callId: call.callId,
          toolId: call.toolId,
          ok: true,
          payload,
        };
        continue;
      }
      yield { type: 'tool-call', callId: call.callId, toolId: call.toolId, args: call.args };
      let result: ToolCallResult;
      try {
        const payload = await invoke(call.toolId, call.args);
        result = { callId: call.callId, toolId: call.toolId, ok: true, payload };
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        result = { callId: call.callId, toolId: call.toolId, ok: false, payload: { error: message } };
      }
      results.push(result);
      yield {
        type: 'tool-result',
        callId: call.callId,
        toolId: call.toolId,
        ok: result.ok,
        payload: result.payload,
      };
    }
    messages.push({ role: 'tool-results', results });
  }
}

/** next() 注入值的运行时校验：缺省（普通 next() 恢复）或形状非法一律按 declined 处理 */
function isAskReply(v: unknown): v is AskReply {
  if (!v || typeof v !== 'object') return false;
  if (typeof (v as { answer?: unknown }).answer === 'string') return true;
  return (v as { declined?: unknown }).declined === true;
}

/**
 * 单轮模型调用（生成器形态）：yield 增量文本，return 本轮完整响应。
 * 优先 streamTurn（真流式）；未实现则回退 completeTurn（整轮文本单个增量）。
 * tool-calls 终片若携带未流过的旁白文本，也会作为增量补发。
 */
async function* streamOneTurn(
  provider: LlmProvider,
  req: { system: string; messages: AgentMessage[]; tools: AgentToolMeta[] },
): AsyncGenerator<string, LlmTurnResponse> {
  if (provider.streamTurn) {
    let text = '';
    const calls: ToolCallRequest[] = [];
    for await (const chunk of provider.streamTurn(req)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        yield chunk.text;
      } else {
        if (chunk.text && !text) yield chunk.text;
        if (chunk.text) text = chunk.text;
        calls.push(...chunk.calls);
      }
    }
    return { text, toolCalls: calls };
  }
  const res = await provider.completeTurn(req);
  if (res.text) yield res.text;
  return res;
}
