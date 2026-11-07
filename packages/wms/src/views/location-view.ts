import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type LocationCreatedPayload,
  type LocationUpdatedPayload,
} from '../events/catalog.js';

/**
 * 库位投影（LocationView，M10）——wms_location 表的事件投影 + 查询。
 *
 * 纪律与 SkuView 同源（§8「事件是唯一真相」）：
 *  - applyEvent 是本表唯一写路径，幂等（按事件携带的业务 id 查重早退）；
 *  - location_code 唯一冲突不走 OR IGNORE 静默——那是业务冲突，必须显式炸出来。
 * 默认库位 DEFAULT 是虚拟保留词（catalog.DEFAULT_LOCATION_ID），不落本表——
 * 「未指定库位」的语义归宿在工具层解析，投影只管实体库位。
 */

export interface LocationRecord {
  readonly id: string;
  readonly locationCode: string;
  readonly name: string;
  /** 所属仓库。null = 未分仓（模块关闭时的老库位都是这样） */
  readonly warehouseId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LocationRow {
  id: string;
  location_code: string;
  name: string;
  warehouse_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    locationCode: row.location_code,
    name: row.name,
    warehouseId: row.warehouse_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LocationView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.location.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.locationCreated: {
        const p = env.payload as LocationCreatedPayload;
        if (this.#byIdRaw(p.locationId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_location (id, workspace_id, location_code, name, warehouse_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.locationId,
            this.workspaceId,
            p.locationCode,
            p.name,
            p.warehouseId ?? null,
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.locationUpdated: {
        const p = env.payload as LocationUpdatedPayload;
        const touchWarehouse = p.warehouseId !== undefined;
        this.db
          .prepare(
            `UPDATE wms_location
             SET name = COALESCE(?, name),
                 warehouse_id = CASE WHEN ? = 1 THEN ? ELSE warehouse_id END,
                 updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            touchWarehouse ? 1 : 0,
            touchWarehouse ? p.warehouseId : null,
            env.createdAt,
            this.workspaceId,
            p.locationId,
          );
        break;
      }
    }
  }

  /** 按编码查（业务键；DEFAULT 虚拟桶不在本表，永远 miss） */
  byCode(locationCode: string): LocationRecord | undefined {
    const row = this.db
      .prepare<unknown[], LocationRow>(
        `SELECT * FROM wms_location WHERE workspace_id = ? AND location_code = ?`,
      )
      .get(this.workspaceId, locationCode) as LocationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): LocationRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部库位（按编码排序）。q 对编码和名称做包含匹配。 */
  list(q?: string): LocationRecord[] {
    const { where, args } = this.#match(q);
    const rows = this.db
      .prepare<unknown[], LocationRow>(`SELECT * FROM wms_location WHERE ${where} ORDER BY location_code`)
      .all(...args) as unknown as LocationRow[];
    return rows.map(rowToRecord);
  }

  /** 与 list 同一套条件，SQL LIMIT/OFFSET。 */
  listPage(opts: { q?: string; limit: number; offset: number }): { rows: LocationRecord[]; total: number } {
    const { where, args } = this.#match(opts.q);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM wms_location WHERE ${where}`).get(...args) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare<unknown[], LocationRow>(
        `SELECT * FROM wms_location WHERE ${where} ORDER BY location_code LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as LocationRow[];
    return { rows: rows.map(rowToRecord), total };
  }

  #match(q?: string): { where: string; args: unknown[] } {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (q) {
      where.push(`(location_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`);
      const pat = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      args.push(pat, pat);
    }
    return { where: where.join(' AND '), args };
  }

  #byIdRaw(id: string): LocationRow | undefined {
    return this.db
      .prepare<unknown[], LocationRow>(`SELECT * FROM wms_location WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as LocationRow | undefined;
  }
}
