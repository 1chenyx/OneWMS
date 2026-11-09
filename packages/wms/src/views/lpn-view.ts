import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type LpnCreatedPayload, type LpnMovedPayload, type LpnPackedPayload } from '../events/catalog.js';
import { QTY_EPS } from '../state/inventory-policy.js';

/**
 * 托盘投影（module.lpn）。
 * 托盘停在一个库位上。行是对已有库位+批次桶的占用，数量是装完后的绝对件数。
 */
export interface LpnRecord {
  readonly id: string;
  readonly lpnCode: string;
  readonly locationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LpnLineRecord {
  readonly id: string;
  readonly lpnId: string;
  readonly skuId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

interface LpnRow {
  id: string;
  lpn_code: string;
  location_id: string;
  created_at: string;
  updated_at: string;
}

interface LpnLineRow {
  id: string;
  lpn_id: string;
  sku_id: string;
  batch_no: string;
  quantity: number;
}

function rowToRecord(row: LpnRow): LpnRecord {
  return {
    id: row.id,
    lpnCode: row.lpn_code,
    locationId: row.location_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lineToRecord(row: LpnLineRow): LpnLineRecord {
  return {
    id: row.id,
    lpnId: row.lpn_id,
    skuId: row.sku_id,
    batchNo: row.batch_no,
    quantity: row.quantity,
  };
}

export class LpnView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.lpnCreated: {
        const p = env.payload as LpnCreatedPayload;
        if (this.#byIdRaw(p.lpnId) || this.#byCodeRaw(p.lpnCode)) return;
        this.db
          .prepare(
            `INSERT INTO wms_lpn (id, workspace_id, lpn_code, location_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(p.lpnId, this.workspaceId, p.lpnCode, p.locationId, env.createdAt, env.createdAt);
        break;
      }
      case WMS_EVENT_TYPES.lpnMoved: {
        const p = env.payload as LpnMovedPayload;
        const existing = this.#byIdRaw(p.lpnId) ?? this.#byCodeRaw(p.lpnCode);
        if (!existing || existing.location_id === p.locationId) return;
        this.db
          .prepare(`UPDATE wms_lpn SET location_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.locationId, env.createdAt, this.workspaceId, existing.id);
        break;
      }
      case WMS_EVENT_TYPES.lpnPacked: {
        const p = env.payload as LpnPackedPayload;
        const existing = this.#lineRaw(p.lpnId, p.skuId, p.batchNo);
        if (p.quantity <= QTY_EPS) {
          if (!existing) return;
          this.db
            .prepare(
              `DELETE FROM wms_lpn_line
               WHERE workspace_id = ? AND lpn_id = ? AND sku_id = ? AND batch_no = ?`,
            )
            .run(this.workspaceId, p.lpnId, p.skuId, p.batchNo);
          return;
        }
        if (existing) {
          if (Math.abs(existing.quantity - p.quantity) <= QTY_EPS) return;
          this.db
            .prepare(
              `UPDATE wms_lpn_line SET quantity = ?
               WHERE workspace_id = ? AND lpn_id = ? AND sku_id = ? AND batch_no = ?`,
            )
            .run(p.quantity, this.workspaceId, p.lpnId, p.skuId, p.batchNo);
          return;
        }
        this.db
          .prepare(
            `INSERT INTO wms_lpn_line (id, workspace_id, lpn_id, sku_id, batch_no, quantity)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(p.lineId, this.workspaceId, p.lpnId, p.skuId, p.batchNo, p.quantity);
        break;
      }
    }
  }

  byCode(lpnCode: string): LpnRecord | undefined {
    const row = this.#byCodeRaw(lpnCode);
    return row ? rowToRecord(row) : undefined;
  }

  byId(id: string): LpnRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  list(): LpnRecord[] {
    const rows = this.db
      .prepare<unknown[], LpnRow>(`SELECT * FROM wms_lpn WHERE workspace_id = ? ORDER BY lpn_code`)
      .all(this.workspaceId) as unknown as LpnRow[];
    return rows.map(rowToRecord);
  }

  lines(lpnId: string): LpnLineRecord[] {
    const rows = this.db
      .prepare<unknown[], LpnLineRow>(
        `SELECT * FROM wms_lpn_line WHERE workspace_id = ? AND lpn_id = ? ORDER BY sku_id, batch_no`,
      )
      .all(this.workspaceId, lpnId) as unknown as LpnLineRow[];
    return rows.map(lineToRecord);
  }

  lineOf(lpnId: string, skuId: string, batchNo: string): LpnLineRecord | undefined {
    const row = this.#lineRaw(lpnId, skuId, batchNo);
    return row ? lineToRecord(row) : undefined;
  }

  /** 某个库位桶上，所有托盘已经装走的件数。 */
  packedAt(locationId: string, skuId: string, batchNo: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(line.quantity), 0) AS qty
         FROM wms_lpn_line line
         JOIN wms_lpn lpn ON lpn.workspace_id = line.workspace_id AND lpn.id = line.lpn_id
         WHERE line.workspace_id = ? AND lpn.location_id = ? AND line.sku_id = ? AND line.batch_no = ?`,
      )
      .get(this.workspaceId, locationId, skuId, batchNo) as { qty: number };
    return row.qty;
  }

  #byCodeRaw(lpnCode: string): LpnRow | undefined {
    return this.db
      .prepare<unknown[], LpnRow>(`SELECT * FROM wms_lpn WHERE workspace_id = ? AND lpn_code = ?`)
      .get(this.workspaceId, lpnCode) as LpnRow | undefined;
  }

  #byIdRaw(id: string): LpnRow | undefined {
    return this.db
      .prepare<unknown[], LpnRow>(`SELECT * FROM wms_lpn WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as LpnRow | undefined;
  }

  #lineRaw(lpnId: string, skuId: string, batchNo: string): LpnLineRow | undefined {
    return this.db
      .prepare<unknown[], LpnLineRow>(
        `SELECT * FROM wms_lpn_line
         WHERE workspace_id = ? AND lpn_id = ? AND sku_id = ? AND batch_no = ?`,
      )
      .get(this.workspaceId, lpnId, skuId, batchNo) as LpnLineRow | undefined;
  }
}
