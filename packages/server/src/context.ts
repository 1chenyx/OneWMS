import { OneCore } from '@one/core';
import { WmsDomain, type WmsWorkspace } from '@one/wms';
import { MemoryDomain, type MemoryWorkspace } from '@one/memory';
import {
  AI_MODULE_ID,
  aiModuleManifest,
  createVercelLlmProvider,
  resolveLanguageModel,
  type AiProviderConfig,
  type LlmProvider,
} from '@one/ai';
import { DEFAULT_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_KEEP } from './backup/backup-service.js';
import {
  deleteAiConfigFile,
  EMPTY_AI_CATALOG,
  writeAiCatalog,
  type AiConfigCatalog,
} from './ai-config-store.js';
import { createPeerStore, type PeerStore } from './sync/peer-store.js';

/**
 * 宿主装配（AppContext）——把内核/领域/AI 组合成一个进程级单例。
 *
 * 只做组装，不认识 HTTP：任何宿主（Node 进程、未来 Tauri sidecar）都可复用。
 * AI provider 由调用方注入（进程入口读 env / 配置文件构建；测试注入 mock）——
 * 未注入时 /api/chat 返回 503，其余功能不受影响（§9.2 AI 可选）。
 *
 * M16：不再启动时固化单个 agent——chat 路由按消息读 AgentDefinition 现场
 * 装配（readAgentDefs + createAgentFromDef），助手定义改动经慢通道确认后
 * 下一轮对话即生效。此处保留 provider（进程级模型通道）与 aiConfig
 * （per-agent 模型覆盖时现场重建轻量 provider 的原料）。
 *
 * M17（AI 模型配置页）：provider/aiConfig 不再启动即固化——applyAiConfig
 * 保存后现场重建（无需重启进程），chat 路由每条消息读的都是当前值。
 *
 * 记忆域（MemoryDomain.attach）：core.memory 模块登记 + memory.* 工具注册
 * + memory_item 投影，全在领域装配器内完成（与 WmsDomain 同模式）；
 * ctx.memory 供 chat 提取钩子与管理端点消费。
 */

/** 当前生效 AI 配置的来源（状态卡的「真相面」） */
export type AiConfigSource = 'file' | 'env' | 'none';

export interface AppContext {
  readonly core: OneCore;
  readonly ws: WmsWorkspace;
  /** 记忆域工作区门面（AI 聊天记忆的投影与设置读取面） */
  readonly memory: MemoryWorkspace;
  /** 工作区边界（同步组 = 同 workspaceId，M5 同步的握手校验位） */
  readonly workspaceId: string;
  /** 进程级 LLM 通道（未配置 AI 时 undefined——/api/chat 503；页面保存后热替换） */
  provider: LlmProvider | undefined;
  /** 进程级 AI 配置（模型覆盖的重建原料；与 provider 同生同灭） */
  aiConfig: AiProviderConfig | undefined;
  /** 生效配置来源：file = 配置页保存（优先）/ env = 启动环境变量 / none = 未配置 */
  aiConfigSource: AiConfigSource;
  /** 配置文件持久化位（null = 宿主无落盘位，如 :memory:——页面保存仅进程内生效） */
  readonly aiConfigPath: string | null;
  /** 启动时的 env 配置（配置页「关闭 AI」删除文件后的回落面） */
  readonly aiConfigEnv: AiProviderConfig | undefined;
  /** 页面保存的多模型目录（空目录 = 没有页面配置；生效的那条在 aiConfig） */
  aiCatalog: AiConfigCatalog;
  /** 自动备份目录（null = 宿主无落盘位，备份整体禁用） */
  readonly backupDir: string | null;
  /** 自动备份间隔（毫秒；0 = 只手动备份，不起定时器） */
  readonly backupIntervalMs: number;
  /** 备份滚动保留份数 */
  readonly backupKeep: number;
  /** 已配对同步节点清单（扫码组网；path=null 时只在进程内有效） */
  readonly peers: PeerStore;
  /** 实际监听端口（serve 回调写入；null = 未起端口的宿主，如测试 app.request） */
  listeningPort: number | null;
  /** 热更新：重建 provider + 切换来源（config=undefined 即关闭 AI） */
  applyAiConfig(config: AiProviderConfig | undefined, source: AiConfigSource): void;
  /**
   * 换整份模型目录并热切到 activeId。
   * 目录空则删文件，回落到启动时的 env 配置。
   */
  commitCatalog(catalog: AiConfigCatalog): void;
  close(): void;
}

