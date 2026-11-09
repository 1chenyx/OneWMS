import type Database from 'better-sqlite3';
import {
  ensureProjectionVersion,
  OneCore,
  type EventsView,
  type FieldsView,
  type ModuleManifest,
  type ModulesView,
  type ProfileView,
  type ToolDefinition,
  type ToolsView,
  type WorkspaceFacade,
} from '@one/core';
import { migrateMemory } from './db/migrations.js';
import { MemorySectionView, MEMORY_PROJECTION_VERSION } from './views/memory-view.js';
import { createMemoryTools } from './tools/memory-tools.js';
import { isMemoryEventType } from './events/catalog.js';
import { MEMORY_MODULE_ID } from './config/memory-settings.js';

/**
 * MemoryDomain —— 记忆领域装配器（照 WmsDomain 模式）：把 AI 记忆域「挂载」到内核实例上。
 *
 * 装配动作（attach 一次完成）：
 *  1. 建领域表（memory_ 前缀，与内核表同居一库）；
 *  2. 向工具总线注册 memory.* 工具（进程级一次，全工作区共享）；
 *  3. 从工具定义派生 core.memory manifest 并注册进进程目录（声明面与事实面零重复）。
 * 领域包只经 @one/core 的公共 API + 领域装配口（exposeDb/exposeToolBus/exposeModuleRegistry）触碰内核。
 */
export class MemoryDomain {
  readonly #core: OneCore;
  readonly #db: Database.Database;
  readonly #manifest: ModuleManifest;
  readonly #cache = new Map<string, MemoryWorkspace>();

  private constructor(core: OneCore) {
    this.#core = core;
    this.#db = core.exposeDb();
    migrateMemory(this.#db);
    const bus = core.exposeToolBus();
    const toolDefs = createMemoryTools((id) => this.workspace(id));
    for (const tool of toolDefs) bus.register(tool);
    this.#manifest = memoryManifest(toolDefs);
    core.exposeModuleRegistry().registerManifest(this.#manifest);
  }

  /** 把领域挂到内核上（幂等心智：attach 两次 = 工具覆盖注册 + 表 IF NOT EXISTS + 目录覆盖登记） */
  static attach(core: OneCore): MemoryDomain {
    return new MemoryDomain(core);
  }

  /** 获取（或创建）工作区绑定门面——同 workspaceId 恒返回同一实例（游标一致） */
  workspace(workspaceId: string): MemoryWorkspace {
    let ws = this.#cache.get(workspaceId);
    if (!ws) {
      ws = new MemoryWorkspace(workspaceId, this.#core, this.#db, this.#manifest);
      this.#cache.set(workspaceId, ws);
    }
    return ws;
  }
}

/** 工具定义 → manifest 声明（剥离 handler；剩余即 id/label/description/parameters/permission） */
function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * MemoryWorkspace —— 记忆领域工作区门面：内核五视图 + 章节投影 + 追账器。
 *
 * 追账模型（与 WmsWorkspace 同一条纪律）：#cursor 是内存游标（已应用的
 * lamport 高水位）；sync() 增量应用游标之后的 memory.* 事件；replay() 清空
 * 投影、游标复位、全量重放——同步、迁移、修复共用同一条 applyEvent 路径。
 * 构造期即全量追账一次 + manifest 安装种子：新进程打开旧库（投影落后，
 * 含 v1 条目事件 → legacy 章节）、全新工作区都正确。
 */
export class MemoryWorkspace {
  /** 内核五视图（与 WorkspaceFacade 同源，直接展开在门面上） */
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;
  readonly profile: ProfileView;
  readonly modules: ModulesView;

  /** 记忆章节投影（查询 + T0 渲染 + T2 预取匹配都在它身上） */
  readonly sections: MemorySectionView;

  readonly #facade: WorkspaceFacade;
  readonly #db: Database.Database;
  readonly #nodeId: string;
  #cursor = -1;

  constructor(workspaceId: string, core: OneCore, db: Database.Database, manifest: ModuleManifest) {
    this.#facade = core.workspace(workspaceId);
    this.#db = db;
    this.#nodeId = core.nodeId;
    this.events = this.#facade.events;
    this.fields = this.#facade.fields;
    this.tools = this.#facade.tools;
    this.profile = this.#facade.profile;
    this.modules = this.#facade.modules;
    this.sections = new MemorySectionView(db, workspaceId);
    // 投影版本戳（层 1）：代码里的派生规则比库里记的新 → 整组重建章节投影。
    // 放在 sync() 之前：replay() 自带清空 + 游标复位 + 全量重放，随后 sync() 空转。
    ensureProjectionVersion(db, {
      group: 'memory',
      workspaceId,
      codeVersion: MEMORY_PROJECTION_VERSION,
      rebuild: () => this.replay(),
    });
    this.sync();
    this.#installModule(manifest);
  }

  /**
   * 模块安装种子（与 WmsWorkspace.#installBaseModule 同模式）：install 幂等
   * （同版本零事件）；种子 actor 带 @nodeId 后缀（多节点同步不撞唯一约束）。
   */
  #installModule(manifest: ModuleManifest): void {
    this.modules.install(manifest, { actor: `module:${manifest.id}@${this.#nodeId}` });
  }

  /**
   * 增量追账：把游标之后本工作区的 memory.* 事件应用到章节投影。
   * 单事务；applyEvent 抛错则整体回滚、游标不动——确定性失败。
   */
  sync(): { appliedEvents: number } {
    const run = this.#db.transaction(() => {
      const { appliedMemoryEvents } = this.#consumeEvents();
      return { appliedEvents: appliedMemoryEvents };
    });
    return run();
  }

