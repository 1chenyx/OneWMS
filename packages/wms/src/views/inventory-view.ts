import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
  WMS_EVENT_TYPES,
  type InventoryAdjustedPayload,
  type InventoryHeldPayload,
  type InventoryReleasedPayload,
  type InventoryReservationReleasedPayload,
  type InventoryReservedPayload,
} from '../events/catalog.js';

/**
 * 库存投影（InventoryView）——wms_inventory_ledger / wms_inventory / wms_inventory_hold 表。
 *
 * 核心纪律（DESIGN.md §8.2）：**只有流水事件，没有「改库存」事件**。
 *  - wms_inventory_ledger：append-only 流水，一事件一行（event_id 主键 = 幂等键）；
 *  - wms_inventory：期初 + Σ流水 的缓存汇总，唯一写路径是本类 applyEvent。
 * 库存永远是派生视图——「修复」= 清空重放，不存在绕过流水的改数。
 *
 * 维度（M11）：余量从 (workspace, SKU, 库位) 升级为 (workspace, SKU, 库位, 批次)；
 * 老事件 payload 无批次 → 兜底 DEFAULT（虚拟桶，catalog.DEFAULT_BATCH_NO）。
 * 批次随首条流水诞生（无实体表）：效期是流水的可选属性，汇总行冗余存储、
 * upsert 时 COALESCE 首个非空为准（工具层挡不一致，投影不埋业务策略）。
 *
 * 冻结（M19）：wms_inventory_hold 只存活动冻结行（held 事件 INSERT /
 * released 事件 DELETE，幂等键 = holdId）——历史在事件里。冻结不改物理量、
 * 不落流水：可用量 = totalOf(sku) − heldOf(sku) − reservedOfSku(sku)。
 *
 * 拣货占用（module.reservation）：wms_inventory_reservation 只存活动占用行
 * （reserved INSERT OR IGNORE / reservation_released DELETE）。占用按桶，
 * 不改物理量。其他出库单的可用量要减掉它；占用方自己发货时由调用方排除。
 */

export interface InventoryRecord {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  /** 批次已登记的效期（YYYY-MM-DD）；未声明为 null（DEFAULT 虚拟批次恒为 null） */
  readonly batchExpiryDate: string | null;
  readonly quantity: number;
}

export interface LedgerRecord {
  readonly eventId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly batchExpiryDate: string | null;
  readonly delta: number;
  readonly reason: string;
  readonly orderId: string | null;
  readonly createdAt: string;
}

/** 活动冻结行（M19）：released 后即从投影消失（历史在事件） */
export interface HoldRecord {
  readonly id: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly reason: string;
  readonly createdAt: string;
}