export function createAppContext(options: {
  dbPath: string;
  workspaceId: string;
  provider?: LlmProvider;
  aiConfig?: AiProviderConfig;
  /** 缺省 null（测试宿主不落盘）；真实宿主传 resolveAiConfigPath(dbPath) */
  aiConfigPath?: string | null;
  /** 缺省按 aiConfig 推断（给了配置即视为 env 来源——与 M16 前语义兼容） */
  aiConfigSource?: AiConfigSource;
  /** 缺省 = aiConfig（启动注入即 env 面） */
  aiConfigEnv?: AiProviderConfig;
  /** 缺省空目录。真实启动传入从配置文件读出的目录 */
  aiCatalog?: AiConfigCatalog;
  /** 缺省 null（测试宿主不落盘）；真实宿主传 resolveBackupDir(dbPath) */
  backupDir?: string | null;
  /** 缺省一天一次；0 = 关闭定时备份 */
  backupIntervalMs?: number;
  /** 缺省保留 7 份 */
  backupKeep?: number;
  /** 缺省纯内存清单（测试宿主不落盘）；真实宿主传 resolvePeersPath(dbPath) */
  peersPath?: string | null;
}): AppContext {
  const core = OneCore.open(options.dbPath);
  const ws = WmsDomain.attach(core).workspace(options.workspaceId);
  // 记忆域装配（manifest 登记 + 工具注册 + 模块种子安装都在域内完成）
  const memory = MemoryDomain.attach(core).workspace(options.workspaceId);
  // core.ai 模块登记（M16）：registerManifest = 进程级「代码在场」目录
  // （迁移/同步的 manifest 在场性对照面，与 WmsDomain.attach 注册 core.wms 同模式）；
  // install = 落 module.installed 事件 + modules 段登记（幂等——同版本零事件）。
  // 种子 default:[] 使 settings.agents 键在场——慢通道的 replace 路径永远可用。
  const aiManifest = aiModuleManifest();
  core.exposeModuleRegistry().registerManifest(aiManifest);
  ws.modules.install(aiManifest, { actor: `module:${AI_MODULE_ID}@${core.nodeId}` });
  const ctx: AppContext = {
    core,
    ws,
    memory,
    workspaceId: options.workspaceId,
    provider: options.provider,
    aiConfig: options.aiConfig,
    aiConfigSource: options.aiConfigSource ?? (options.aiConfig ? 'env' : 'none'),
    aiConfigPath: options.aiConfigPath ?? null,
    aiConfigEnv: options.aiConfigEnv ?? options.aiConfig,
    aiCatalog: options.aiCatalog ?? { ...EMPTY_AI_CATALOG, profiles: [] },
    backupDir: options.backupDir ?? null,
    backupIntervalMs: options.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS,
    backupKeep: options.backupKeep ?? DEFAULT_BACKUP_KEEP,
    peers: createPeerStore(options.peersPath ?? null),
    listeningPort: null,
    applyAiConfig(config, source) {
      ctx.provider = config ? createVercelLlmProvider(resolveLanguageModel(config)) : undefined;
      ctx.aiConfig = config;
      ctx.aiConfigSource = source;
    },
    commitCatalog(catalog) {
      ctx.aiCatalog = catalog;
      if (ctx.aiConfigPath !== null) {
        if (catalog.profiles.length === 0) deleteAiConfigFile(ctx.aiConfigPath);
        else writeAiCatalog(ctx.aiConfigPath, catalog);
      }
      const active = catalog.profiles.find((item) => item.id === catalog.activeId) ?? catalog.profiles[0];
      if (active) {
        ctx.applyAiConfig(
          { kind: active.kind, model: active.model, baseUrl: active.baseUrl, apiKey: active.apiKey },
          'file',
        );
      } else {
        const fallback = ctx.aiConfigEnv;
        ctx.applyAiConfig(fallback, fallback ? 'env' : 'none');
      }
    },
    close: () => core.close(),
  };
  return ctx;
}
