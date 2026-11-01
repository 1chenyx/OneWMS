import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type LocationCreatedPayload } from '../events/catalog.js';

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
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LocationRow {
  id: string;
  location_code: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    locationCode: row.location_code,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LocationView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.location.created 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    if (env.type !== WMS_EVENT_TYPES.locationCreated) return;
    const p = env.payload as LocationCreatedPayload;
    if (this.#byIdRaw(p.locationId)) return; // 已应用过（幂等）
    this.db
      .prepare(
        `INSERT INTO wms_location (id, workspace_id, location_code, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.locationId, this.workspaceId, p.locationCode, p.name, env.createdAt, env.createdAt);
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

  /** 全部库位（v1 无分页；按编码排序） */
  list(): LocationRecord[] {
    const rows = this.db
      .prepare<unknown[], LocationRow>(
        `SELECT * FROM wms_location WHERE workspace_id = ? ORDER BY location_code`,
      )
      .all(this.workspaceId) as unknown as LocationRow[];
    return rows.map(rowToRecord);
  }

  #byIdRaw(id: string): LocationRow | undefined {
    return this.db
      .prepare<unknown[], LocationRow>(`SELECT * FROM wms_location WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as LocationRow | undefined;
  }
}
