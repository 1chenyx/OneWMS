import { OneCore } from '@one/core';
import { WmsDomain, type WmsWorkspace } from '@one/wms';
import {
  AI_MODULE_ID,
  aiModuleManifest,
  type AiProviderConfig,
  type LlmProvider,
} from '@one/ai';

/**
 * 宿主装配（AppContext）——把内核/领域/AI 组合成一个进程级单例。
 *
 * 只做组装，不认识 HTTP：任何宿主（Node 进程、未来 Tauri sidecar）都可复用。
 * AI provider 由调用方注入（进程入口读 env 构建；测试注入 mock）——
 * 未注入时 /api/chat 返回 503，其余功能不受影响（§9.2 AI 可选）。
 *
 * M16：不再启动时固化单个 agent——chat 路由按消息读 AgentDefinition 现场
 * 装配（readAgentDefs + createAgentFromDef），助手定义改动经慢通道确认后
 * 下一轮对话即生效。此处保留 provider（进程级模型通道）与 aiConfig
 * （per-agent 模型覆盖时现场重建轻量 provider 的原料）。
 */
export interface AppContext {
  readonly core: OneCore;
  readonly ws: WmsWorkspace;
  /** 工作区边界（同步组 = 同 workspaceId，M5 同步的握手校验位） */
  readonly workspaceId: string;
  /** 进程级 LLM 通道（未配置 AI 时 undefined——/api/chat 503） */
  readonly provider: LlmProvider | undefined;
  /** 进程级 AI 配置（模型覆盖的重建原料；与 provider 同生同灭） */
  readonly aiConfig: AiProviderConfig | undefined;
  close(): void;
}

export function createAppContext(options: {
  dbPath: string;
  workspaceId: string;
  provider?: LlmProvider;
  aiConfig?: AiProviderConfig;
}): AppContext {
  const core = OneCore.open(options.dbPath);
  const ws = WmsDomain.attach(core).workspace(options.workspaceId);
  // core.ai 模块登记（M16）：registerManifest = 进程级「代码在场」目录
  // （迁移/同步的 manifest 在场性对照面，与 WmsDomain.attach 注册 core.wms 同模式）；
  // install = 落 module.installed 事件 + modules 段登记（幂等——同版本零事件）。
  // 种子 default:[] 使 settings.agents 键在场——慢通道的 replace 路径永远可用。
  const aiManifest = aiModuleManifest();
  core.exposeModuleRegistry().registerManifest(aiManifest);
  ws.modules.install(aiManifest, { actor: `module:${AI_MODULE_ID}@${core.nodeId}` });
  return {
    core,
    ws,
    workspaceId: options.workspaceId,
    provider: options.provider,
    aiConfig: options.aiConfig,
    close: () => core.close(),
  };
}
