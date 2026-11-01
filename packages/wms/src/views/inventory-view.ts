import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
  WMS_EVENT_TYPES,
  type InventoryAdjustedPayload,
} from '../events/catalog.js';

/**
 * 库存投影（InventoryView）——wms_inventory_ledger / wms_inventory 表。
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

  /** 幂等应用一条 wms.inventory.adjusted 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
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
}
