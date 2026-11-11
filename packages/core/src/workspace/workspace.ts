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
import { ensureProjectionVersion } from '../projection/projection-version.js';

/**
 * 内核投影组的版本号（field_registry / field_usage / profile_state）。
 *
 * **改了下面任何一处的派生语义就把它 +1**：字段归属规则（owner/usedBy 怎么算）、
 * 可见性/共享的默认值、config.change 合并成 profile 的口径、registry 事件的应用顺序。
 * 只加表、只加列、只改查询性能 → 不用动。启动时会自动整组重建（见 projection-version.ts）。
 */
export const CORE_PROJECTION_VERSION = 1;

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
    // dyn 安装器闭包：ProfileView 不能持有 ModuleRegistry（依赖方向），由 facade 递函数进去
    this.profile = new ProfileView(workspaceId, nodeId, profileService, (manifest, actor) =>
      moduleRegistry.install(workspaceId, manifest, { actor }),
    );
    this.modules = new ModulesView(workspaceId, nodeId, moduleRegistry);
    this.#registry = registry;
    this.#profileService = profileService;
    // 内核投影没有「构造期追账」这条路（registry/profile 是写入时即时应用的），
    // 所以版本落后时必须显式 replay()——清空 + 按全序重放，重建完再打戳。
    ensureProjectionVersion(db, {
      group: 'core',
      workspaceId,
      codeVersion: CORE_PROJECTION_VERSION,
      rebuild: () => this.replay(),
    });
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
      this.#registry.clearProjection(this.workspaceId);
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
