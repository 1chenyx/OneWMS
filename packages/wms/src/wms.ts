import type Database from 'better-sqlite3';
import {
  OneCore,
  type EventsView,
  type FieldsView,
  type ModuleManifest,
  type ModulesView,
  type ProfileView,
  type ToolDefinition,
  type ToolsView,
  type WorkflowDef,
  type WorkspaceFacade,
} from '@one/core';
import { migrateWms } from './db/migrations.js';
import { SkuView } from './views/sku-view.js';
import { OrderView } from './views/order-view.js';
import { InventoryView } from './views/inventory-view.js';
import { createWmsTools } from './tools/wms-tools.js';
import { isWmsEventType } from './events/catalog.js';
import { ORDER_TRANSITIONS } from './state/order-state-machine.js';

/**
 * WmsDomain —— 领域装配器：把仓储领域「挂载」到一个内核实例上。
 *
 * 装配动作（attach 一次完成）：
 *  1. 建领域表（wms_* 前缀，与内核表同居一库）；
 *  2. 向工具总线注册 wms.* 工具（进程级一次，全工作区共享）；
 *  3. 从工具定义派生 core.wms manifest 并注册进进程目录（M6：声明面与事实面零重复）。
 * 领域包只经 @one/core 的公共 API + 领域装配口（exposeDb/exposeToolBus/exposeModuleRegistry）触碰内核。
 */
export class WmsDomain {
  readonly #core: OneCore;
  readonly #db: Database.Database;
  readonly #manifest: ModuleManifest;
  readonly #cache = new Map<string, WmsWorkspace>();