/** 活动拣货占用：释放后从投影消失（历史在事件） */
export interface ReservationRecord {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

interface InventoryRow {
  sku_id: string;
  location_id: string;
  batch_no: string;
  batch_expiry_date: string | null;
  quantity: number;
}

interface LedgerRow {
  event_id: string;
  sku_id: string;
  location_id: string;
  batch_no: string;
  batch_expiry_date: string | null;
  delta: number;
  reason: string;
  order_id: string | null;
  created_at: string;
}

export class InventoryView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条库存域事件（adjusted/held/released/reserved；重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    if (env.type === WMS_EVENT_TYPES.inventoryReserved) {
      const p = env.payload as InventoryReservedPayload;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO wms_inventory_reservation
             (id, workspace_id, order_id, order_no, sku_id, location_id, batch_no, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.reservationId,
          this.workspaceId,
          p.orderId,
          p.orderNo,
          p.skuId,
          p.locationId,
          p.batchNo,
          p.quantity,
        );
      return;
    }
    if (env.type === WMS_EVENT_TYPES.inventoryReservationReleased) {
      const p = env.payload as InventoryReservationReleasedPayload;
      this.db
        .prepare(`DELETE FROM wms_inventory_reservation WHERE workspace_id = ? AND id = ?`)
        .run(this.workspaceId, p.reservationId);
      return;
    }
    if (env.type === WMS_EVENT_TYPES.inventoryHeld) {
      // 幂等：主键 holdId 已在 = 已应用过（INSERT OR IGNORE）
      const p = env.payload as InventoryHeldPayload;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO wms_inventory_hold (id, workspace_id, sku_id, quantity, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(p.holdId, this.workspaceId, p.skuId, p.quantity, p.reason, env.createdAt);
      return;
    }
    if (env.type === WMS_EVENT_TYPES.inventoryReleased) {
      // 幂等：删不存在的行是 no-op（重复 released / 乱序重放天然收敛）
      const p = env.payload as InventoryReleasedPayload;
      this.db
        .prepare(`DELETE FROM wms_inventory_hold WHERE workspace_id = ? AND id = ?`)
        .run(this.workspaceId, p.holdId);
      return;
    }
    if (env.type !== WMS_EVENT_TYPES.inventoryAdjusted) return;
    const p = env.payload as InventoryAdjustedPayload;

    // 幂等早退：event_id 已入账说明这条流水已应用过
    const exists = this.db
      .prepare(`SELECT 1 FROM wms_inventory_ledger WHERE workspace_id = ? AND event_id = ?`)
      .get(this.workspaceId, env.eventId);
    if (exists) return;

    const locationId = p.locationId ?? DEFAULT_LOCATION_ID;
    const batchNo = p.batchNo ?? DEFAULT_BATCH_NO;
    const batchExpiryDate = p.batchExpiryDate ?? null;

    this.db
      .prepare(
        `INSERT INTO wms_inventory_ledger (event_id, workspace_id, sku_id, location_id, batch_no, batch_expiry_date, delta, reason, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        env.eventId,
        this.workspaceId,
        p.skuId,
        locationId,
        batchNo,
        batchExpiryDate,
        p.delta,
        p.reason,
        p.orderId ?? null,
        env.createdAt,
      );

    this.db
      .prepare(
        `INSERT INTO wms_inventory (workspace_id, sku_id, location_id, batch_no, batch_expiry_date, quantity)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, sku_id, location_id, batch_no)
         DO UPDATE SET
           quantity = quantity + excluded.quantity,
           batch_expiry_date = COALESCE(wms_inventory.batch_expiry_date, excluded.batch_expiry_date)`,
      )
      .run(this.workspaceId, p.skuId, locationId, batchNo, batchExpiryDate, p.delta);
  }

  /**
   * 当前余量（无记录视为 0——库存不为负的校验数据源）。
   * 缺省 DEFAULT 桶：批次/库位皆缺省——M10 全部调用点（transition/adjust 守卫、
   * 测试 helper）不带批次即查默认批次默认库位——与升级前行为逐字节等价（兼容性支点）。
   */
  quantityOf(
    skuId: string,
    locationId: string = DEFAULT_LOCATION_ID,
    batchNo: string = DEFAULT_BATCH_NO,
  ): number {
    const row = this.db
      .prepare<unknown[], InventoryRow>(
        `SELECT sku_id, location_id, batch_no, batch_expiry_date, quantity FROM wms_inventory
         WHERE workspace_id = ? AND sku_id = ? AND location_id = ? AND batch_no = ?`,
      )
      .get(this.workspaceId, skuId, locationId, batchNo) as InventoryRow | undefined;
    return row?.quantity ?? 0;
  }

  /** 某 SKU 全库位合计余量（M19 冻结可用量基数：可用 = totalOf − heldOf） */
  totalOf(skuId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS total FROM wms_inventory WHERE workspace_id = ? AND sku_id = ?`)
      .get(this.workspaceId, skuId) as { total: number };
    return row.total;
  }

  /**
   * 某桶上、不属于 exceptOrderIds 的占用合计。
   * 占用方发货时把自己的单据 id 传进来，避免被自己的占用拦住。
   */
  reservedOf(
    skuId: string,
    locationId: string = DEFAULT_LOCATION_ID,
    batchNo: string = DEFAULT_BATCH_NO,
    exceptOrderIds: readonly string[] = [],
  ): number {
    const except = exceptClause(exceptOrderIds);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS reserved FROM wms_inventory_reservation
         WHERE workspace_id = ? AND sku_id = ? AND location_id = ? AND batch_no = ?${except.sql}`,
      )
      .get(this.workspaceId, skuId, locationId, batchNo, ...except.params) as { reserved: number };
    return row.reserved;
  }

  /** 某 SKU 跨桶占用合计（同样可排除指定单据） */
  reservedOfSku(skuId: string, exceptOrderIds: readonly string[] = []): number {
    const except = exceptClause(exceptOrderIds);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS reserved FROM wms_inventory_reservation
         WHERE workspace_id = ? AND sku_id = ?${except.sql}`,
      )
      .get(this.workspaceId, skuId, ...except.params) as { reserved: number };
    return row.reserved;
  }

  /** 活动占用。orderId 缺省 = 全部。 */
  listReservations(orderId?: string): ReservationRecord[] {
    const rows = (orderId
      ? this.db
          .prepare(
            `SELECT id, order_id, order_no, sku_id, location_id, batch_no, quantity
             FROM wms_inventory_reservation WHERE workspace_id = ? AND order_id = ? ORDER BY id`,
          )
          .all(this.workspaceId, orderId)
      : this.db
          .prepare(
            `SELECT id, order_id, order_no, sku_id, location_id, batch_no, quantity
             FROM wms_inventory_reservation WHERE workspace_id = ? ORDER BY id`,
          )
          .all(this.workspaceId)) as Array<{
      id: string;
      order_id: string;
      order_no: string;
      sku_id: string;
      location_id: string;
      batch_no: string;
      quantity: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      orderNo: r.order_no,
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      quantity: r.quantity,
    }));
  }

  /** 某 SKU 活动冻结合计（M19；出库拦截与可用量展示的数据源） */
  heldOf(skuId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS held FROM wms_inventory_hold WHERE workspace_id = ? AND sku_id = ?`)
      .get(this.workspaceId, skuId) as { held: number };
    return row.held;
  }

  /** 活动冻结清单（M19）：skuId 缺省 = 全部；创建时间升序（稳定展示序） */
  listHolds(skuId?: string): HoldRecord[] {
    const rows = (skuId
      ? this.db
          .prepare(`SELECT * FROM wms_inventory_hold WHERE workspace_id = ? AND sku_id = ? ORDER BY created_at, id`)
          .all(this.workspaceId, skuId)
      : this.db
          .prepare(`SELECT * FROM wms_inventory_hold WHERE workspace_id = ? ORDER BY created_at, id`)
          .all(this.workspaceId)) as unknown as Array<{
      id: string;
      sku_id: string;
      quantity: number;
      reason: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      skuId: r.sku_id,
      quantity: r.quantity,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /** 全部库存清单（SKU × 库位 × 批次 维度行；AI 查询工具的数据源） */
  list(): InventoryRecord[] {
    const rows = this.db
      .prepare<unknown[], InventoryRow>(
        `SELECT sku_id, location_id, batch_no, batch_expiry_date, quantity FROM wms_inventory
         WHERE workspace_id = ? ORDER BY sku_id, location_id, batch_no`,
      )
      .all(this.workspaceId) as unknown as InventoryRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      quantity: r.quantity,
    }));
  }

  /**
   * 按 SKU 汇总的 SQL 分页。只含有库存行的 SKU。
   * 冻结和占用按 SKU 预聚合后再 JOIN，避免被库存行乘进去。
   */
  summaryPage(opts: {
    q?: string;
    skuCode?: string;
    lowOnly?: boolean;
    limit: number;
    offset: number;
  }): {
    rows: Array<{
      skuId: string;
      skuCode: string;
      name: string;
      quantity: number;
      held: number;
      reserved: number;
      available: number;
      reorderPoint: number;
      unit: string | null;
    }>;
    total: number;
    hasReserved: boolean;
  } {
    const pat = opts.q ? `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const where = `
      FROM wms_inventory i
      LEFT JOIN wms_sku s ON s.workspace_id = i.workspace_id AND s.id = i.sku_id
      LEFT JOIN (
        SELECT sku_id, SUM(quantity) AS held
        FROM wms_inventory_hold
        WHERE workspace_id = ?
        GROUP BY sku_id
      ) h ON h.sku_id = i.sku_id
      LEFT JOIN (
        SELECT sku_id, SUM(quantity) AS reserved
        FROM wms_inventory_reservation
        WHERE workspace_id = ?
        GROUP BY sku_id
      ) r ON r.sku_id = i.sku_id
      WHERE i.workspace_id = ?
        AND (? IS NULL OR s.sku_code = ?)
        AND (
          ? IS NULL
          OR s.sku_code LIKE ? ESCAPE '\\'
          OR IFNULL(s.name, '') LIKE ? ESCAPE '\\'
        )
      GROUP BY i.sku_id
      HAVING (
        ? = 0
        OR (
          COALESCE(s.reorder_point, 0) > 0
          AND (SUM(i.quantity) - COALESCE(h.held, 0) - COALESCE(r.reserved, 0)) < COALESCE(s.reorder_point, 0)
        )
      )`;
    const args: unknown[] = [
      this.workspaceId,
      this.workspaceId,
      this.workspaceId,
      opts.skuCode ?? null,
      opts.skuCode ?? null,
      pat,
      pat,
      pat,
      opts.lowOnly ? 1 : 0,
    ];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM (SELECT i.sku_id ${where})`).get(...args) as {
        total: number;
      }
    ).total;
    const raw = this.db
      .prepare(
        `SELECT
           i.sku_id AS sku_id,
           COALESCE(s.sku_code, '(未知)') AS sku_code,
           COALESCE(s.name, '') AS name,
           SUM(i.quantity) AS quantity,
           COALESCE(h.held, 0) AS held,
           COALESCE(r.reserved, 0) AS reserved,
           COALESCE(s.reorder_point, 0) AS reorder_point,
           s.unit AS unit
         ${where}
         ORDER BY sku_code
         LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as Array<{
      sku_id: string;
      sku_code: string;
      name: string;
      quantity: number;
      held: number;
      reserved: number;
      reorder_point: number;
      unit: string | null;
    }>;
    const reservedHit = this.db
      .prepare(`SELECT 1 AS ok FROM wms_inventory_reservation WHERE workspace_id = ? LIMIT 1`)
      .get(this.workspaceId) as { ok: number } | undefined;
    return {
      total,
      hasReserved: reservedHit !== undefined,
      rows: raw.map((r) => ({
        skuId: r.sku_id,
        skuCode: r.sku_code,
        name: r.name,
        quantity: r.quantity,
        held: r.held,
        reserved: r.reserved,
        available: r.quantity - r.held - r.reserved,
        reorderPoint: r.reorder_point,
        unit: r.unit,
      })),
    };
  }

  /**
   * 某批次已登记的效期（M11 工具层一致性校验数据源）：
   * 流水中该 (SKU, 批次) 首个非空效期；未登记返回 null。
   * 从流水（事件真相）查，不从汇总冗余查——重放后两者恒一致。
   */
  expiryOfBatch(skuId: string, batchNo: string): string | null {
    const row = this.db
      .prepare(
        `SELECT batch_expiry_date FROM wms_inventory_ledger
         WHERE workspace_id = ? AND sku_id = ? AND batch_no = ? AND batch_expiry_date IS NOT NULL
         ORDER BY created_at, event_id LIMIT 1`,
      )
      .get(this.workspaceId, skuId, batchNo) as { batch_expiry_date: string } | undefined;
    return row?.batch_expiry_date ?? null;
  }

  /**
   * 临期批次余量行（M11，临期查询工具的数据源）：效期非空且 ≤ today + days
   * （含已过期）。today 由调用方传入（UTC 日期，测试可固定）；ISO 日期字典序
   * 即时间序，字符串比较成立。
   */
  listExpiring(days: number, today: string): InventoryRecord[] {
    const rows = this.db
      .prepare<unknown[], InventoryRow>(
        `SELECT sku_id, location_id, batch_no, batch_expiry_date, quantity FROM wms_inventory
         WHERE workspace_id = ? AND batch_expiry_date IS NOT NULL AND batch_expiry_date <= date(?, ?)
         ORDER BY batch_expiry_date, sku_id, location_id, batch_no`,
      )
      .all(this.workspaceId, today, `+${days} days`) as unknown as InventoryRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      quantity: r.quantity,
    }));
  }

  /**
   * 某 SKU 在指定库位内的批次桶清单（M12 批次分配的数据源）：
   * 只含余量 > 0 的桶；firstSeenAt = 该桶首笔流水时间（联 ledger 取 MIN(created_at)，
   * 与 expiryOfBatch 同源——从事件真相取，不从汇总冗余取）。
   * FIFO 排序键 = firstSeenAt；同刻并列由调用方用 batchNo 字典序稳定化。
   */
  batchesOf(skuId: string, locationId: string): {
    batchNo: string;
    batchExpiryDate: string | null;
    quantity: number;
    firstSeenAt: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT i.batch_no, i.batch_expiry_date, i.quantity,
           (SELECT MIN(l.created_at) FROM wms_inventory_ledger l
            WHERE l.workspace_id = i.workspace_id AND l.sku_id = i.sku_id
              AND l.location_id = i.location_id AND l.batch_no = i.batch_no) AS first_seen_at
         FROM wms_inventory i
         WHERE i.workspace_id = ? AND i.sku_id = ? AND i.location_id = ? AND i.quantity > 0
         ORDER BY i.batch_no`,
      )
      .all(this.workspaceId, skuId, locationId) as Array<{
      batch_no: string;
      batch_expiry_date: string | null;
      quantity: number;
      first_seen_at: string | null;
    }>;
    return rows.map((r) => ({
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      quantity: r.quantity,
      firstSeenAt: r.first_seen_at ?? '',
    }));
  }

  /** 某库位上的实物合计，给库容用。 */
  quantityAtLocation(locationId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS qty FROM wms_inventory
         WHERE workspace_id = ? AND location_id = ?`,
      )
      .get(this.workspaceId, locationId) as { qty: number };
    return row.qty;
  }

  /**
   * 一张单据名下的库存净变动，按库位和批次。
   * 出库发货是负数，入库收货是正数，上架一负一正互抵后批次净额仍是实收。
   */
  movementsByOrder(orderId: string): { skuId: string; locationId: string; batchNo: string; net: number }[] {
    const rows = this.db
      .prepare(
        `SELECT sku_id, location_id, batch_no, SUM(delta) AS net
         FROM wms_inventory_ledger
         WHERE workspace_id = ? AND order_id = ?
         GROUP BY sku_id, location_id, batch_no`,
      )
      .all(this.workspaceId, orderId) as {
      sku_id: string;
      location_id: string;
      batch_no: string;
      net: number;
    }[];
    return rows.map((row) => ({
      skuId: row.sku_id,
      locationId: row.location_id,
      batchNo: row.batch_no,
      net: row.net,
    }));
  }

  /** 某 SKU 的流水账（审计/对账） */
  ledgerOf(skuId: string): LedgerRecord[] {
    const rows = this.db
      .prepare<unknown[], LedgerRow>(
        `SELECT * FROM wms_inventory_ledger WHERE workspace_id = ? AND sku_id = ? ORDER BY created_at, event_id`,
      )
      .all(this.workspaceId, skuId) as unknown as LedgerRow[];
    return rows.map((r) => ({
      eventId: r.event_id,
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      delta: r.delta,
      reason: r.reason,
      orderId: r.order_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * 流水分页查询（AI 工具 wms.ledger.query 的数据源）：
   * skuId/locationId/orderId 精确过滤，from/to 为 ISO 时间闭区间
   * （created_at 字典序比较成立）。最新在前（created_at DESC, event_id DESC）；
   * total 与行同条件——分页壳计算 hasMore 的依据。
   */
  listLedgerPage(opts: {
    skuId?: string;
    locationId?: string;
    orderId?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): { rows: LedgerRecord[]; total: number } {
    const where: string[] = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (opts.skuId) {
      where.push('sku_id = ?');
      args.push(opts.skuId);
    }
    if (opts.locationId) {
      where.push('location_id = ?');
      args.push(opts.locationId);
    }
    if (opts.orderId) {
      where.push('order_id = ?');
      args.push(opts.orderId);
    }
    if (opts.from) {
      where.push('created_at >= ?');
      args.push(opts.from);
    }
    if (opts.to) {
      where.push('created_at <= ?');
      args.push(opts.to);
    }
    const whereSql = where.join(' AND ');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM wms_inventory_ledger WHERE ${whereSql}`)
        .get(...args) as { total: number }
    ).total;
    const rows = this.db
      .prepare<unknown[], LedgerRow>(
        `SELECT * FROM wms_inventory_ledger WHERE ${whereSql}
         ORDER BY created_at DESC, event_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as LedgerRow[];
    return {
      rows: rows.map((r) => ({
        eventId: r.event_id,
        skuId: r.sku_id,
        locationId: r.location_id,
        batchNo: r.batch_no,
        batchExpiryDate: r.batch_expiry_date,
        delta: r.delta,
        reason: r.reason,
        orderId: r.order_id,
        createdAt: r.created_at,
      })),
      total,
    };
  }

  /**
   * 出入库日流量聚合（M21，运营看板）：近 N 天逐日正/负流水合计。
   * 上架移库（reason: putaway:*）成对 ± 净零——计入会虚增双向流量，排除；
   * 盘点差异/调整是真实库存变化，计入。group by 走 ledger 的 created_at
   * 前缀（ISO 8601 → substr(1,10) 即 UTC 日，展示口径一致即可）。
   */
  dailyFlow(sinceDay: string): { day: string; inbound: number; outbound: number }[] {
    const rows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS inbound,
                SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS outbound
         FROM wms_inventory_ledger
         WHERE workspace_id = ? AND created_at >= ? AND reason NOT LIKE 'putaway:%'
         GROUP BY day ORDER BY day`,
      )
      .all(this.workspaceId, sinceDay) as { day: string; inbound: number; outbound: number }[];
    return rows.map((r) => ({ day: r.day, inbound: r.inbound, outbound: r.outbound }));
  }

  /** 库位维度库存分布（M21，运营看板）：quantity > 0 的库位合计，降序 */
  quantityByLocation(): { locationId: string; quantity: number }[] {
    const rows = this.db
      .prepare(
        `SELECT location_id, SUM(quantity) AS quantity
         FROM wms_inventory WHERE workspace_id = ? AND quantity > 0
         GROUP BY location_id ORDER BY quantity DESC`,
      )
      .all(this.workspaceId) as { location_id: string; quantity: number }[];
    return rows.map((r) => ({ locationId: r.location_id, quantity: r.quantity }));
  }

  /**
   * 账实巡检的原始数据（wms.inventory.audit 查询用，只读）。
   *
   * 四条断言，对应几类真实事故：
   *  ① negativeBuckets —— 桶余量为负（负库存防线被绕过）；
   *  ② drift —— 投影 ≠ 流水重算（有人绕过 applyEvent 改了 wms_inventory，
   *     或重放/追账漏了事件）；
   *  ③ orderBucketNegative —— 入库单在某个桶上净流出（收货 + 少于上架 −）。
   *     共享库位（DEFAULT）堆着多张单的货，桶余量始终为正也能被上一张单多扣，
   *     差额转嫁成下一张单的「余量不足」——单看桶查不出来，必须按单据份额看。
   *  ④ orderOverPutaway —— 入库单上架到货架的量 > 本单收货流入量。
   *     上架是「−源 +目标」的一对，重复写几处目标时全桶净额仍为零（③ 看不出），
   *     但目标桶的正流量会翻倍：货凭空多出来留在货架上。比对「正向 putaway
   *     流量 vs 正向 order 流量」才抓得住，且不受事后补偿调整干扰。
   */
  auditRows(): {
    negativeBuckets: { skuId: string; locationId: string; batchNo: string; quantity: number }[];
    drift: {
      skuId: string;
      locationId: string;
      batchNo: string;
      ledgerTotal: number;
      projection: number;
    }[];
    orderBucketNegative: {
      orderId: string;
      orderNo: string;
      skuId: string;
      locationId: string;
      batchNo: string;
      net: number;
    }[];
    orderOverPutaway: {
      orderId: string;
      orderNo: string;
      skuId: string;
      received: number;
      putaway: number;
    }[];
  } {
    const EPS = 1e-6;
    const negativeBuckets = this.db
      .prepare(
        `SELECT sku_id, location_id, batch_no, quantity
         FROM wms_inventory WHERE workspace_id = ? AND quantity < ?`,
      )
      .all(this.workspaceId, -EPS) as {
      sku_id: string;
      location_id: string;
      batch_no: string;
      quantity: number;
    }[];

    // 流水重算 vs 投影：双向都要比（流水有桶投影没有 = 漏应用；反之 = 凭空多出来的桶）
    const drift = this.db
      .prepare(
        `SELECT s.sku_id, s.location_id, s.batch_no,
                s.ledger_total AS ledgerTotal, COALESCE(i.quantity, 0) AS projection
           FROM (SELECT sku_id, location_id, batch_no, SUM(delta) AS ledger_total
                   FROM wms_inventory_ledger WHERE workspace_id = ?
                  GROUP BY sku_id, location_id, batch_no) s
           LEFT JOIN wms_inventory i
             ON i.workspace_id = ? AND i.sku_id = s.sku_id
            AND i.location_id = s.location_id AND i.batch_no = s.batch_no
          WHERE ABS(COALESCE(i.quantity, 0) - s.ledger_total) > ?
          UNION ALL
         SELECT i.sku_id, i.location_id, i.batch_no, 0 AS ledgerTotal, i.quantity AS projection
           FROM wms_inventory i
          WHERE i.workspace_id = ? AND ABS(i.quantity) > ?
            AND NOT EXISTS (SELECT 1 FROM wms_inventory_ledger l
                             WHERE l.workspace_id = i.workspace_id AND l.sku_id = i.sku_id
                               AND l.location_id = i.location_id AND l.batch_no = i.batch_no)`,
      )
      .all(this.workspaceId, EPS, this.workspaceId, this.workspaceId, EPS) as {
      sku_id: string;
      location_id: string;
      batch_no: string;
      ledgerTotal: number;
      projection: number;
    }[];

    // 只查入库单：出库单发货本来就是净流出，负数是常态
    const orderBucketNegative = this.db
      .prepare(
        `SELECT l.order_id AS orderId, o.order_no AS orderNo,
                l.sku_id, l.location_id, l.batch_no, SUM(l.delta) AS net
           FROM wms_inventory_ledger l
           JOIN wms_order o ON o.id = l.order_id AND o.workspace_id = l.workspace_id
          WHERE l.workspace_id = ? AND l.order_id IS NOT NULL AND o.direction = 'in'
          GROUP BY l.order_id, o.order_no, l.sku_id, l.location_id, l.batch_no
         HAVING SUM(l.delta) < ?`,
      )
      .all(this.workspaceId, -EPS) as {
      orderId: string;
      orderNo: string;
      sku_id: string;
      location_id: string;
      batch_no: string;
      net: number;
    }[];

    // 正向 putaway 流量 vs 正向 order 流量（收货）：上架多于收进来的 = 重复上架虚增。
    // 只取正流量，成对的 −源 侧天然抵消；事后补偿调整（reason 不是这两类）不参与。
    const orderOverPutaway = this.db
      .prepare(
        `SELECT l.order_id AS orderId, o.order_no AS orderNo, l.sku_id,
                SUM(CASE WHEN l.reason LIKE 'order:%' AND l.delta > 0 THEN l.delta ELSE 0 END) AS received,
                SUM(CASE WHEN l.reason LIKE 'putaway:%' AND l.delta > 0 THEN l.delta ELSE 0 END) AS putaway
           FROM wms_inventory_ledger l
           JOIN wms_order o ON o.id = l.order_id AND o.workspace_id = l.workspace_id
          WHERE l.workspace_id = ? AND l.order_id IS NOT NULL AND o.direction = 'in'
          GROUP BY l.order_id, o.order_no, l.sku_id
         HAVING putaway - received > ?`,
      )
      .all(this.workspaceId, EPS) as {
      orderId: string;
      orderNo: string;
      sku_id: string;
      received: number;
      putaway: number;
    }[];

    return {
      negativeBuckets: negativeBuckets.map((r) => ({
        skuId: r.sku_id,
        locationId: r.location_id,
        batchNo: r.batch_no,
        quantity: r.quantity,
      })),
      drift: drift.map((r) => ({
        skuId: r.sku_id,
        locationId: r.location_id,
        batchNo: r.batch_no,
        ledgerTotal: r.ledgerTotal,
        projection: r.projection,
      })),
      orderBucketNegative: orderBucketNegative.map((r) => ({
        orderId: r.orderId,
        orderNo: r.orderNo,
        skuId: r.sku_id,
        locationId: r.location_id,
        batchNo: r.batch_no,
        net: r.net,
      })),
      orderOverPutaway: orderOverPutaway.map((r) => ({
        orderId: r.orderId,
        orderNo: r.orderNo,
        skuId: r.sku_id,
        received: r.received,
        putaway: r.putaway,
      })),
    };
  }
}

function exceptClause(exceptOrderIds: readonly string[]): { sql: string; params: string[] } {
  if (exceptOrderIds.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND order_id NOT IN (${exceptOrderIds.map(() => '?').join(', ')})`,
    params: [...exceptOrderIds],
  };
}
