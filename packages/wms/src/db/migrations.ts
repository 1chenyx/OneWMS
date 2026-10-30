import type { Database as SqliteDatabase } from 'better-sqlite3';

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

    // ── 单据行（一单一 SKU 一行；行 id = orderId + skuId 派生，重放幂等键）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order_line (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_id     TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        quantity     INTEGER NOT NULL,
        UNIQUE (workspace_id, order_id, sku_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_line_order ON wms_order_line (workspace_id, order_id);
    `);

    // ── 库存流水（append-only；一事件一行，event_id 即幂等键）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory_ledger (
        event_id     TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        delta        INTEGER NOT NULL,
        reason       TEXT NOT NULL,
        order_id     TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_ledger_sku
        ON wms_inventory_ledger (workspace_id, sku_id);
    `);

    // ── 库存汇总（期初 + Σ流水的缓存投影；唯一写路径在 InventoryView）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory (
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        quantity     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, sku_id)
      );
    `);
  })();
}
