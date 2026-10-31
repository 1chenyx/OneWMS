import type { AgentMessage, AgentToolMeta, LlmProvider, ToolCallResult } from './types.js';

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
