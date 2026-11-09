import type { WmsWorkspace } from '@one/wms';
import { runAgent, streamAgent, type AgentRunResult, type AgentStreamEvent, type AgentTurnResult, type AskReply } from './agent.js';
import { UI_ASK_DESCRIPTION, UI_ASK_PARAM_DESCRIPTION } from './prompts.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { AgentDefinition } from './agent-defs.js';
import type { AgentMemoryContext, AgentMessage, AgentToolMeta, LlmProvider } from './types.js';

/**
 * WMS 便利工厂：把编排循环、System Prompt、工具总线三件事绑定到一个工作区。
 *
 * 审计语义（DESIGN.md §9.3）：invoke 闭包把 actor 固定为 'ai:{助手id}'——
 * AI 经工具总线的每次操作（含被拒的尝试）都落 oplog，事件即审计日志。
 * 工具元数据取自 tools.list()（handler 不可见，AI 上下文安全）。
 *
 * M16 起按 AgentDefinition 装配（多实例）：工具授权按 def.tools 过滤总线、
 * 人设前缀 + 全局纪律后缀、actor 标识助手而非模型——「谁干的」以助手为单位可审计。
 */

/**
 * ui.ask 工具元数据（M12 步骤3）：会话壳专属的「向用户提问」分流工具。
 * 只附加进 stream() 的工具清单——编排层拦截挂起（不进工具总线、不落 oplog）；
 * run()（单轮任务式）不提供：没有挂起等待的通道，附加了也无法履约。
 */
const UI_ASK_TOOL: AgentToolMeta = {
  id: 'ui.ask',
  label: '向用户提问',
  description: UI_ASK_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: UI_ASK_PARAM_DESCRIPTION },
    },
    required: ['question'],
  },
  permission: 'read',
};

export interface WmsAgent {
  /** 审计标识：'ai:{助手id}'（oplog actor 字段的取值） */
  readonly actor: string;
  /**
   * 授权工具快照（构造时取自工具总线，不含 ui.ask / tools.load）。
   * 送给模型的是目录呈现：一行摘要，tools.load 之后该组才换成完整说明。
   */
  readonly tools: AgentToolMeta[];
  /** 运行一次自然语言任务（单轮任务式；会话管理是前端壳的职责） */
  run(userText: string): Promise<AgentRunResult>;
  /**
   * 流式运行一次自然语言任务（M12 会话化）：接收会话历史、逐事件产出。
   * return 值携带完整 messages，server 会话在 turn-done 后提交历史。
   * 工具清单附加 ui.ask（挂起提问的分流工具），next(reply) 注入用户回答。
   */
  stream(
    userText: string,
    history?: AgentMessage[],
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult, AskReply>;
}

/** 会话专属工具（如本轮上传的附件）。只挂在 stream，不进工具总线，也不出现在 run()。 */
export interface SessionTool {
  meta: AgentToolMeta;
  invoke(args: Record<string, unknown>, actor: string): Promise<unknown>;
}

export interface CreateAgentFromDefOptions {
  /** 节点 id（进审计 actor 后缀 @nodeId）——多节点同步时保持通道唯一（M5，§8.5） */
  nodeId?: string;
  /** 编排步数上限（透传 runAgent，默认 8） */
  maxSteps?: number;
  /** 长期记忆上下文（T0 常驻段 + T2 预取全文；调用方从记忆投影现算） */
  memory?: AgentMemoryContext;
  /** 本条消息额外可用的会话工具（附件读写）。run() 不装配。 */
  sessionTools?: readonly SessionTool[];
}

/**
 * 按定义装配一个助手实例（M16）：每条消息现场调用（chat 路由），
 * 定义改动经慢通道确认后下一轮对话即生效（快照新鲜度以消息为粒度）。
 *
 *  - 工具过滤：def.tools ∩ 总线在场项（授权了但不在场的工具静默丢弃——
 *    定义是脏面，卸载模块后旧清单不该炸装配）；
 *  - System Prompt = def.systemPrompt（人设前缀）+ '\n\n' + buildSystemPrompt(ws, memory)
 *    （全局纪律与数据快照后缀——人设可定制，纪律不删减；memory 是
 *    可选的长期上下文注入，AgentMemoryContext 结构化类型不引入包依赖）；
 *  - 'agent:<id>' 委托形态（多 AI 协作）是 v2 预留：v1 装配直接抛错，
 *    不允许静默降级成「工具不存在」。
 */
export function createAgentFromDef(
  ws: WmsWorkspace,
  provider: LlmProvider,
  def: AgentDefinition,
  options: CreateAgentFromDefOptions = {},
): WmsAgent {
  const delegated = def.tools.find((id) => id.startsWith('agent:'));
  if (delegated !== undefined) {
    throw new Error(
      `AGENT_DELEGATION_UNSUPPORTED: 助手 "${def.id}" 的工具 "${delegated}" 是多 AI 委托形态（agent:<id>，v2 预留），v1 不支持装配`,
    );
  }
  const byId = new Map(ws.tools.list().map((t) => [t.id, t]));
  const tools: AgentToolMeta[] = def.tools.flatMap((id) => {
    const t = byId.get(id);
    return t
      ? [{ id: t.id, label: t.label, description: t.description, parameters: t.parameters, permission: t.permission }]
      : [];
  });

  const base = `ai:${def.id}`;
  const actor = options.nodeId ? `${base}@${options.nodeId}` : base;
  const system = `${def.systemPrompt.trim()}\n\n${buildSystemPrompt(ws, options.memory)}`;
  const sessionTools = options.sessionTools ?? [];

  return {
    actor,
    tools,
    run: (userText) =>
      runAgent(userText, {
        provider,
        // 每次任务重组快照——数据新鲜度以任务为粒度
        system,
        tools,
        invoke: (toolId, args) => ws.tools.invoke(toolId, args, actor),
        maxSteps: options.maxSteps,
        // 常驻瘦 schema；tools.load 在编排层把一组的完整说明升进下一轮
        catalog: true,
      }),
    stream: (userText, history) =>
      streamAgent(userText, {
        provider,
        system,
        // 会话通道附加 ui.ask（分流：编排层拦截挂起，不进工具总线）和本轮附件工具
        tools: [...tools, UI_ASK_TOOL, ...sessionTools.map((tool) => tool.meta)],
        invoke: (toolId, args) => {
          const extra = sessionTools.find((tool) => tool.meta.id === toolId);
          if (extra) return extra.invoke(args, actor);
          return ws.tools.invoke(toolId, args, actor);
        },
        maxSteps: options.maxSteps,
        history,
        catalog: true,
        sessionToolIds: sessionTools.map((tool) => tool.meta.id),
      }),
  };
}
