import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type InventoryAdjustedPayload } from '../events/catalog.js';

/**
 * 库存投影（InventoryView）——wms_inventory_ledger / wms_inventory 表。
 *
 * 核心纪律（DESIGN.md §8.2）：**只有流水事件，没有「改库存」事件**。
 *  - wms_inventory_ledger：append-only 流水，一事件一行（event_id 主键 = 幂等键）；
 *  - wms_inventory：期初 + Σ流水 的缓存汇总，唯一写路径是本类 applyEvent。
 * 库存永远是派生视图——「修复」= 清空重放，不存在绕过流水的改数。
 */

export interface InventoryRecord {
  readonly skuId: string;
  readonly quantity: number;
}

export interface LedgerRecord {
  readonly eventId: string;
  readonly skuId: string;
  readonly delta: number;
  readonly reason: string;
  readonly orderId: string | null;
  readonly createdAt: string;
}

interface InventoryRow {
  sku_id: string;
  quantity: number;
}

interface LedgerRow {
  event_id: string;
  sku_id: string;
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

    this.db
      .prepare(
        `INSERT INTO wms_inventory_ledger (event_id, workspace_id, sku_id, delta, reason, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(env.eventId, this.workspaceId, p.skuId, p.delta, p.reason, p.orderId ?? null, env.createdAt);

    this.db
      .prepare(
        `INSERT INTO wms_inventory (workspace_id, sku_id, quantity)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, sku_id)
         DO UPDATE SET quantity = quantity + excluded.quantity`,
      )
      .run(this.workspaceId, p.skuId, p.delta);
  }

  /** 当前余量（无记录视为 0——库存不为负的校验数据源） */
  quantityOf(skuId: string): number {
    const row = this.db
      .prepare<unknown[], InventoryRow>(
        `SELECT sku_id, quantity FROM wms_inventory WHERE workspace_id = ? AND sku_id = ?`,
      )
      .get(this.workspaceId, skuId) as InventoryRow | undefined;
    return row?.quantity ?? 0;
  }

  /** 全部库存清单（AI 查询工具的数据源） */
  list(): InventoryRecord[] {
    const rows = this.db
      .prepare<unknown[], InventoryRow>(
        `SELECT sku_id, quantity FROM wms_inventory WHERE workspace_id = ? ORDER BY sku_id`,
      )
      .all(this.workspaceId) as unknown as InventoryRow[];
    return rows.map((r) => ({ skuId: r.sku_id, quantity: r.quantity }));
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
      delta: r.delta,
      reason: r.reason,
      orderId: r.order_id,
      createdAt: r.created_at,
    }));
  }
}
