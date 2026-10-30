import type { OplogStore } from '../oplog/oplog-store.js';
import type { ToolBus, ToolContext, ToolDefinition } from '../bus/tool-bus.js';

/**
 * 工具总线的工作区绑定视图（ToolsView）。
 *
 * 除参数绑定外，唯一多做的事：构造 ToolContext 注入 appendEvent——
 * 工具写业务事件的**受控入口**（工具只能经此落账，拿不到数据库句柄）。
 */
export class ToolsView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly bus: ToolBus,
    private readonly oplog: OplogStore,
  ) {}

  /** 注册工具（注册表全工作区共享——工具是代码） */
  register(tool: ToolDefinition): void {
    this.bus.register(tool);
  }

  unregister(toolId: string): void {
    this.bus.unregister(toolId);
  }

  /** 元数据列表（handler 不可见，AI 上下文安全） */
  list(): Omit<ToolDefinition, 'handler'>[] {
    return this.bus.listTools();
  }

  /** 调用工具；actor 默认本节点，AI 调用时传 'ai:xxx'（审计可追溯） */
  async invoke(toolId: string, params: unknown, actor = this.nodeId): Promise<unknown> {
    const ctx: ToolContext = {
      workspaceId: this.workspaceId,
      actor,
      appendEvent: (type: string, payload: unknown) =>
        this.oplog.append({ workspaceId: this.workspaceId, actor, type, payload }),
    };
    return this.bus.invoke(toolId, params, ctx);
  }
}