  private constructor(core: OneCore) {
    this.#core = core;
    this.#db = core.exposeDb();
    migrateWms(this.#db);
    const bus = core.exposeToolBus();
    const toolDefs = createWmsTools((id) => this.workspace(id));
    for (const tool of toolDefs) bus.register(tool);
    this.#manifest = wmsManifest(toolDefs.map((t) => detachHandler(t)));
    core.exposeModuleRegistry().registerManifest(this.#manifest);
  }

  /** 把领域挂到内核上（幂等心智：attach 两次 = 工具覆盖注册 + 表 IF NOT EXISTS + 目录覆盖登记） */
  static attach(core: OneCore): WmsDomain {
    return new WmsDomain(core);
  }

  /** 获取（或创建）工作区绑定门面——同 workspaceId 恒返回同一实例（游标一致） */
  workspace(workspaceId: string): WmsWorkspace {
    let ws = this.#cache.get(workspaceId);
    if (!ws) {
      ws = new WmsWorkspace(workspaceId, this.#core, this.#db, this.#manifest);
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
 * WmsWorkspace —— 领域工作区门面：内核五视图 + 领域三投影 + 追账器。
 *
 * 追账模型（「事件是唯一真相，投影是缓存」的直接实现）：
 *  - #cursor 是内存游标（已应用的 lamport 高水位）；
 *  - sync() 增量应用游标之后的 wms.* 事件到三个投影（工具 handler 前后调用）；
 *  - replay() 清空领域投影、游标复位、全量重放——与 sync() 同一条 applyEvent 路径，
 *    迁移/修复/自检是同一个动作（§8.5「全量为真，增量为快」）。
 * 构造期即全量追账一次 + manifest 安装种子：新进程打开旧库（投影落后）、
 * 全新工作区、M4 老库（升级收敛）三条路径都正确。
 */
export class WmsWorkspace {
  /** 内核五视图（与 WorkspaceFacade 同源，直接展开在门面上） */
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;
  readonly profile: ProfileView;
  readonly modules: ModulesView;

  /** 领域三投影 */
  readonly skus: SkuView;
  readonly orders: OrderView;
  readonly inventory: InventoryView;

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
    this.skus = new SkuView(db, workspaceId);
    this.orders = new OrderView(db, workspaceId);
    this.inventory = new InventoryView(db, workspaceId);
    this.sync();
    this.#installBaseModule(manifest);
  }

  /**
   * 模块化种子（M6，替代 M4 手写 #seedDefaultProfile）：manifest 驱动的受管安装。
   *  - 新库：字段 provide（owner='core.wms'）+ base 流程（从转移表誊写）+ modules 段登记；
   *  - 老库（M4 手写种子过的库）：字段 DO NOTHING + usedBy 追加（owner 保持 'core'，
   *    归属语义自洽）、base 守卫跳过、仅登记 modules 段——一次性收敛；
   *  - 已装库（重开文件库）：install 幂等短路（同版本已装，零新事件）。
   * core 不认识仓储词汇，manifest 内容必须由领域声明（领域隔离铁律）。
   * 种子事件的 actor 带 @nodeId 后缀：每个节点各自落自己的种子（eventId 不同），
   * 同步交换时 (actor, seq) 不撞账本唯一约束（M5 同步决策 5）。
   */
  #installBaseModule(manifest: ModuleManifest): void {
    this.modules.install(manifest, { actor: `module:${manifest.id}@${this.#nodeId}` });
  }

  /**
   * 增量追账：把游标之后本工作区的 wms.* 事件应用到领域投影。
   * 单事务；applyEvent 抛错（状态冲突）则整体回滚、游标不动——确定性失败。
   */
  sync(): { appliedEvents: number } {
    const run = this.#db.transaction(() => {
      let applied = 0;
      this.events.forEach((env) => {
        if (isWmsEventType(env.type)) {
          this.skus.applyEvent(env);
          this.orders.applyEvent(env);
          this.inventory.applyEvent(env);
          applied++;
        }
        this.#cursor = env.lamport;
      }, { fromLamport: this.#cursor });
      return { appliedEvents: applied };
    });
    return run();
  }

  /**
   * 全量重放重建领域投影（不含内核投影——那是 core.replay() 的职责）。
   * 幂等；「事件账本 ↔ 领域投影」强一致的自检路径。
   */
  replay(): { totalEvents: number; appliedWmsEvents: number } {
    const run = this.#db.transaction(() => {
      const wsId = this.#facade.workspaceId;
      this.#db.prepare(`DELETE FROM wms_sku WHERE workspace_id = ?`).run(wsId);
      this.#db.prepare(`DELETE FROM wms_order WHERE workspace_id = ?`).run(wsId);
      this.#db.prepare(`DELETE FROM wms_order_line WHERE workspace_id = ?`).run(wsId);
      this.#db.prepare(`DELETE FROM wms_inventory_ledger WHERE workspace_id = ?`).run(wsId);
      this.#db.prepare(`DELETE FROM wms_inventory WHERE workspace_id = ?`).run(wsId);
      this.#cursor = -1;

      let total = 0;
      let applied = 0;
      this.events.forEach((env) => {
        total++;
        if (isWmsEventType(env.type)) {
          this.skus.applyEvent(env);
          this.orders.applyEvent(env);
          this.inventory.applyEvent(env);
          applied++;
        }
        this.#cursor = env.lamport;
      });
      return { totalEvents: total, appliedWmsEvents: applied };
    });
    return run();
  }

  /**
   * 全量重放「内核 + 领域」两层投影（M5 同步回合后的重建入口）。
   * 先内核（注册表 / Profile）后领域（SKU / 单据 / 库存）——各自独立事务，顺序固定。
   * 摄入远端事件后调用一次：账本增量交换、投影全量重建的最保守实现。
   */
  replayAll(): { core: ReturnType<WorkspaceFacade['replay']>; wms: ReturnType<WmsWorkspace['replay']> } {
    return { core: this.#facade.replay(), wms: this.replay() };
  }
}

/** 状态中文标签（Profile 流程的展示名） */
const STATE_LABELS: Record<string, string> = {
  created: '已创建',
  received: '已收货',
  picking: '拣货中',
  shipped: '已发货',
  done: '已完成',
  canceled: '已取消',
};

/**
 * 默认流程骨架：从 ORDER_TRANSITIONS（种子誊写源）誊写——M8 行为闭环后，
 * 转移校验读 Profile workflows，种子与校验同源保证新库默认行为不变；
 * 装库后改配置（慢通道 / 模块 contributes）即改行为。
 */
function defaultWorkflows(): Record<string, WorkflowDef> {
  const build = (direction: 'in' | 'out'): WorkflowDef => {
    const stateIds = ['created', ...ORDER_TRANSITIONS[direction].map((t) => t.to)].filter(
      (id, i, arr) => arr.indexOf(id) === i,
    );
    // states[0] 为初始态（约定）：created 恒在首位
    const ordered = ['created', ...stateIds.filter((id) => id !== 'created')];
    return {
      states: ordered.map((id) => ({ id, label: STATE_LABELS[id] ?? id })),
      transitions: ORDER_TRANSITIONS[direction].map((t) => ({ from: t.from, to: t.to })),
    };
  };
  return { inbound: build('in'), outbound: build('out') };
}

/**
 * core.wms 基础模块 manifest（M6 模块化种子的声明面）。
 *
 *  - tools 从工具定义派生（detachHandler 剥离 handler）：声明与事实零重复维护；
 *  - workflows.base 消费 defaultWorkflows()（与 M2 硬编码转移表一致，逐流程守卫）；
 *  - fields.provides 三个 shared 扩展字段（规格/分类/单位）——M4 手写种子的 manifest 化；
 *  - settings 暂无（空 schema 占位，表单渲染/AI 上下文的自然扩展点）。
 */
function wmsManifest(tools: Omit<ToolDefinition, 'handler'>[]): ModuleManifest {
  return {
    id: 'core.wms',
    name: '仓储基础',
    description:
      '仓储管理核心领域：SKU 档案、出入库单据、库存流水与汇总。提供基础扩展字段（规格/分类/单位）与出入库流程骨架。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    fields: {
      provides: [
        { entity: 'sku', key: 'spec', label: '规格', type: 'string' },
        { entity: 'sku', key: 'category', label: '分类', type: 'string' },
        { entity: 'sku', key: 'unit', label: '单位', type: 'string' },
      ],
    },
    tools,
    workflows: { base: defaultWorkflows() },
    settings: { schema: { type: 'object', properties: {} } },
  };
}
