import { OneCore } from '@one/core';
import { WmsDomain, type WmsWorkspace } from '@one/wms';
import { createWmsAgent, type LlmProvider, type WmsAgent } from '@one/ai';

/**
 * 宿主装配（AppContext）——把内核/领域/AI 组合成一个进程级单例。
 *
 * 只做组装，不认识 HTTP：任何宿主（Node 进程、未来 Tauri sidecar）都可复用。
 * AI provider 由调用方注入（进程入口读 env 构建；测试注入 mock）——
 * 未注入时 agent 为 undefined，/api/chat 返回 503，其余功能不受影响（§9.2 AI 可选）。
 */
export interface AppContext {
  readonly core: OneCore;
  readonly ws: WmsWorkspace;
  /** 工作区边界（同步组 = 同 workspaceId，M5 同步的握手校验位） */
  readonly workspaceId: string;
  readonly agent: WmsAgent | undefined;
  close(): void;
}

export function createAppContext(options: {
  dbPath: string;
  workspaceId: string;
  provider?: LlmProvider;
  model?: string;
}): AppContext {
  const core = OneCore.open(options.dbPath);
  const ws = WmsDomain.attach(core).workspace(options.workspaceId);
  const agent = options.provider
    ? createWmsAgent(ws, options.provider, { model: options.model, nodeId: core.nodeId })
    : undefined;
  return {
    core,
    ws,
    workspaceId: options.workspaceId,
    agent,
    close: () => core.close(),
  };
}
