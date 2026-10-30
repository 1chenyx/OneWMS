import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrate } from './db/migrations.js';
import { OplogStore } from './oplog/oplog-store.js';
import { FieldRegistry } from './registry/field-registry.js';
import { ToolBus } from './bus/tool-bus.js';
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
  readonly #db: Database.Database;
  readonly #oplog: OplogStore;
  readonly #registry: FieldRegistry;
  readonly #bus = new ToolBus();

  private constructor(db: Database.Database, nodeId: string) {
    this.#db = db;
    this.nodeId = nodeId;
    this.#oplog = new OplogStore(db);
    this.#registry = new FieldRegistry(db, this.#oplog);
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