  /** 游标之后的事件消费路径：增量追账与清库后的全量重放共用。 */
  #consumeEvents(): { totalEvents: number; appliedMemoryEvents: number } {
    let totalEvents = 0;
    let appliedMemoryEvents = 0;
    this.events.forEach((env) => {
      totalEvents++;
      if (isMemoryEventType(env.type)) {
        this.sections.applyEvent(env);
        appliedMemoryEvents++;
      }
      this.#cursor = env.lamport;
    }, { fromLamport: this.#cursor });
    return { totalEvents, appliedMemoryEvents };
  }

  /**
   * 全量重放重建章节投影（不含内核投影——那是 core.replay() 的职责）。
   * 幂等；「事件账本 ↔ 记忆投影」强一致的自检路径。
   */
  replay(): { totalEvents: number; appliedMemoryEvents: number } {
    const run = this.#db.transaction(() => {
      this.sections.clear();
      this.#cursor = -1;
      return this.#consumeEvents();
    });
    return run();
  }
}

/**
 * core.memory 模块 manifest：tools 从工具定义派生（声明与事实零重复维护）；
 * settings 两键（autoMemory / maxSections）——新库由 install 从 default
 * 种子，老库读取方兜底缺省（readMemorySettings），改值走 profile 慢通道。
 *
 * 版本 0.2.0：形态从「条目」改为「章节 markdown 账本」（工具 read/append/rewrite）。
 */
export function memoryManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: MEMORY_MODULE_ID,
    name: 'AI 记忆',
    description:
      'AI 聊天记忆：以 markdown 章节记录用户偏好（personal）与仓库业务约定（project）。' +
      '对话时常驻注入「用户画像全文 + 业务章节目录」，细节按需读取、关键词命中自动预取；' +
      '支持对话后自动追加与人工/对话中显式改写，记忆随事件账本多节点同步。',
    version: '0.2.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    tools: toolDefs.map((tool) => detachHandler(tool)),
    settings: {
      schema: {
        type: 'object',
        properties: {
          autoMemory: {
            type: 'boolean',
            description: '对话结束后自动提取记忆（后台静默执行，失败不影响聊天）',
            default: true,
          },
          maxSections: {
            type: 'integer',
            minimum: 1,
            description: '记忆章节总数上限：达到后拒绝新建章节，需先归并或删除',
            default: 24,
          },
        },
      },
    },
  };
}
