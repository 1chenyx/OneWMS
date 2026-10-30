import type Database from 'better-sqlite3';
import { OneCore, type EventsView, type FieldsView, type ToolsView, type WorkspaceFacade } from '@one/core';
import { migrateWms } from './db/migrations.js';
import { SkuView } from './views/sku-view.js';
import { OrderView } from './views/order-view.js';
import { InventoryView } from './views/inventory-view.js';
import { createWmsTools } from './tools/wms-tools.js';
import { isWmsEventType } from './events/catalog.js';

/**
 * WmsDomain —— 领域装配器：把仓储领域「挂载」到一个内核实例上。
 *
 * 装配动作（attach 一次完成）：
 *  1. 建领域表（wms_* 前缀，与内核表同居一库）；
 *  2. 向工具总线注册 wms.* 工具（进程级一次，全工作区共享）。
 * 领域包只经 @one/core 的公共 API + 领域装配口（exposeDb/exposeToolBus）触碰内核。
 */
export class WmsDomain {
  readonly #core: OneCore;
  readonly #db: Database.Database;
  readonly #cache = new Map<string, WmsWorkspace>();

  private constructor(core: OneCore) {
    this.#core = core;
    this.#db = core.exposeDb();
    migrateWms(this.#db);
    const bus = core.exposeToolBus();
    for (const tool of createWmsTools((id) => this.workspace(id))) {
      bus.register(tool);
    }
  }

  /** 把领域挂到内核上（幂等心智：attach 两次 = 工具覆盖注册 + 表 IF NOT EXISTS） */
  static attach(core: OneCore): WmsDomain {
    return new WmsDomain(core);
  }

  /** 获取（或创建）工作区绑定门面——同 workspaceId 恒返回同一实例（游标一致） */
  workspace(workspaceId: string): WmsWorkspace {
    let ws = this.#cache.get(workspaceId);
    if (!ws) {
      ws = new WmsWorkspace(workspaceId, this.#core, this.#db);
      this.#cache.set(workspaceId, ws);
    }
    return ws;
  }
}

/**
 * WmsWorkspace —— 领域工作区门面：内核三视图 + 领域三投影 + 追账器。
 *
 * 追账模型（「事件是唯一真相，投影是缓存」的直接实现）：
 *  - #cursor 是内存游标（已应用的 lamport 高水位）；
 *  - sync() 增量应用游标之后的 wms.* 事件到三个投影（工具 handler 前后调用）；
 *  - replay() 清空领域投影、游标复位、全量重放——与 sync() 同一条 applyEvent 路径，
 *    迁移/修复/自检是同一个动作（§8.5「全量为真，增量为快」）。
 * 构造期即全量追账一次：新进程打开旧库（投影落后）与全新工作区都正确。
 */
export class WmsWorkspace {
  /** 内核三视图（与 WorkspaceFacade 同源，直接展开在门面上） */
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;

  /** 领域三投影 */
  readonly skus: SkuView;
  readonly orders: OrderView;
  readonly inventory: InventoryView;

  readonly #facade: WorkspaceFacade;
  readonly #db: Database.Database;
  #cursor = -1;

  constructor(workspaceId: string, core: OneCore, db: Database.Database) {
    this.#facade = core.workspace(workspaceId);
    this.#db = db;
    this.events = this.#facade.events;
    this.fields = this.#facade.fields;
    this.tools = this.#facade.tools;
    this.skus = new SkuView(db, workspaceId);
    this.orders = new OrderView(db, workspaceId);
    this.inventory = new InventoryView(db, workspaceId);
    this.sync();
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
   * 全量重放重建领域投影（不含内核注册表——那是 core.replay() 的职责）。
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
}
