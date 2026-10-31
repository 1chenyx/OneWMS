import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrate } from './db/migrations.js';
import { OplogStore } from './oplog/oplog-store.js';
import { FieldRegistry } from './registry/field-registry.js';
import { ProfileService } from './profile/profile-service.js';
import { createProfileProposeTool } from './profile/propose-tool.js';
import { ToolBus } from './bus/tool-bus.js';
import { SyncService } from './sync/sync-service.js';
import { ModuleRegistry } from './modules/module-registry.js';
import { KeyService } from './crypto/key-service.js';
import { MigrationService } from './migration/migration-service.js';
import { WorkspaceFacade } from './workspace/workspace.js';

/**
 * OneCore —— 领域无关内核入口（进程生命周期 + workspace 工厂）。
 *
 * 职责边界（ARCHITECTURE.md）：本类只管生命周期（open/close/nodeId），
 * 能力组合在 WorkspaceFacade，能力实现在服务层。
 *
 * 分包纪律（§13.5 / 平台化路径）：本包不 import 任何领域代码，
 * 内核代码不出现仓储词汇（SKU/库存/出入库）——它们属于 @one/wms 领域包。
 */
export class OneCore {
  readonly nodeId: string;
  /** 节点间同步编排（进程级，M5）：hello/events 端点与幂等摄入的数据源 */
  readonly sync: SyncService;
  /** 工作区密钥管理（进程级，M7）：seal/unseal 的密钥供给方 */
  readonly keys: KeyService;
  /** 迁移包导出/导入（进程级，M7）：全量事件包 + 幂等摄入 */
  readonly migration: MigrationService;
  /** 模块生命周期编排（进程级，M6）：manifest 目录 + 安装/卸载管线 */
  readonly #modules: ModuleRegistry;
  readonly #db: Database.Database;
  readonly #oplog: OplogStore;
  readonly #registry: FieldRegistry;
  readonly #profile: ProfileService;
  readonly #bus = new ToolBus();

  private constructor(db: Database.Database, nodeId: string) {
    this.#db = db;
    this.nodeId = nodeId;
    this.#oplog = new OplogStore(db);
    this.#registry = new FieldRegistry(db, this.#oplog);
    this.#profile = new ProfileService(db, this.#oplog, this.#registry);
    this.#modules = new ModuleRegistry(nodeId, this.#oplog, this.#registry, this.#profile, this.#bus);
    this.sync = new SyncService(nodeId, this.#oplog, this.#profile);
    this.keys = new KeyService(db);
    this.migration = new MigrationService(nodeId, this.#oplog, this.#profile);
    // 慢通道工具（M4）：AI 提议配置变更的唯一入口；confirm/reject 不注册——
    // 人工确认权不可委托给 AI（§4.1）
    this.#bus.register(createProfileProposeTool(this.#profile));
  }

  /** 打开（或创建）一个内核实例。path 可为文件路径或 ':memory:'。 */
  static open(path: string): OneCore {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    migrate(db);
    const nodeId = ensureNodeId(db);
    return new OneCore(db, nodeId);
  }

  /**
   * 获取工作区门面——内核 API 以工作区为第一参数的纪律落点（§13.5 口子 2）。
   * 未来 SaaS 多工作区 = 同一进程持有多个 facade。
   */
  workspace(workspaceId: string): WorkspaceFacade {
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new Error('workspaceId 不能为空');
    }
    return new WorkspaceFacade(
      workspaceId,
      this.nodeId,
      this.#db,
      this.#oplog,
      this.#registry,
      this.#bus,
      this.#profile,
      this.#modules,
    );
  }

  /**
   * 领域装配口（§13.5 平台化口子 1）：数据库句柄。
   * 仅供领域包（@one/wms 等）装配期建领域表、持有投影——
   * 应用代码与 AI 工具不得触碰（工具只能经 ToolContext.appendEvent 写数据）。
   */
  exposeDb(): Database.Database {
    return this.#db;
  }

  /**
   * 领域装配口：工具总线。领域包用它注册领域工具（wms.* 命名空间）。
   */
  exposeToolBus(): ToolBus {
    return this.#bus;
  }

  /**
   * 领域装配口（M6）：模块注册服务。领域包用它注册 manifest 声明面
   * （registerManifest——「代码在场」的目录）；安装/卸载经 workspace().modules 视图。
   */
  exposeModuleRegistry(): ModuleRegistry {
    return this.#modules;
  }

  close(): void {
    this.#db.close();
  }
}

function ensureNodeId(db: Database.Database): string {
  const row = db
    .prepare<unknown[], { value: string }>(`SELECT value FROM meta WHERE key = 'node_id'`)
    .get();
  if (row) return row.value;
  const nodeId = `node-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO meta (key, value) VALUES ('node_id', ?)`).run(nodeId);
  return nodeId;
}
