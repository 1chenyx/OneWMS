import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type WarehouseCreatedPayload,
  type WarehouseUpdatedPayload,
} from '../events/catalog.js';

/**
 * 仓库投影（module.warehouse）。
 * 仓库不是库存桶：库存仍在库位上。本表只记仓库档案。
 */
export interface WarehouseRecord {
  readonly id: string;
  readonly warehouseCode: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WarehouseRow {
  id: string;
  warehouse_code: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: WarehouseRow): WarehouseRecord {
  return {
    id: row.id,
    warehouseCode: row.warehouse_code,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WarehouseView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.warehouseCreated: {
        const p = env.payload as WarehouseCreatedPayload;
        if (this.#byIdRaw(p.warehouseId)) return;
        this.db
          .prepare(
            `INSERT INTO wms_warehouse (id, workspace_id, warehouse_code, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(p.warehouseId, this.workspaceId, p.warehouseCode, p.name, env.createdAt, env.createdAt);
        break;
      }
      case WMS_EVENT_TYPES.warehouseUpdated: {
        const p = env.payload as WarehouseUpdatedPayload;
        this.db
          .prepare(
            `UPDATE wms_warehouse SET name = COALESCE(?, name), updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(p.name ?? null, env.createdAt, this.workspaceId, p.warehouseId);
        break;
      }
    }
  }

  byCode(warehouseCode: string): WarehouseRecord | undefined {
    const row = this.db
      .prepare<unknown[], WarehouseRow>(
        `SELECT * FROM wms_warehouse WHERE workspace_id = ? AND warehouse_code = ?`,
      )
      .get(this.workspaceId, warehouseCode) as WarehouseRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  byId(id: string): WarehouseRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  list(): WarehouseRecord[] {
    const rows = this.db
      .prepare<unknown[], WarehouseRow>(
        `SELECT * FROM wms_warehouse WHERE workspace_id = ? ORDER BY warehouse_code`,
      )
      .all(this.workspaceId) as unknown as WarehouseRow[];
    return rows.map(rowToRecord);
  }

  #byIdRaw(id: string): WarehouseRow | undefined {
    return this.db
      .prepare<unknown[], WarehouseRow>(`SELECT * FROM wms_warehouse WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as WarehouseRow | undefined;
  }
}
