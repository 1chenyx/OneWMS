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
    // ── 老库收敛（投影整组 DROP 重建）──
    // 九张投影表全是 oplog 的缓存（事件是唯一真相）——检测到旧结构即整组 DROP，
    // 由 WmsWorkspace 构造期 sync()（cursor = -1 全量追账）重建。必须整组 DROP：
    // applyEvent 有幂等早退（orderCreated 见单已存在即 return），单丢一张表会让
    // 兄弟表永远不重建。内核 oplog 本函数不碰——那是唯一不可丢的真相。
    // 三道检测覆盖四条升级路径（M9→M11 / M10→M11 / ≤M17→M18 / ≤M19→M20），任一命中即重建：
    //  1. 流水表缺 batch_no 列 = M10 及以前结构（M9 结构同样命中——两列皆缺）；
    //  2. wms_sku 缺 barcode 列 = M17 及以前结构（M18 条码管理）；
    //  3. wms_sku 缺 reorder_point 列 = M19 及以前结构（M20 安全库存）。
    // M19 冻结表是纯新增（无列变更）：老库 CREATE IF NOT EXISTS 即收敛，不触发重建。
    const dropAll = () => {
      db.exec(`
        DROP TABLE IF EXISTS wms_sku;
        DROP TABLE IF EXISTS wms_location;
        DROP TABLE IF EXISTS wms_order;
        DROP TABLE IF EXISTS wms_order_line;
        DROP TABLE IF EXISTS wms_inventory_ledger;
        DROP TABLE IF EXISTS wms_inventory;
        DROP TABLE IF EXISTS wms_inventory_hold;
        DROP TABLE IF EXISTS wms_stocktake;
        DROP TABLE IF EXISTS wms_stocktake_line;
      `);
    };
    const ledgerCols = db.pragma('table_info(wms_inventory_ledger)') as { name: string }[];
    if (ledgerCols.length > 0 && !ledgerCols.some((c) => c.name === 'batch_no')) {
      dropAll();
    }
    const skuCols = db.pragma('table_info(wms_sku)') as { name: string }[];
    if (skuCols.length > 0 && !skuCols.some((c) => c.name === 'barcode')) {
      dropAll();
    }
    if (skuCols.length > 0 && !skuCols.some((c) => c.name === 'reorder_point')) {
      dropAll();
    }

    // ── SKU 主数据（业务键：workspace + sku_code；M18 加 barcode 条码列——
    //    同库唯一：扫码枪识读的物理标识不允许二义；SQLite 中多行 NULL 不冲突，
    //    无条码的 SKU 互不影响；M20 加 reorder_point 安全库存列——0 = 不预警）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_sku (
        id             TEXT NOT NULL PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        sku_code       TEXT NOT NULL,
        barcode        TEXT,
        name           TEXT NOT NULL,
        reorder_point  INTEGER NOT NULL DEFAULT 0,
        ext_data       TEXT NOT NULL DEFAULT '{}',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (workspace_id, sku_code),
        UNIQUE (workspace_id, barcode)
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

    // ── 库存冻结（M19）：活动冻结行（held 事件 INSERT / released 事件 DELETE——
    //    历史在事件里，投影只存活动态）。冻结是 SKU 级数量占用（不改物理量、
    //    不落流水）：可用量 = Σwms_inventory(该 SKU) − Σ本表(该 SKU)。
    //    无 released_at 标记列——释放即删行，幂等键是主键 id（= holdId）。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory_hold (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        quantity     INTEGER NOT NULL,
        reason       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_hold_sku ON wms_inventory_hold (workspace_id, sku_id);
    `);

    // ── 盘点单主表（M17，业务键：workspace + stocktake_no）──
    //    location_ids 是范围声明（JSON 库位 id 数组；NULL = 全场）——真相在
    //    事件，列是投影冗余；state 是固定生命周期词汇 created/closed/canceled。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_stocktake (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        stocktake_no  TEXT NOT NULL,
        state         TEXT NOT NULL,
        location_ids  TEXT,
        note          TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, stocktake_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_stocktake_ws ON wms_stocktake (workspace_id);
    `);

    // ── 盘点单行（M17）：一行 = 盘点单 + SKU + 库位 + 批次（桶）。
    //    行 id 四段派生（重放幂等键 + 同桶重盘覆盖键）；expected_qty 是
    //    applyEvent(created) 时点的账面快照（投影生成，不进事件）；counted_qty
    //    NULL = 未盘；范围外新桶随 counted 事件补行（expected 取当时现值）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_stocktake_line (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        stocktake_id  TEXT NOT NULL,
        sku_id        TEXT NOT NULL,
        location_id   TEXT NOT NULL,
        batch_no      TEXT NOT NULL,
        expected_qty  INTEGER NOT NULL,
        counted_qty   INTEGER,
        UNIQUE (workspace_id, stocktake_id, sku_id, location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_stocktake_line_st
        ON wms_stocktake_line (workspace_id, stocktake_id);
    `);
  })();
}
