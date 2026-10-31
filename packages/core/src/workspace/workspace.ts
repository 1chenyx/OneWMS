import type Database from 'better-sqlite3';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { FieldRegistry } from '../registry/field-registry.js';
import type { ProfileService } from '../profile/profile-service.js';
import type { ToolBus } from '../bus/tool-bus.js';
import type { ModuleRegistry } from '../modules/module-registry.js';
import { EventsView } from './events-view.js';
import { FieldsView } from './fields-view.js';
import { ProfileView } from './profile-view.js';
import { ToolsView } from './tools-view.js';
import { ModulesView } from './modules-view.js';

/**
 * 工作区门面（WorkspaceFacade）：组合五个 View 并提供 replay()。
 *
 * 同一进程可同时打开多个工作区（本地单机 + 未来云端，§13.5 红利 2）。
 * 本类只做组合与委托——能力实现全部在服务层（ARCHITECTURE.md 分层规则）。
 */
export class WorkspaceFacade {
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;
  readonly profile: ProfileView;
  readonly modules: ModulesView;

  constructor(
    readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly db: Database.Database,
    private readonly oplog: OplogStore,
    registry: FieldRegistry,
    bus: ToolBus,
    profileService: ProfileService,
    moduleRegistry: ModuleRegistry,
  ) {
    this.events = new EventsView(workspaceId, nodeId, oplog);
    this.fields = new FieldsView(workspaceId, registry);
    this.tools = new ToolsView(workspaceId, nodeId, bus, oplog);
    this.profile = new ProfileView(workspaceId, nodeId, profileService);
    this.modules = new ModulesView(workspaceId, nodeId, moduleRegistry);
    this.#registry = registry;
    this.#profileService = profileService;
  }

  #registry: FieldRegistry;
  #profileService: ProfileService;

  /**
   * 全量重放：清空注册表与 Profile 投影，按全序重放全部事件重建。
   * 「事件是唯一真相」的自检路径（§8：迁移/修复同步 = 同一动作）。
   * oplog 本身永不清空——它是真相，投影才是缓存。
   */
  replay(): { totalEvents: number; appliedRegistryEvents: number; appliedConfigEvents: number } {
    const rebuild = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM field_registry WHERE workspace_id = ?`).run(this.workspaceId);
      this.db.prepare(`DELETE FROM field_usage WHERE workspace_id = ?`).run(this.workspaceId);
      this.#profileService.clearProjection(this.workspaceId);

      let total = 0;
      let appliedRegistry = 0;
      let appliedConfig = 0;
      this.oplog.forEachEvent(this.workspaceId, (env) => {
        total++;
        this.#registry.applyEvent(env);
        this.#profileService.applyEvent(env);
        if (env.type.startsWith('registry.')) appliedRegistry++;
        if (env.type === 'config.change') appliedConfig++;
      });
      return { totalEvents: total, appliedRegistryEvents: appliedRegistry, appliedConfigEvents: appliedConfig };
    });
    return rebuild();
  }
}
