import type Database from 'better-sqlite3';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { FieldRegistry } from '../registry/field-registry.js';
import type { ToolBus } from '../bus/tool-bus.js';
import { EventsView } from './events-view.js';
import { FieldsView } from './fields-view.js';
import { ToolsView } from './tools-view.js';

/**
 * 工作区门面（WorkspaceFacade）：组合三个 View 并提供 replay()。
 *
 * 同一进程可同时打开多个工作区（本地单机 + 未来云端，§13.5 红利 2）。
 * 本类只做组合与委托——能力实现全部在服务层（ARCHITECTURE.md 分层规则）。
 */
export class WorkspaceFacade {
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;

  constructor(
    readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly db: Database.Database,
    private readonly oplog: OplogStore,
    registry: FieldRegistry,
    bus: ToolBus,
  ) {
    this.events = new EventsView(workspaceId, nodeId, oplog);
    this.fields = new FieldsView(workspaceId, registry);
    this.tools = new ToolsView(workspaceId, nodeId, bus, oplog);
    this.#registry = registry;
  }

  #registry: FieldRegistry;

  /**
   * 全量重放：清空注册表投影，按全序重放全部事件重建。
   * 「事件是唯一真相」的自检路径（§8：迁移/修复同步 = 同一动作）。
   * oplog 本身永不清空——它是真相，投影才是缓存。
   */
  replay(): { totalEvents: number; appliedRegistryEvents: number } {
    const rebuild = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM field_registry WHERE workspace_id = ?`).run(this.workspaceId);
      this.db.prepare(`DELETE FROM field_usage WHERE workspace_id = ?`).run(this.workspaceId);

      let total = 0;
      let applied = 0;
      this.oplog.forEachEvent(this.workspaceId, (env) => {
        total++;
        this.#registry.applyEvent(env);
        if (env.type.startsWith('registry.')) applied++;
      });
      return { totalEvents: total, appliedRegistryEvents: applied };
    });
    return rebuild();
  }
}
