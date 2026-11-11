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
import { DynView } from './dyn-view.js';
import type { DynStore } from '../dyn/dyn-store.js';
import { hasDynRecords } from '../dyn/dyn-store.js';
import { syncDynTools } from '../dyn/dyn-tools.js';
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
 * 工作区门面（WorkspaceFacade）：组合六个 View 并提供 replay()。
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
  /** 动态记录读写面（B.2）：B.3 端点 / B.4 工具从这里进 */
  readonly dyn: DynView;

  constructor(
    readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly db: Database.Database,
    private readonly oplog: OplogStore,
    registry: FieldRegistry,
    bus: ToolBus,
    profileService: ProfileService,
    moduleRegistry: ModuleRegistry,
    dynStore: DynStore,
  ) {
    this.events = new EventsView(workspaceId, nodeId, oplog);
    this.fields = new FieldsView(workspaceId, registry);
    this.tools = new ToolsView(workspaceId, nodeId, bus, oplog, db);
    // dyn 安装器闭包：ProfileView 不能持有 ModuleRegistry（依赖方向），由 facade 递函数进去
    this.profile = new ProfileView(workspaceId, nodeId, profileService, (manifest, actor) =>
      moduleRegistry.install(workspaceId, manifest, { actor }),
    );
    this.modules = new ModulesView(workspaceId, nodeId, moduleRegistry);
    this.dyn = new DynView(workspaceId, nodeId, dynStore);
    this.#registry = registry;
    this.#profileService = profileService;
    this.#dyn = dynStore;
    // 内核投影没有「构造期追账」这条路（registry/profile 是写入时即时应用的），
    // 所以版本落后时必须显式 replay()——清空 + 按全序重放，重建完再打戳。
    ensureProjectionVersion(db, {
      group: 'core',
      workspaceId,
      codeVersion: CORE_PROJECTION_VERSION,
      rebuild: () => this.replay(),
    });
    // ── 动态记录投影（B.2）───────────────────────────────
    // 先追账再对戳：sync 幂等（重启后游标归 -1 = 全量重放），能自愈
    // 「append 已提交、投影未应用」的崩溃窗口；随后的 per-module 版本戳
    // 若触发 rebuild（DYN_PROJECTION_VERSION bump），重建的是已经追平的状态。
    dynStore.sync(workspaceId);
    const snapshot = profileService.getSnapshot(workspaceId);
    for (const manifest of moduleRegistry.effectiveManifests(workspaceId)) {
      if (!snapshot.modules[manifest.id]) continue; // 只管已安装的
      if (!hasDynRecords(manifest.records)) continue;
      dynStore.ensureModuleProjection(workspaceId, manifest.id);
    }
    // ── 声明式实体的 AI 工具（B.4）──────────────────────
    // 工作区打开是「全量同步」时机：重启后声明式模块的 manifest 是靠 config.change
    // 重放回来的（进程目录里并没有它的代码），只有这里能把工具装回总线。
    // 必须排在上面两步之后——工具一可见就该能查到数据。
    // ⚠️ 只覆盖注册，从不 unregister（§A.4）：卸载模块后工具仍在总线上，
    //    调用会因 schema 解析不到而失败；「AI 看不见」由授权/可见性层负责。
    syncDynTools(bus, dynStore, moduleRegistry.installedDynRecords(workspaceId));
  }

  #registry: FieldRegistry;
  #profileService: ProfileService;
  #dyn: DynStore;

  /**
   * 全量重放：清空注册表、Profile 与动态记录投影，按全序重放全部事件重建。
   * 「事件是唯一真相」的自检路径（§8：迁移/修复同步 = 同一动作）。
   * oplog 本身永不清空——它是真相，投影才是缓存。
   *
   * 动态记录投影一并重建（B.2）：备份恢复 / 同步摄入 / 迁移导入都走这里，
   * 于是 dyn 表随 ingest 免费获得全量重建，路由层零改动。
   */
  replay(): { totalEvents: number; appliedRegistryEvents: number; appliedConfigEvents: number } {
    const rebuild = this.db.transaction(() => {
      this.#registry.clearProjection(this.workspaceId);
      this.#profileService.clearProjection(this.workspaceId);
      this.#dyn.clearProjection(this.workspaceId);
      this.#dyn.resetCursor(this.workspaceId);

      let total = 0;
      let appliedRegistry = 0;
      let appliedConfig = 0;
      this.oplog.forEachEvent(this.workspaceId, (env) => {
        total++;
        this.#registry.applyEvent(env);
        this.#profileService.applyEvent(env);
        // 非 record.* 事件在 DynStore.applyEvent 里零成本早退
        this.#dyn.applyEvent(env);
        if (env.type.startsWith('registry.')) appliedRegistry++;
        if (env.type === 'config.change') appliedConfig++;
      });
      return { totalEvents: total, appliedRegistryEvents: appliedRegistry, appliedConfigEvents: appliedConfig };
    });
    return rebuild();
  }
}
