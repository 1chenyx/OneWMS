import type { ToolContext, ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';

export type WorkspaceResolver = (workspaceId: string) => WmsWorkspace;

/**
 * 工具定义包装器：handler 参数的逆变位置决定了具体参数类型无法直接赋给
 * ToolDefinition（unknown）——此处集中做一次受控窄化，工具定义处保留精确类型。
 */
export function def<P>(tool: ToolDefinition<P>): ToolDefinition {
  return { ...tool, handler: (params: unknown, ctx: ToolContext) => tool.handler(params as P, ctx) };
}
