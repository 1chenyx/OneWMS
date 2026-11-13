import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type TransferCreatedPayload,
  type TransferStateChangedPayload,
} from '../events/catalog.js';

/**
 * 调拨投影——wms_transfer / wms_transfer_line 表。
 *
 * 纪律与兄弟投影同源：applyEvent 是两表唯一写路径，幂等（主表按业务 id 查重早退；
 * 行 id 六段派生 + ON CONFLICT 覆盖）。生命周期词汇固定：
 * created → inTransit → completed / canceled（不进 Profile workflows）。
 * 库存扣减/加增是普通 inventory.adjusted（reason: transfer:{单号}），
 * 由 InventoryView 应用——本投影只管单据自身。
 */

export interface TransferRecord {
  readonly id: string;
  readonly transferNo: string;
  /** 'created'（新建）/ 'inTransit'（在途）/ 'completed'（已完成）/ 'canceled'（已取消） */
  readonly state: string;
  readonly fromWarehouseId: string | null;
  readonly toWarehouseId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferLineRecord {
  readonly skuId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

interface TransferRow {
  id: string;
  transfer_no: string;
  state: string;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface TransferLineRow {
  sku_id: string;
  from_location_id: string;
  to_location_id: string;
  batch_no: string;
  quantity: number;
}

function rowToRecord(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    transferNo: row.transfer_no,
    state: row.state,
    fromWarehouseId: row.from_warehouse_id,
    toWarehouseId: row.to_warehouse_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TransferView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.transfer.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.transferCreated: {
        const p = env.payload as TransferCreatedPayload;
        if (this.#byIdRaw(p.transferId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_transfer (id, workspace_id, transfer_no, state, from_warehouse_id, to_warehouse_id, note, created_at, updated_at)
             VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)`,
          )
          .run(
            p.transferId,
            this.workspaceId,
            p.transferNo,
            p.fromWarehouseId,
            p.toWarehouseId,
            p.note ?? null,
            env.createdAt,
            env.createdAt,
          );
        const insertLine = this.db.prepare(
          `INSERT INTO wms_transfer_line (id, workspace_id, transfer_id, sku_id, from_location_id, to_location_id, batch_no, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET quantity = excluded.quantity`,
        );
        for (const line of p.lines) {
          insertLine.run(
            `${p.transferId}:${line.skuId}:${line.fromLocationId}:${line.toLocationId}:${line.batchNo}`,
            this.workspaceId,
            p.transferId,
            line.skuId,
            line.fromLocationId,
            line.toLocationId,
            line.batchNo,
            line.quantity,
          );
        }
        break;
      }
      case WMS_EVENT_TYPES.transferStateChanged: {
        const p = env.payload as TransferStateChangedPayload;
        this.db
          .prepare(`UPDATE wms_transfer SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.transferId);
        break;
      }
    }
  }

  /** 按调拨单号查（业务键） */
  byNo(transferNo: string): TransferRecord | undefined {
    const row = this.db
      .prepare<unknown[], TransferRow>(`SELECT * FROM wms_transfer WHERE workspace_id = ? AND transfer_no = ?`)
      .get(this.workspaceId, transferNo) as TransferRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部调拨单（新单在前；同刻按单号稳定化） */
  list(): TransferRecord[] {
    const rows = this.db
      .prepare<unknown[], TransferRow>(
        `SELECT * FROM wms_transfer WHERE workspace_id = ? ORDER BY created_at DESC, transfer_no`,
      )
      .all(this.workspaceId) as unknown as TransferRow[];
    return rows.map(rowToRecord);
  }

  /** 调拨明细行（按 SKU/源库位/目标库位/批次排序，展示稳定） */
  lines(transferId: string): TransferLineRecord[] {
    const rows = this.db
      .prepare<unknown[], TransferLineRow>(
        `SELECT sku_id, from_location_id, to_location_id, batch_no, quantity
         FROM wms_transfer_line WHERE workspace_id = ? AND transfer_id = ?
         ORDER BY sku_id, from_location_id, to_location_id, batch_no`,
      )
      .all(this.workspaceId, transferId) as unknown as TransferLineRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      fromLocationId: r.from_location_id,
      toLocationId: r.to_location_id,
      batchNo: r.batch_no,
      quantity: r.quantity,
    }));
  }

  #byIdRaw(id: string): TransferRow | undefined {
    return this.db
      .prepare<unknown[], TransferRow>(`SELECT * FROM wms_transfer WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as TransferRow | undefined;
  }
}
