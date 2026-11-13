import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DEFAULT_BATCH_NO, DEFAULT_LOCATION_ID, WMS_EVENT_TYPES } from '../events/catalog.js';

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
    // ── 老库收敛（按早退边界重建，不整组 DROP）──
    // 投影是 oplog 的缓存。构造期 sync() 从 cursor = -1 重放，内核 oplog 本函数不碰。
    // applyEvent 有幂等早退：同一条 handler 写的表必须一起丢，否则兄弟表补不回来；
    // 没被这条 handler 写到的表留下——重放对它们是空操作，哨兵行不会被清掉。
    //  1. 流水或汇总缺 batch_no：成对丢 wms_inventory_ledger + wms_inventory。
    //     流水用 event_id 早退，只丢流水会让汇总被重放再加一遍。主键带批次，不能 ALTER。
    //  2. wms_sku 缺 barcode / reorder_point / status / unit：只丢 wms_sku。
    //     ALTER DEFAULT 0 补不出事件里的 reorderPoint；skuCreated 见行即 return。
    //  3. wms_order 缺 partner_id，或行缺 location_id / batch_no：头和行一起丢。
    //     orderCreated 见单即 return，单丢行会永远补不回。
    //  4. 行 quantity 不是 REAL：搬进新表（SQLite 不能改列类型）。不能丢了再重放，
    //     头还在，早退会把行弄丢。
    // 冻结、往来单位、盘点、拣货、占用、冲突队列是纯新增，CREATE IF NOT EXISTS 即可。
    const info = (table: string) => db.pragma(`table_info(${table})`) as { name: string; type: string }[];
    const has = (cols: { name: string }[], name: string) => cols.some((c) => c.name === name);
    const drop = (...tables: string[]) => {
      for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    };

    const ledgerCols = info('wms_inventory_ledger');
    const inventoryCols = info('wms_inventory');
    if (
      (ledgerCols.length > 0 && !has(ledgerCols, 'batch_no')) ||
      (inventoryCols.length > 0 && !has(inventoryCols, 'batch_no'))
    ) {
      drop('wms_inventory_ledger', 'wms_inventory');
    }

    const skuCols = info('wms_sku');
    if (
      skuCols.length > 0 &&
      (!has(skuCols, 'barcode') ||
        !has(skuCols, 'reorder_point') ||
        !has(skuCols, 'status') ||
        !has(skuCols, 'unit'))
    ) {
      drop('wms_sku');
    }

    const orderCols = info('wms_order');
    const lineCols = info('wms_order_line');
    const lineMissingDims =
      lineCols.length > 0 && (!has(lineCols, 'location_id') || !has(lineCols, 'batch_no'));
    const orderMissingPartner = orderCols.length > 0 && !has(orderCols, 'partner_id');
    // 头被丢掉就要重放单据事件。留下的头不能再被重放写成冲突，见下方 wms_order_apply。
    let rebuildOrders = false;
    if (lineMissingDims || orderMissingPartner) {
      drop('wms_order', 'wms_order_line');
      rebuildOrders = true;
    } else if (lineCols.length > 0) {
      const qtyCol = lineCols.find((c) => c.name === 'quantity');
      if (qtyCol && qtyCol.type.toUpperCase() !== 'REAL') {
        db.exec(`DROP INDEX IF EXISTS idx_wms_order_line_order`);
        db.exec(`ALTER TABLE wms_order_line RENAME TO wms_order_line_qty_legacy`);
      }
    }

    // ── SKU 主数据（业务键：workspace + sku_code；M18 加 barcode 条码列——
    //    同库唯一：扫码枪识读的物理标识不允许二义；SQLite 中多行 NULL 不冲突，
    //    无条码的 SKU 互不影响；M20 加 reorder_point 安全库存列——0 = 不预警；
    //    A2 加 status 软停用列、A3 加 unit 单位列）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_sku (
        id             TEXT NOT NULL PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        sku_code       TEXT NOT NULL,
        barcode        TEXT,
        name           TEXT NOT NULL,
        reorder_point  INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active',
        unit           TEXT,
        serial_tracked INTEGER NOT NULL DEFAULT 0,
        ext_data       TEXT NOT NULL DEFAULT '{}',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (workspace_id, sku_code),
        UNIQUE (workspace_id, barcode)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_sku_ws ON wms_sku (workspace_id);
    `);
    const skuColsNow = db.pragma('table_info(wms_sku)') as { name: string }[];
    if (skuColsNow.length > 0 && !skuColsNow.some((c) => c.name === 'serial_tracked')) {
      db.exec(`ALTER TABLE wms_sku ADD COLUMN serial_tracked INTEGER NOT NULL DEFAULT 0`);
    }

    // ── 库位主数据（M10，业务键：workspace + location_code；扁平模型，层级是生长点）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_location (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        location_code TEXT NOT NULL,
        name          TEXT NOT NULL,
        warehouse_id  TEXT,
        zone_id       TEXT,
        capacity      REAL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, location_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_location_ws ON wms_location (workspace_id);
    `);
    const locationCols = db.pragma('table_info(wms_location)') as { name: string }[];
    if (locationCols.length > 0 && !locationCols.some((c) => c.name === 'warehouse_id')) {
      db.exec(`ALTER TABLE wms_location ADD COLUMN warehouse_id TEXT`);
    }
    if (locationCols.length > 0 && !locationCols.some((c) => c.name === 'capacity')) {
      db.exec(`ALTER TABLE wms_location ADD COLUMN capacity REAL`);
    }
    if (locationCols.length > 0 && !locationCols.some((c) => c.name === 'zone_id')) {
      db.exec(`ALTER TABLE wms_location ADD COLUMN zone_id TEXT`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_wms_location_warehouse ON wms_location (workspace_id, warehouse_id)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wms_location_zone ON wms_location (workspace_id, zone_id)`);

    // ── 仓库（module.warehouse）：库位的上一层。不进库存主键。
    //    老库加表即可，库位仍以编码为身份；未划仓的库位 warehouse_id 保持 NULL。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_warehouse (
        id             TEXT NOT NULL PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        warehouse_code TEXT NOT NULL,
        name           TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (workspace_id, warehouse_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_warehouse_ws ON wms_warehouse (workspace_id);
    `);

    // ── 库区（module.zone）：库位上的分类。不进库存主键。
    //    老库加表即可。未划区的库位 zone_id 保持 NULL。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_zone (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        zone_code     TEXT NOT NULL,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        warehouse_id  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, zone_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_zone_ws ON wms_zone (workspace_id);
      CREATE INDEX IF NOT EXISTS idx_wms_zone_warehouse ON wms_zone (workspace_id, warehouse_id);
    `);

    // ── 序列号（module.serial）：一件一个号。不是库存主键。
    //    出库后行还在（status=out），再入库更新同一行。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_serial (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        serial_no    TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        batch_no     TEXT NOT NULL,
        lpn_id       TEXT,
        status       TEXT NOT NULL CHECK (status IN ('in', 'out')),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, serial_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_serial_sku
        ON wms_serial (workspace_id, sku_id, status);
      CREATE INDEX IF NOT EXISTS idx_wms_serial_loc
        ON wms_serial (workspace_id, location_id, status);
    `);

    // ── 托盘（module.lpn）：库位上的搬运单元。行数量是装完后的绝对件数，
    //    占用的是已有库位+批次桶，不另开库存键。location_id 可以是虚拟 DEFAULT。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_lpn (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        lpn_code     TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, lpn_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_lpn_ws ON wms_lpn (workspace_id);
      CREATE INDEX IF NOT EXISTS idx_wms_lpn_loc ON wms_lpn (workspace_id, location_id);

      CREATE TABLE IF NOT EXISTS wms_lpn_line (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        lpn_id       TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        batch_no     TEXT NOT NULL,
        quantity     REAL NOT NULL,
        UNIQUE (workspace_id, lpn_id, sku_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_lpn_line_lpn ON wms_lpn_line (workspace_id, lpn_id);
    `);

    // ── 往来单位主数据（M21：供应商/客户统一实体，kind 区分；
    //    业务键：workspace + partner_code；引用完整性靠工具层守卫（无外键声明））──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_partner (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        partner_code TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('supplier', 'customer')),
        name         TEXT NOT NULL,
        contact      TEXT,
        phone        TEXT,
        address      TEXT,
        note         TEXT,
        ext_data     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, partner_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_partner_ws ON wms_partner (workspace_id);
    `);

    // ── 单据主表（状态机当前态 + 业务键：workspace + order_no；M21 加
    //    partner_id 往来单位列——入库=供应商/出库=客户，可空）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_no     TEXT NOT NULL,
        direction    TEXT NOT NULL,
        state        TEXT NOT NULL,
        partner_id   TEXT,
        return_of_order_id TEXT,
        expected_at  TEXT,
        replenishment INTEGER NOT NULL DEFAULT 0,
        note         TEXT,
        ext_data     TEXT NOT NULL DEFAULT '{}',
        batch_constraint TEXT,
        location_constraint TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (workspace_id, order_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_ws ON wms_order (workspace_id, direction);
      CREATE INDEX IF NOT EXISTS idx_wms_order_time ON wms_order (workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_wms_order_partner ON wms_order (workspace_id, partner_id, created_at);
    `);
    // 退货：原单 id。老库加列，不重建（旧单据都不是退货，保持 NULL）
    const orderColsNow = db.pragma('table_info(wms_order)') as { name: string }[];
    if (orderColsNow.length > 0 && !orderColsNow.some((c) => c.name === 'return_of_order_id')) {
      db.exec(`ALTER TABLE wms_order ADD COLUMN return_of_order_id TEXT`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_wms_order_return ON wms_order (workspace_id, return_of_order_id)`,
    );
    // 到货预报：预计到货日。老库加列，不重建（旧单据都不是预报，保持 NULL）
    const orderColsAfterReturn = db.pragma('table_info(wms_order)') as { name: string }[];
    if (orderColsAfterReturn.length > 0 && !orderColsAfterReturn.some((c) => c.name === 'expected_at')) {
      db.exec(`ALTER TABLE wms_order ADD COLUMN expected_at TEXT`);
    }
    // 补货标记。老库加列，不重建（旧单据都不是补货单，保持 0）
    const orderColsAfterExpected = db.pragma('table_info(wms_order)') as { name: string }[];
    if (orderColsAfterExpected.length > 0 && !orderColsAfterExpected.some((c) => c.name === 'replenishment')) {
      db.exec(`ALTER TABLE wms_order ADD COLUMN replenishment INTEGER NOT NULL DEFAULT 0`);
    }
    const orderColsConstraint = db.pragma('table_info(wms_order)') as { name: string }[];
    if (orderColsConstraint.length > 0 && !orderColsConstraint.some((c) => c.name === 'batch_constraint')) {
      db.exec(`ALTER TABLE wms_order ADD COLUMN batch_constraint TEXT`);
    }
    if (orderColsConstraint.length > 0 && !orderColsConstraint.some((c) => c.name === 'location_constraint')) {
      db.exec(`ALTER TABLE wms_order ADD COLUMN location_constraint TEXT`);
    }

    // 状态冲突队列（投影，可丢）：from 对不上的 state_changed 落在这里，不改单据状态。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order_conflict (
        event_id     TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_id     TEXT NOT NULL,
        order_no     TEXT NOT NULL,
        direction    TEXT NOT NULL,
        from_state   TEXT NOT NULL,
        to_state     TEXT NOT NULL,
        actual_state TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_conflict_ws
        ON wms_order_conflict (workspace_id, status);
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
        quantity     REAL NOT NULL,
        fulfilled_qty REAL,
        serials      TEXT,
        UNIQUE (workspace_id, order_id, sku_id, location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_order_line_order ON wms_order_line (workspace_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_wms_order_line_sku ON wms_order_line (workspace_id, sku_id);
    `);
    copyOrderLineQtyLegacy(db);
    // 短收短发：已入账净量。老库加列，不重建（旧事件保持 NULL = 按订单数量）
    const lineColsNow = db.pragma('table_info(wms_order_line)') as { name: string }[];
    if (lineColsNow.length > 0 && !lineColsNow.some((c) => c.name === 'fulfilled_qty')) {
      db.exec(`ALTER TABLE wms_order_line ADD COLUMN fulfilled_qty REAL`);
    }
    if (lineColsNow.length > 0 && !lineColsNow.some((c) => c.name === 'serials')) {
      db.exec(`ALTER TABLE wms_order_line ADD COLUMN serials TEXT`);
    }

    // 单据事件已入账标记。构造期从 cursor = -1 重放；单据状态转移不是幂等的
    // （from 对不上就记冲突）。头没丢时先把账本里的单据事件登记进来，重放直接跳过，
    // 避免每次重开都把已经入账的转移再记成一条冲突。头被重建时清掉标记，让重放补表。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_order_apply (
        workspace_id TEXT NOT NULL,
        event_id     TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id)
      );
    `);
    if (rebuildOrders) {
      db.exec(`DELETE FROM wms_order_apply`);
    } else {
      const types = [
        WMS_EVENT_TYPES.orderCreated,
        WMS_EVENT_TYPES.orderRevised,
        WMS_EVENT_TYPES.orderStateChanged,
        WMS_EVENT_TYPES.orderConflictAccepted,
        WMS_EVENT_TYPES.orderConflictDismissed,
      ];
      const placeholders = types.map(() => '?').join(', ');
      db.prepare(
        `INSERT OR IGNORE INTO wms_order_apply (workspace_id, event_id)
         SELECT workspace_id, event_id FROM oplog WHERE type IN (${placeholders})`,
      ).run(...types);
    }

    // ── 库存流水（append-only；一事件一行，event_id 即幂等键；M11 加批次维度）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory_ledger (
        event_id     TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_ID}',
        batch_no     TEXT NOT NULL DEFAULT '${DEFAULT_BATCH_NO}',
        batch_expiry_date TEXT,
        delta        REAL NOT NULL,
        reason       TEXT NOT NULL,
        order_id     TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_ledger_sku
        ON wms_inventory_ledger (workspace_id, sku_id);
      CREATE INDEX IF NOT EXISTS idx_wms_ledger_order
        ON wms_inventory_ledger (workspace_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_wms_ledger_time
        ON wms_inventory_ledger (workspace_id, created_at);
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
        quantity     REAL NOT NULL DEFAULT 0,
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
        quantity     REAL NOT NULL,
        reason       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_hold_sku ON wms_inventory_hold (workspace_id, sku_id);
    `);

    // ── 拣货占用（module.reservation）：活动占用行。纯新增表，老库 CREATE 即可，
    //    不触发整组 DROP——历史事件里没有占用，空表即正确。释放即删行。──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_inventory_reservation (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        order_id     TEXT NOT NULL,
        order_no     TEXT NOT NULL,
        sku_id       TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        batch_no     TEXT NOT NULL,
        quantity     REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_reservation_sku
        ON wms_inventory_reservation (workspace_id, sku_id);
      CREATE INDEX IF NOT EXISTS idx_wms_reservation_order
        ON wms_inventory_reservation (workspace_id, order_id);
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
        expected_qty  REAL NOT NULL,
        counted_qty   REAL,
        UNIQUE (workspace_id, stocktake_id, sku_id, location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_stocktake_line_st
        ON wms_stocktake_line (workspace_id, stocktake_id);
    `);

    // ── 拣货单主表（M21，业务键：workspace + picking_no；state 固定生命周期
    //    created/closed/canceled——M17 盘点先例，不进 Profile workflows）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_picking (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        picking_no    TEXT NOT NULL,
        state         TEXT NOT NULL,
        note          TEXT,
        ext_data      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, picking_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_picking_ws ON wms_picking (workspace_id);
    `);

    // ── 拣货单行（M21）：一行 = 拣货单 + 关联出库单行（orderLineId 四段派生键）。
    //    行 id = pickingId:orderLineId（重放幂等键）；建议桶随 created 事件携带；
    //    picked_qty 0 = 未拣；实拣桶缺省 = 建议桶，picker 改拣时记录实际桶。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_picking_line (
        id                    TEXT NOT NULL PRIMARY KEY,
        workspace_id          TEXT NOT NULL,
        picking_id            TEXT NOT NULL,
        order_id              TEXT NOT NULL,
        order_no              TEXT NOT NULL,
        order_line_id         TEXT NOT NULL,
        sku_id                TEXT NOT NULL,
        qty_to_pick           REAL NOT NULL,
        suggested_location_id TEXT NOT NULL,
        suggested_batch_no    TEXT NOT NULL,
        picked_qty            REAL NOT NULL DEFAULT 0,
        picked_location_id    TEXT,
        picked_batch_no       TEXT,
        confirmed             INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        UNIQUE (workspace_id, picking_id, order_line_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_picking_line_pk
        ON wms_picking_line (workspace_id, picking_id);
      CREATE INDEX IF NOT EXISTS idx_wms_picking_line_order
        ON wms_picking_line (workspace_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_wms_picking_line_sku
        ON wms_picking_line (workspace_id, sku_id);
    `);
    const pickingLineCols = db.pragma('table_info(wms_picking_line)') as { name: string }[];
    if (pickingLineCols.length > 0 && !pickingLineCols.some((c) => c.name === 'confirmed')) {
      db.exec(`ALTER TABLE wms_picking_line ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_picking_allocation (
        workspace_id TEXT NOT NULL,
        line_id      TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        batch_no     TEXT NOT NULL,
        quantity     REAL NOT NULL,
        PRIMARY KEY (workspace_id, line_id, location_id, batch_no)
      );
    `);

    // ── 波次：多张已创建出库单收成一波。state 固定 open / picking / canceled。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_wave (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        wave_no       TEXT NOT NULL,
        state         TEXT NOT NULL,
        note          TEXT,
        picking_no    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, wave_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_wave_ws ON wms_wave (workspace_id);
      CREATE TABLE IF NOT EXISTS wms_wave_order (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        wave_id       TEXT NOT NULL,
        order_id      TEXT NOT NULL,
        order_no      TEXT NOT NULL,
        UNIQUE (workspace_id, wave_id, order_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_wave_order_order
        ON wms_wave_order (workspace_id, order_id);
    `);

    // ── 调拨单（跨仓/跨库位两阶段转移）。state 固定生命周期
    //    created/inTransit/completed/canceled——M17 盘点先例，不进 Profile workflows。
    //    库存影响走普通 inventory.adjusted（reason: transfer:{单号}）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_transfer (
        id               TEXT NOT NULL PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        transfer_no      TEXT NOT NULL,
        state            TEXT NOT NULL,
        from_warehouse_id TEXT,
        to_warehouse_id  TEXT,
        note             TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (workspace_id, transfer_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_transfer_ws ON wms_transfer (workspace_id);
      CREATE TABLE IF NOT EXISTS wms_transfer_line (
        id                TEXT NOT NULL PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        transfer_id       TEXT NOT NULL,
        sku_id            TEXT NOT NULL,
        from_location_id  TEXT NOT NULL,
        to_location_id    TEXT NOT NULL,
        batch_no          TEXT NOT NULL,
        quantity          REAL NOT NULL,
        UNIQUE (workspace_id, transfer_id, sku_id, from_location_id, to_location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_transfer_line_tr
        ON wms_transfer_line (workspace_id, transfer_id);
    `);

    // ── 报损单（报废/损坏出库的单据化记录）。state 固定生命周期
    //    created/confirmed/canceled。扣减走普通 inventory.adjusted（reason: scrap:{单号}）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS wms_scrap (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        scrap_no      TEXT NOT NULL,
        state         TEXT NOT NULL,
        note          TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (workspace_id, scrap_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_scrap_ws ON wms_scrap (workspace_id);
      CREATE TABLE IF NOT EXISTS wms_scrap_line (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        scrap_id      TEXT NOT NULL,
        sku_id        TEXT NOT NULL,
        location_id   TEXT NOT NULL,
        batch_no      TEXT NOT NULL,
        quantity      REAL NOT NULL,
        UNIQUE (workspace_id, scrap_id, sku_id, location_id, batch_no)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_scrap_line_sc
        ON wms_scrap_line (workspace_id, scrap_id);

      CREATE TABLE IF NOT EXISTS wms_report (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title        TEXT NOT NULL,
        note         TEXT,
        definition   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wms_report_ws ON wms_report (workspace_id, updated_at);

      CREATE TABLE IF NOT EXISTS wms_integration_code (
        id             TEXT NOT NULL PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        connector_id   TEXT NOT NULL,
        entity         TEXT NOT NULL,
        external_code  TEXT NOT NULL,
        internal_code  TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (workspace_id, connector_id, entity, external_code),
        UNIQUE (workspace_id, connector_id, entity, internal_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wms_integration_code_ws
        ON wms_integration_code (workspace_id, connector_id, entity);
    `);

    // 外部对接的本机状态，不是投影。
    // 不用 wms_ 前缀：wms_* 会被投影组清空再重放。密钥和投递记录不进 oplog。
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_secret (
        workspace_id  TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        value         TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (workspace_id, connector_id, name)
      );
      CREATE TABLE IF NOT EXISTS integration_inbox (
        id            TEXT NOT NULL PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        route_id      TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        status        TEXT NOT NULL,
        internal_ref  TEXT,
        error         TEXT,
        raw_json      TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_inbox_accepted
        ON integration_inbox (workspace_id, connector_id, route_id, external_id)
        WHERE status = 'accepted';
      CREATE INDEX IF NOT EXISTS idx_integration_inbox_recent
        ON integration_inbox (workspace_id, connector_id, created_at);
      CREATE TABLE IF NOT EXISTS integration_outbox (
        id              TEXT NOT NULL PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        connector_id    TEXT NOT NULL,
        route_id        TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        body_json       TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (workspace_id, connector_id, route_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_integration_outbox_due
        ON integration_outbox (workspace_id, status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS integration_cursor (
        workspace_id  TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        lamport       INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, connector_id)
      );
      -- 入站拉取的水位。和 integration_cursor 分开：那张表是账本 lamport，不是对方的更新时间。
      CREATE TABLE IF NOT EXISTS integration_poll (
        workspace_id    TEXT NOT NULL,
        connector_id    TEXT NOT NULL,
        route_id        TEXT NOT NULL,
        watermark       TEXT,
        last_attempt_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, connector_id, route_id)
      );
    `);
  })();
}

/** quantity 列从 INTEGER 搬到 REAL。源表可能还没有 fulfilled_qty。 */
function copyOrderLineQtyLegacy(db: SqliteDatabase): void {
  const legacy = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wms_order_line_qty_legacy'`)
    .get();
  if (!legacy) return;
  const cols = db.pragma('table_info(wms_order_line_qty_legacy)') as { name: string }[];
  const has = (name: string) => cols.some((c) => c.name === name);
  const location = has('location_id') ? 'location_id' : `'${DEFAULT_LOCATION_ID}'`;
  const batch = has('batch_no') ? 'batch_no' : `'${DEFAULT_BATCH_NO}'`;
  const expiry = has('batch_expiry_date') ? 'batch_expiry_date' : 'NULL';
  const fulfilled = has('fulfilled_qty') ? 'fulfilled_qty' : 'NULL';
  db.exec(`
    INSERT INTO wms_order_line (
      id, workspace_id, order_id, sku_id, location_id, batch_no, batch_expiry_date, quantity, fulfilled_qty
    )
    SELECT id, workspace_id, order_id, sku_id, ${location}, ${batch}, ${expiry},
           CAST(quantity AS REAL), ${fulfilled}
    FROM wms_order_line_qty_legacy;
    DROP TABLE wms_order_line_qty_legacy;
  `);
}
