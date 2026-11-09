import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type SerialIssuedPayload,
  type SerialMovedPayload,
  type SerialReceivedPayload,
} from '../events/catalog.js';

/**
 * 序列号投影（module.serial）。
 * 一件一个号，挂在已有的库位+批次桶上。出库后行保留，再入库更新同一行。
 */
export interface SerialRecord {
  readonly id: string;
  readonly serialNo: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly lpnId: string | null;
  readonly status: 'in' | 'out';
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SerialRow {
  id: string;
  serial_no: string;
  sku_id: string;
  location_id: string;
  batch_no: string;
  lpn_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SerialRow): SerialRecord {
  return {
    id: row.id,
    serialNo: row.serial_no,
    skuId: row.sku_id,
    locationId: row.location_id,
    batchNo: row.batch_no,
    lpnId: row.lpn_id,
    status: row.status === 'out' ? 'out' : 'in',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SerialView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.serialReceived: {
        const p = env.payload as SerialReceivedPayload;
        const existing = this.#byNoRaw(p.serialNo) ?? this.#byIdRaw(p.serialId);
        if (
          existing &&
          existing.status === 'in' &&
          existing.sku_id === p.skuId &&
          existing.location_id === p.locationId &&
          existing.batch_no === p.batchNo &&
          existing.lpn_id == null
        ) {
          return;
        }
        if (existing) {
          this.db
            .prepare(
              `UPDATE wms_serial
               SET sku_id = ?, location_id = ?, batch_no = ?, lpn_id = NULL, status = 'in', updated_at = ?
               WHERE workspace_id = ? AND id = ?`,
            )
            .run(p.skuId, p.locationId, p.batchNo, env.createdAt, this.workspaceId, existing.id);
          return;
        }
        this.db
          .prepare(
            `INSERT INTO wms_serial
               (id, workspace_id, serial_no, sku_id, location_id, batch_no, lpn_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'in', ?, ?)`,
          )
          .run(
            p.serialId,
            this.workspaceId,
            p.serialNo,
            p.skuId,
            p.locationId,
            p.batchNo,
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.serialIssued: {
        const p = env.payload as SerialIssuedPayload;
        const existing = this.#byNoRaw(p.serialNo) ?? this.#byIdRaw(p.serialId);
        if (!existing) return;
        if (existing.status === 'out' && existing.lpn_id == null) return;
        this.db
          .prepare(
            `UPDATE wms_serial SET status = 'out', lpn_id = NULL, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(env.createdAt, this.workspaceId, existing.id);
        break;
      }
      case WMS_EVENT_TYPES.serialMoved: {
        const p = env.payload as SerialMovedPayload;
        const existing = this.#byNoRaw(p.serialNo) ?? this.#byIdRaw(p.serialId);
        if (!existing) return;
        const setLpn = Object.hasOwn(p, 'lpnId');
        const nextLpn = setLpn ? (p.lpnId ?? null) : existing.lpn_id;
        if (
          existing.location_id === p.locationId &&
          existing.batch_no === p.batchNo &&
          existing.lpn_id == nextLpn
        ) {
          return;
        }
        this.db
          .prepare(
            `UPDATE wms_serial
             SET location_id = ?, batch_no = ?, lpn_id = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(p.locationId, p.batchNo, nextLpn, env.createdAt, this.workspaceId, existing.id);
        break;
      }
    }
  }

  byNo(serialNo: string): SerialRecord | undefined {
    const row = this.#byNoRaw(serialNo);
    return row ? rowToRecord(row) : undefined;
  }

  byId(id: string): SerialRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  list(filter: {
    skuId?: string;
    locationId?: string;
    lpnId?: string;
    status?: 'in' | 'out' | 'all';
  } = {}): SerialRecord[] {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (filter.skuId) {
      where.push('sku_id = ?');
      args.push(filter.skuId);
    }
    if (filter.locationId) {
      where.push('location_id = ?');
      args.push(filter.locationId);
    }
    if (filter.lpnId) {
      where.push('lpn_id = ?');
      args.push(filter.lpnId);
    }
    if (filter.status && filter.status !== 'all') {
      where.push('status = ?');
      args.push(filter.status);
    }
    const rows = this.db
      .prepare<unknown[], SerialRow>(
        `SELECT * FROM wms_serial WHERE ${where.join(' AND ')} ORDER BY serial_no`,
      )
      .all(...args) as unknown as SerialRow[];
    return rows.map(rowToRecord);
  }

  #byNoRaw(serialNo: string): SerialRow | undefined {
    return this.db
      .prepare<unknown[], SerialRow>(`SELECT * FROM wms_serial WHERE workspace_id = ? AND serial_no = ?`)
      .get(this.workspaceId, serialNo) as SerialRow | undefined;
  }

  #byIdRaw(id: string): SerialRow | undefined {
    return this.db
      .prepare<unknown[], SerialRow>(`SELECT * FROM wms_serial WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as SerialRow | undefined;
  }
}
