import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DEFAULT_BATCH_NO, DEFAULT_LOCATION_ID } from '../events/catalog.js';

/**
 * 领域表结构（@one/wms 私有表，全部 wms_ 前缀）。
 *
 * 铁律（DESIGN.md §13.4）：
 *  - 主键一律 uuid（事件携带的业务 id），禁用自增 int；
 *  - 所有表带 workspace_id（隔离第一参数）；
 *  - 库存没有「当前值表」的写入口——wms_inventory 是流水的汇总投影，
 *    唯一写路径是 InventoryView.applyEvent（重放 wms.inventory.adjusted）。
 *
 * 与内核表同居一个 SQLite 文件（exposeDb 口子），建表幂等（IF NOT EXISTS）。
 */
export function migrateWms(db: SqliteDatabase): void {
  db.transaction(() => {
    // ── M11 老库收敛：流水表缺 batch_no 列 = M10 及以前结构 ──
    // 六张投影表全是 oplog 的缓存（事件是唯一真相）——检测到旧结构即整组 DROP，
    // 由 WmsWorkspace 构造期 sync()（cursor = -1 全量追账）重建；老事件无批次 →
    // 投影兜底 DEFAULT 批次。必须整组 DROP：applyEvent 有幂等早退（orderCreated 见单
    // 已存在即 return），单丢一张表会让兄弟表永远不重建。M9 结构（location_id 与
    // batch_no 皆缺）同样命中本检测——一道检测覆盖 M9→M11、M10→M11 两条升级路径。
    // 内核 oplog 本函数不碰——那是唯一不可丢的真相。
    const ledgerCols = db.pragma('table_info(wms_inventory_ledger)') as { name: string }[];
    if (ledgerCols.length > 0 && !ledgerCols.some((c) => c.name === 'batch_no')) {
      db.exec(`
        DROP TABLE IF EXISTS wms_sku;
        DROP TABLE IF EXISTS wms_location;
        DROP TABLE IF EXISTS wms_order;
        DROP TABLE IF EXISTS wms_order_line;
        DROP TABLE IF EXISTS wms_inventory_ledger;
        DROP TABLE IF EXISTS wms_inventory;
      `);
    }

    // ── SKU 主数据（业务键：workspace + sku_code）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_sku (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        sku_code     TEXT NOT NULL,
        name         TEXT NOT NULL,
        ext_data     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, sku_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_sku_ws ON wms_sku (workspace_id);
    `);

    // ── 库位主数据（M10，业务键：workspace + location_code；扁平模型，层级是生长点）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_location (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        location_code TEXT NOT NULL,
        name          TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, location_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_location_ws ON wms_location (workspace_id);
    `);

    // ── 单据主表（状态机当前态 + 业务键：workspace + order_no）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_no     TEXT NOT NULL,
        direction    TEXT NOT NULL,
        state        TEXT NOT NULL,
        note         TEXT,
        ext_data     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, order_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_ws ON wms_order (workspace_id, direction);
    `);

    // ── 单据行（M11：一行 = 单据 + SKU + 库位 + 批次；行 id 四段派生，重放幂等键）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order_line (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_id     TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_ID}',
        batch_no     TEXT NOT NULL DEFAULT '${DEFAULT_BATCH_NO}',
        batch_expiry_date TEXT,
        quantity     INTEGER NOT NULL,
        UNIQUE (workspace_id, order_id, sku_id, location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_line_order ON wms_order_line (workspace_id, order_id);
    `);

    // ── 库存流水（append-only；一事件一行，event_id 即幂等键；M11 加批次维度）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory_ledger (
        event_id     TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_ID}',
        batch_no     TEXT NOT NULL DEFAULT '${DEFAULT_BATCH_NO}',
        batch_expiry_date TEXT,
        delta        INTEGER NOT NULL,
        reason       TEXT NOT NULL,
        order_id     TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_ledger_sku
        ON wms_inventory_ledger (workspace_id, sku_id);
    `);

    // ── 库存汇总（期初 + Σ流水的缓存投影；唯一写路径在 InventoryView；
    //    M11 维度 SKU×库位×批次；效期随批次冗余存储——真相在流水，upsert 时
    //    COALESCE 首个非空为准，临期查询免 JOIN 流水表）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory (
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_ID}',
        batch_no     TEXT NOT NULL DEFAULT '${DEFAULT_BATCH_NO}',
        batch_expiry_date TEXT,
        quantity     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, sku_id, location_id, batch_no)
      );
    `);
  })();
}
