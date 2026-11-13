import {
  applyLoad,
  catalogBlock,
  expandedGroupsFromHistory,
  presentCatalog,
  TOOLS_LOAD_ID,
  toolGroup,
  touchLoadedGroup,
} from './tool-catalog.js';
import { messagesForModel } from './model-history.js';
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
 *  - 同一工具、同一参数已经失败过，本次运行里不再执行，把上次的错误交回模型。
 *  - 同一步里相邻的读工具一起执行；写、ui.ask、目录结算仍按出现顺序。
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
  /**
   * 工具执行入口（绑定 workspace 与 actor——审计在 ToolsView 落 oplog）。
   * callId 是模型给这次调用的编号，实现方可拿它当幂等键（同一次调用重复执行
   * 只落一次账）；编排层自己不重试，透传即可。
   */
  invoke: (toolId: string, args: Record<string, unknown>, callId?: string) => Promise<unknown>;
  /** 编排步数上限，默认 8 */
  maxSteps?: number;
  /**
   * 工具目录（createAgentFromDef 开启）。常驻瘦 schema，tools.load 把一组的
   * 完整说明升进下一轮；该调用不进 invoke。缺省关闭，编排单测保持原样透传。
   */
  catalog?: boolean;
  /**
   * 会话壳工具 id（ui.ask、本轮附件）。不进目录分组，始终以完整 schema 附在清单末尾。
   * ui.ask 即使不在此列也会被当作会话工具。
   */
  sessionToolIds?: readonly string[];
}

/**
 * 运行一次 AI 任务：从用户输入出发，驱动「模型 ⇄ 工具」循环直到模型给出最终回复。
 * 单轮任务式（无跨次会话记忆）——会话管理是前端壳（M5+）的职责。
 */
