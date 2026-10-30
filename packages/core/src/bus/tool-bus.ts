import { ToolNotFoundError, ToolValidationError } from '../errors.js';
import { validateParameters, type ParameterSchema } from './schema-validator.js';

/**
 * 工具总线（ToolBus，DESIGN.md §4 宪法 / §9）。
 *
 * 这是 AI、人机界面、权限系统三者的共同通道：
 *  - AI 的 Tool Calling 走这里 → AI 永远拿不到 SQL（需求 3 的边界）；
 *  - 每次调用必带 ToolContext（actor + workspaceId）→ 权限中间件的插口（§10 预留）；
 *  - 工具的业务校验（库存不为负等）在 handler 内部 → 规则即护栏，绕不过去。
 *
 * 工具注册表是进程内内存态（代码加载的一部分，随模块装卸重建），
 * 持久化的是 manifest——由未来的模块系统负责，不在本类。
 */
export interface ToolContext {
  /** 工作区第一参数纪律（§13.5 口子 2） */
  workspaceId: string;
  /** 调用者：'node-xxx' / 'ai:xxx' / 未来用户身份（§13.5 口子 3） */
  actor: string;
  /** 工具写业务事件的受控入口（由 workspace 的 ToolsView 注入） */
  appendEvent: (type: string, payload: unknown) => unknown;
}

export interface ToolDefinition<P = unknown> {
  /** 命名空间.动词.名词（owner 模块前缀，§6 事件/工具命名空间规则） */
  id: string;
  label: string;
  /** 给 AI 看的描述——质量决定 Tool Calling 准确性（§6 决策 1） */
  description: string;
  parameters: ParameterSchema;
  /** v1 为元数据；权限系统上线后由中间件消费（§10 预留） */
  permission: 'read' | 'write';
  handler: (params: P, ctx: ToolContext) => unknown | Promise<unknown>;
}

export interface ToolInvocation {
  toolId: string;
  params: unknown;
  result: unknown;
  actor: string;
  workspaceId: string;
}

export class ToolBus {
  #tools = new Map<string, ToolDefinition>();

  /** 注册工具（模块装载时调用；同 id 重复注册 = 覆盖，热更新支持） */
  register(tool: ToolDefinition): void {
    if (!tool.id.includes('.')) {
      throw new ToolValidationError(`工具 id 必须带命名空间: "${tool.id}"`);
    }
    this.#tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    this.#tools.delete(toolId);
  }

  listTools(): Omit<ToolDefinition, 'handler'>[] {
    return [...this.#tools.values()].map(({ handler: _handler, ...meta }) => meta);
  }

  /**
   * 调用工具：存在性 → 参数校验 → handler。
   * 注意：总线本身不做业务校验——那是 handler（工具）内部的事（§7 规则即护栏）。
   */
  async invoke(toolId: string, params: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      throw new ToolNotFoundError(`工具未注册: ${toolId}`);
    }
    validateParameters(tool.parameters, params ?? {});
    return tool.handler(params, ctx);
  }
}
