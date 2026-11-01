import type { WmsWorkspace } from '@one/wms';
import { runAgent, streamAgent, type AgentRunResult, type AgentStreamEvent, type AgentTurnResult, type AskReply } from './agent.js';
import { UI_ASK_DESCRIPTION, UI_ASK_PARAM_DESCRIPTION } from './prompts.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { AgentMessage, AgentToolMeta, LlmProvider } from './types.js';

/**
 * WMS 便利工厂：把编排循环、System Prompt、工具总线三件事绑定到一个工作区。
 *
 * 审计语义（DESIGN.md §9.3）：invoke 闭包把 actor 固定为 'ai:模型名'——
 * AI 经工具总线的每次操作（含被拒的尝试）都落 oplog，事件即审计日志。
 * 工具元数据取自 tools.list()（handler 不可见，AI 上下文安全）。
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
  /** 审计标识：'ai:模型名'（oplog actor 字段的取值） */
  readonly actor: string;
  /** 暴露给模型的工具清单（快照，构造时取自工具总线；不含会话壳附加的 ui.ask） */
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

export interface CreateWmsAgentOptions {
  /** 模型名（进审计 actor，如 'qwen3:8b'）；缺省 'assistant' */
  model?: string;
  /** 节点 id（进审计 actor 后缀 @nodeId）——多节点同步时保持通道唯一（M5，§8.5） */
  nodeId?: string;
  /** 编排步数上限（透传 runAgent，默认 8） */
  maxSteps?: number;
}

export function createWmsAgent(
  ws: WmsWorkspace,
  provider: LlmProvider,
  options: CreateWmsAgentOptions = {},
): WmsAgent {
  const base = `ai:${options.model ?? 'assistant'}`;
  const actor = options.nodeId ? `${base}@${options.nodeId}` : base;
  const tools: AgentToolMeta[] = ws.tools.list().map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    permission: t.permission,
  }));

  return {
    actor,
    tools,
    run: (userText) =>
      runAgent(userText, {
        provider,
        // 每次任务重组快照——数据新鲜度以任务为粒度
        system: buildSystemPrompt(ws),
        tools,
        invoke: (toolId, args) => ws.tools.invoke(toolId, args, actor),
        maxSteps: options.maxSteps,
      }),
    stream: (userText, history) =>
      streamAgent(userText, {
        provider,
        system: buildSystemPrompt(ws),
        // 会话通道附加 ui.ask（分流：编排层拦截挂起，不进工具总线）
        tools: [...tools, UI_ASK_TOOL],
        invoke: (toolId, args) => ws.tools.invoke(toolId, args, actor),
        maxSteps: options.maxSteps,
        history,
      }),
  };
}
