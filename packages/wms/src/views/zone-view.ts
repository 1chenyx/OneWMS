import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type ZoneCreatedPayload, type ZoneUpdatedPayload } from '../events/catalog.js';
import type { ZoneKind } from '../zone-kinds.js';

/**
 * 库区投影（module.zone）。
 * 库区不是库存桶：库存仍在库位上。本表只记库区档案和分类。
 */
export interface ZoneRecord {
  readonly id: string;
  readonly zoneCode: string;
  readonly name: string;
  readonly kind: ZoneKind;
  /** 所属仓库。null = 未分仓 */
  readonly warehouseId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ZoneRow {
  id: string;
  zone_code: string;
  name: string;
  kind: string;
  warehouse_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ZoneRow): ZoneRecord {
  return {
    id: row.id,
    zoneCode: row.zone_code,
    name: row.name,
    kind: row.kind as ZoneKind,
    warehouseId: row.warehouse_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ZoneView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.zoneCreated: {
        const p = env.payload as ZoneCreatedPayload;
        if (this.#byIdRaw(p.zoneId)) return;
        this.db
          .prepare(
            `INSERT INTO wms_zone (id, workspace_id, zone_code, name, kind, warehouse_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.zoneId,
            this.workspaceId,
            p.zoneCode,
            p.name,
            p.kind,
            p.warehouseId ?? null,
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.zoneUpdated: {
        const p = env.payload as ZoneUpdatedPayload;
        const touchWarehouse = p.warehouseId !== undefined;
        this.db
          .prepare(
            `UPDATE wms_zone
             SET name = COALESCE(?, name),
                 kind = COALESCE(?, kind),
                 warehouse_id = CASE WHEN ? = 1 THEN ? ELSE warehouse_id END,
                 updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.kind ?? null,
            touchWarehouse ? 1 : 0,
            touchWarehouse ? p.warehouseId : null,
            env.createdAt,
            this.workspaceId,
            p.zoneId,
          );
        break;
      }
    }
  }

  byCode(zoneCode: string): ZoneRecord | undefined {
    const row = this.db
      .prepare<unknown[], ZoneRow>(`SELECT * FROM wms_zone WHERE workspace_id = ? AND zone_code = ?`)
      .get(this.workspaceId, zoneCode) as ZoneRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  byId(id: string): ZoneRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  list(): ZoneRecord[] {
    const rows = this.db
      .prepare<unknown[], ZoneRow>(`SELECT * FROM wms_zone WHERE workspace_id = ? ORDER BY zone_code`)
      .all(this.workspaceId) as unknown as ZoneRow[];
    return rows.map(rowToRecord);
  }

  #byIdRaw(id: string): ZoneRow | undefined {
    return this.db
      .prepare<unknown[], ZoneRow>(`SELECT * FROM wms_zone WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as ZoneRow | undefined;
  }
}
