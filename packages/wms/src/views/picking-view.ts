import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type PickingCreatedPayload,
  type PickingPickedPayload,
  type PickingStateChangedPayload,
} from '../events/catalog.js';

/**
 * 拣货单投影（PickingView，M21）——wms_picking / wms_picking_line 表。
 *
 * 纪律与 StocktakeView 同源（M17 先例）：
 *  - applyEvent 是两表唯一写路径，幂等（主表按业务 id 查重早退；行 id
 *    = pickingId:orderLineId 派生，重放不产生重复行）；
 *  - 建议桶随 created 事件携带（建单时点的事实）；picked 事件 upsert 覆盖
 *    实拣量与实拣桶（同行重拣，后到者胜）；
 *  - 生命周期词汇固定 created → closed / canceled（不进 Profile workflows）；
 *    state_changed 投影只记事实（from 一致性由命令侧 PickingNotOpenError 守卫）。
 */

export interface PickingRecord {
  readonly id: string;
  readonly pickingNo: string;
  /** 'created'（拣货中）/ 'closed'（已关单）/ 'canceled'（已取消） */
  readonly state: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PickingLineRecord {
  /** 行 id（pickingId:orderLineId） */
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly orderLineId: string;
  readonly skuId: string;
  readonly qtyToPick: number;
  readonly suggestedLocationId: string;
  readonly suggestedBatchNo: string;
  /** 累计实拣量；0 = 未拣 */
  readonly pickedQty: number;
  /** 实拣桶（缺省 = 建议桶）；null = 未拣 */
  readonly pickedLocationId: string | null;
  readonly pickedBatchNo: string | null;
}

interface PickingRow {
  id: string;
  picking_no: string;
  state: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface PickingLineRow {
  id: string;
  order_id: string;
  order_no: string;
  order_line_id: string;
  sku_id: string;
  qty_to_pick: number;
  suggested_location_id: string;
  suggested_batch_no: string;
  picked_qty: number;
  picked_location_id: string | null;
  picked_batch_no: string | null;
}

function rowToRecord(row: PickingRow): PickingRecord {
  return {
    id: row.id,
    pickingNo: row.picking_no,
    state: row.state,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lineRowToRecord(r: PickingLineRow): PickingLineRecord {
  return {
    id: r.id,
    orderId: r.order_id,
    orderNo: r.order_no,
    orderLineId: r.order_line_id,
    skuId: r.sku_id,
    qtyToPick: r.qty_to_pick,
    suggestedLocationId: r.suggested_location_id,
    suggestedBatchNo: r.suggested_batch_no,
    pickedQty: r.picked_qty,
    pickedLocationId: r.picked_location_id,
    pickedBatchNo: r.picked_batch_no,
  };
}

export class PickingView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.picking.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.pickingCreated: {
        const p = env.payload as PickingCreatedPayload;
        if (this.#byIdRaw(p.pickingId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_picking (id, workspace_id, picking_no, state, note, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, 'created', ?, '{}', ?, ?)`,
          )
          .run(p.pickingId, this.workspaceId, p.pickingNo, p.note ?? null, env.createdAt, env.createdAt);
        const insertLine = this.db.prepare(
          `INSERT INTO wms_picking_line (id, workspace_id, picking_id, order_id, order_no, order_line_id, sku_id, qty_to_pick, suggested_location_id, suggested_batch_no, picked_qty, picked_location_id, picked_batch_no, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        );
        for (const line of p.lines) {
          insertLine.run(
            line.lineId,
            this.workspaceId,
            p.pickingId,
            line.orderId,
            line.orderNo,
            line.orderLineId,
            line.skuId,
            line.qtyToPick,
            line.suggestedLocationId,
            line.suggestedBatchNo,
            env.createdAt,
            env.createdAt,
          );
        }
        break;
      }
      case WMS_EVENT_TYPES.pickingPicked: {
        const p = env.payload as PickingPickedPayload;
        // 同行重拣后到者胜：覆盖累计实拣量与实拣桶；未改拣时沿用建议桶
        this.db
          .prepare(
            `UPDATE wms_picking_line SET
               picked_qty = ?,
               picked_location_id = ?,
               picked_batch_no = ?,
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.pickedQty,
            p.pickedLocationId ?? null,
            p.pickedBatchNo ?? null,
            env.createdAt,
            this.workspaceId,
            p.lineId,
          );
        break;
      }
      case WMS_EVENT_TYPES.pickingStateChanged: {
        const p = env.payload as PickingStateChangedPayload;
        this.db
          .prepare(`UPDATE wms_picking SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.pickingId);
        break;
      }
    }
  }

  /** 按拣货单号查（业务键） */
  byNo(pickingNo: string): PickingRecord | undefined {
    const row = this.db
      .prepare<unknown[], PickingRow>(`SELECT * FROM wms_picking WHERE workspace_id = ? AND picking_no = ?`)
      .get(this.workspaceId, pickingNo) as PickingRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): PickingRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部拣货单（新单在前；同刻按单号稳定化），可按状态过滤 */
  list(state?: string): PickingRecord[] {
    const rows = state
      ? (this.db
          .prepare<unknown[], PickingRow>(
            `SELECT * FROM wms_picking WHERE workspace_id = ? AND state = ? ORDER BY created_at DESC, picking_no`,
          )
          .all(this.workspaceId, state) as unknown as PickingRow[])
      : (this.db
          .prepare<unknown[], PickingRow>(
            `SELECT * FROM wms_picking WHERE workspace_id = ? ORDER BY created_at DESC, picking_no`,
          )
          .all(this.workspaceId) as unknown as PickingRow[]);
    return rows.map(rowToRecord);
  }

  /** 拣货明细行（按单号 + 行序展示稳定） */
  lines(pickingId: string): PickingLineRecord[] {
    const rows = this.db
      .prepare<unknown[], PickingLineRow>(
        `SELECT id, order_id, order_no, order_line_id, sku_id, qty_to_pick, suggested_location_id, suggested_batch_no, picked_qty, picked_location_id, picked_batch_no
         FROM wms_picking_line WHERE workspace_id = ? AND picking_id = ?
         ORDER BY order_no, rowid`,
      )
      .all(this.workspaceId, pickingId) as unknown as PickingLineRow[];
    return rows.map(lineRowToRecord);
  }

  /** 行进度统计（清单页进度展示 + close 守卫「全部行拣满」的数据源） */
  stats(pickingId: string): { lineCount: number; pickedCount: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN picked_qty >= qty_to_pick THEN 1 ELSE 0 END) AS picked
         FROM wms_picking_line WHERE workspace_id = ? AND picking_id = ?`,
      )
      .get(this.workspaceId, pickingId) as { total: number; picked: number | null };
    return { lineCount: row.total, pickedCount: row.picked ?? 0 };
  }

  /** 未拣满的行数（close 守卫） */
  unpickedCount(pickingId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM wms_picking_line
         WHERE workspace_id = ? AND picking_id = ? AND picked_qty < qty_to_pick`,
      )
      .get(this.workspaceId, pickingId) as { n: number };
    return row.n;
  }

  #byIdRaw(id: string): PickingRow | undefined {
    return this.db
      .prepare<unknown[], PickingRow>(`SELECT * FROM wms_picking WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as PickingRow | undefined;
  }
}