export async function runAgent(userText: string, deps: RunAgentDeps): Promise<AgentRunResult> {
  const { provider, system, tools, invoke } = deps;
  const maxSteps = deps.maxSteps ?? 20;

  const messages: AgentMessage[] = [{ role: 'user', text: userText }];
  const invocations: AgentInvocation[] = [];
  const failures = new Map<string, string>();
  let steps = 0;
  const catalog = startCatalog(tools, messages, deps.catalog === true, deps.sessionToolIds);

  for (;;) {
    if (++steps > maxSteps) throw new AgentStepLimitError(maxSteps);

    const res = await provider.completeTurn({
      system,
      messages: messagesForModel(messages),
      tools: toolsForTurn(catalog, tools),
    });

    // 终态：模型不再调用工具 → 本轮文本即最终回复
    if (res.toolCalls.length === 0) {
      return { text: res.text, steps, messages, invocations };
    }

    // 记录模型的工具调用（保留旁白文本，翻给下一轮请求时模型能看见自己说过什么）
    messages.push({ role: 'tool-calls', text: res.text || undefined, calls: res.toolCalls });

    const exec = executeCalls(res.toolCalls, { tools, invoke, catalog, failures, invocations, emit: false });
    let results: ToolCallResult[] = [];
    for (;;) {
      const step = await exec.next();
      if (step.done) {
        results = step.value;
        break;
      }
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
  const maxSteps = deps.maxSteps ?? 20;

  const messages: AgentMessage[] = [...(deps.history ?? []), { role: 'user', text: userText }];
  const failures = new Map<string, string>();
  let steps = 0;
  const catalog = startCatalog(tools, messages, deps.catalog === true, deps.sessionToolIds);

  for (;;) {
    if (++steps > maxSteps) throw new AgentStepLimitError(maxSteps);

    // 单轮模型调用：yield 增量文本（直译为 text-delta 事件），return 完整响应
    const turn = streamOneTurn(provider, {
      system,
      messages: messagesForModel(messages),
      tools: toolsForTurn(catalog, tools),
    });
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

    const exec = executeCalls(res.toolCalls, { tools, invoke, catalog, failures, emit: true });
    let reply: AskReply | undefined;
    let results: ToolCallResult[] = [];
    for (;;) {
      const step = await exec.next(reply);
      reply = undefined;
      if (step.done) {
        results = step.value;
        break;
      }
      if (step.value.type === 'ask') reply = yield step.value;
      else yield step.value;
    }
    messages.push({ role: 'tool-results', results });
  }
}

interface CatalogRuntime {
  domain: AgentToolMeta[];
  session: AgentToolMeta[];
  sessionIds: Set<string>;
  expanded: Set<string>;
}

/** 从本轮工具里拆出业务工具与会话壳。目录关闭时返回 undefined */
function startCatalog(
  tools: AgentToolMeta[],
  messages: AgentMessage[],
  enabled: boolean,
  sessionToolIds: readonly string[] = [],
): CatalogRuntime | undefined {
  if (!enabled) return undefined;
  const sessionIds = new Set(['ui.ask', ...sessionToolIds]);
  return {
    domain: tools.filter((t) => !sessionIds.has(t.id) && t.id !== TOOLS_LOAD_ID),
    session: tools.filter((t) => sessionIds.has(t.id)),
    sessionIds,
    expanded: expandedGroupsFromHistory(messages),
  };
}

function toolsForTurn(catalog: CatalogRuntime | undefined, fallback: AgentToolMeta[]): AgentToolMeta[] {
  if (!catalog) return fallback;
  return presentCatalog(catalog.domain, catalog.expanded, catalog.session);
}

/**
 * 目录内结算：tools.load 记入已加载组；越权或未加载的调用直接回错误。
 * 返回 undefined 表示这是一次普通业务调用，交给 invoke。
 */
function settleCatalog(call: ToolCallRequest, catalog: CatalogRuntime): ToolCallResult | undefined {
  if (call.toolId === TOOLS_LOAD_ID) {
    const outcome = applyLoad(catalog.domain, call.args);
    if (outcome.ok && outcome.group) touchLoadedGroup(catalog.expanded, outcome.group);
    return { callId: call.callId, toolId: call.toolId, ok: outcome.ok, payload: outcome.payload };
  }
  const blocked = catalogBlock(call.toolId, catalog.domain, catalog.expanded, catalog.sessionIds);
  if (!blocked) return undefined;
  return { callId: call.callId, toolId: call.toolId, ok: false, payload: blocked };
}

const REPEATED_FAILURE_NOTE =
  '同一工具、同一参数已经失败过，本次没有再次执行。请把这个错误告诉用户，不要再用相同参数重试。';

type ExecEvent = Exclude<AgentStreamEvent, { type: 'text-delta' } | { type: 'turn-done' }>;

interface ExecCtx {
  tools: readonly AgentToolMeta[];
  invoke: RunAgentDeps['invoke'];
  catalog?: CatalogRuntime;
  /** 本轮运行内，工具 + 参数 → 已经出现过的错误原文 */
  failures: Map<string, string>;
  invocations?: AgentInvocation[];
  /** 流式路径才向调用方 yield 事件，并挂起 ui.ask */
  emit: boolean;
}

/**
 * 执行模型在同一步里给出的工具调用。
 * 相邻的读一起开始；写、ui.ask 和目录结算按顺序，后一个等前一个结束。
 * runAgent 不 emit，生成器不 yield，一次 next() 就跑完。
 */
async function* executeCalls(
  calls: readonly ToolCallRequest[],
  ctx: ExecCtx,
): AsyncGenerator<ExecEvent, ToolCallResult[], AskReply | undefined> {
  const results: ToolCallResult[] = [];
  let index = 0;
  while (index < calls.length) {
    const call = calls[index]!;
    if (ctx.emit && call.toolId === 'ui.ask') {
      const question = typeof call.args.question === 'string' ? call.args.question : '';
      const reply = yield { type: 'ask', callId: call.callId, question };
      const payload = isAskReply(reply) ? reply : { declined: true };
      results.push({ callId: call.callId, toolId: call.toolId, ok: true, payload });
      yield { type: 'tool-result', callId: call.callId, toolId: call.toolId, ok: true, payload };
      index += 1;
      continue;
    }
    if (ctx.catalog) {
      const settled = settleCatalog(call, ctx.catalog);
      if (settled) {
        ctx.invocations?.push({ toolId: call.toolId, args: call.args, ok: settled.ok, payload: settled.payload });
        results.push(settled);
        if (ctx.emit) {
          yield { type: 'tool-call', callId: call.callId, toolId: call.toolId, args: call.args };
          yield {
            type: 'tool-result',
            callId: call.callId,
            toolId: call.toolId,
            ok: settled.ok,
            payload: settled.payload,
          };
        }
        index += 1;
        continue;
      }
    }
    if (isParallelRead(call, ctx)) {
      const batch: ToolCallRequest[] = [];
      while (index < calls.length && isParallelRead(calls[index]!, ctx)) {
        batch.push(calls[index]!);
        index += 1;
      }
      if (ctx.emit) {
        for (const item of batch) {
          yield { type: 'tool-call', callId: item.callId, toolId: item.toolId, args: item.args };
        }
      }
      const settled = await Promise.all(batch.map((item) => invokeOne(item, ctx)));
      for (let i = 0; i < settled.length; i += 1) {
        const result = settled[i]!;
        const item = batch[i]!;
        ctx.invocations?.push({ toolId: item.toolId, args: item.args, ok: result.ok, payload: result.payload });
        results.push(result);
        if (ctx.emit) {
          yield {
            type: 'tool-result',
            callId: result.callId,
            toolId: result.toolId,
            ok: result.ok,
            payload: result.payload,
          };
        }
      }
      continue;
    }
    if (ctx.emit) {
      yield { type: 'tool-call', callId: call.callId, toolId: call.toolId, args: call.args };
    }
    const result = await invokeOne(call, ctx);
    ctx.invocations?.push({ toolId: call.toolId, args: call.args, ok: result.ok, payload: result.payload });
    results.push(result);
    if (ctx.emit) {
      yield {
        type: 'tool-result',
        callId: result.callId,
        toolId: result.toolId,
        ok: result.ok,
        payload: result.payload,
      };
    }
    index += 1;
  }
  return results;
}

/** 会进工具总线的读。ui.ask、tools.load、写，以及目录直接拦下的调用都不并进这一批。 */
function isParallelRead(call: ToolCallRequest, ctx: ExecCtx): boolean {
  if (call.toolId === 'ui.ask' || call.toolId === TOOLS_LOAD_ID) return false;
  if (ctx.catalog && catalogBlock(call.toolId, ctx.catalog.domain, ctx.catalog.expanded, ctx.catalog.sessionIds)) {
    return false;
  }
  return ctx.tools.some((tool) => tool.id === call.toolId && tool.permission === 'read');
}

async function invokeOne(call: ToolCallRequest, ctx: ExecCtx): Promise<ToolCallResult> {
  const key = failureKey(call.toolId, call.args);
  const prior = ctx.failures.get(key);
  if (prior !== undefined) {
    const payload = { error: prior, repeated: true, note: REPEATED_FAILURE_NOTE };
    noteUse(ctx, call.toolId);
    return { callId: call.callId, toolId: call.toolId, ok: false, payload };
  }
  try {
    const payload = await ctx.invoke(call.toolId, call.args, call.callId);
    noteUse(ctx, call.toolId);
    return { callId: call.callId, toolId: call.toolId, ok: true, payload };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.failures.set(key, message);
    noteUse(ctx, call.toolId);
    return { callId: call.callId, toolId: call.toolId, ok: false, payload: { error: message } };
  }
}

/** 已经加载过的组，被实际调用时记为最近使用，避免下一轮加载把还在用的组挤掉。 */
function noteUse(ctx: ExecCtx, toolId: string): void {
  if (!ctx.catalog) return;
  const group = toolGroup(toolId);
  if (ctx.catalog.expanded.has(group)) touchLoadedGroup(ctx.catalog.expanded, group);
}

function failureKey(toolId: string, args: Record<string, unknown>): string {
  return `${toolId}\0${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
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
