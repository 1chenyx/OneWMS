import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type SkuCreatedPayload, type SkuUpdatedPayload } from '../events/catalog.js';

/**
 * SKU 投影（SkuView）——wms_sku 表的事件投影 + 查询。
 *
 * 纪律（DESIGN.md §8「事件是唯一真相」）：
 *  - applyEvent 是本表唯一写路径，幂等（按事件携带的业务 id 查重早退）；
 *  - sku.updated 的字段级 LWW 由全序重放天然实现——后应用者覆盖先应用者，
 *    输的编辑留在事件历史里可追溯，不弹窗（§8.3）。
 */

export interface SkuRecord {
  readonly id: string;
  readonly skuCode: string;
  readonly name: string;
  readonly extData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SkuRow {
  id: string;
  sku_code: string;
  name: string;
  ext_data: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SkuRow): SkuRecord {
  return {
    id: row.id,
    skuCode: row.sku_code,
    name: row.name,
    extData: JSON.parse(row.ext_data) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SkuView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.sku.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.skuCreated: {
        const p = env.payload as SkuCreatedPayload;
        if (this.#byIdRaw(p.skuId)) return; // 已应用过（幂等）
        // sku_code 唯一冲突不走 OR IGNORE 静默——那是业务冲突，必须显式炸出来
        this.db
          .prepare(
            `INSERT INTO wms_sku (id, workspace_id, sku_code, name, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.skuId,
            this.workspaceId,
            p.skuCode,
            p.name,
            JSON.stringify(p.extData ?? {}),
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.skuUpdated: {
        const p = env.payload as SkuUpdatedPayload;
        this.db
          .prepare(
            `UPDATE wms_sku SET
               name = COALESCE(?, name),
               ext_data = COALESCE(?, ext_data),
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.extData === undefined ? null : JSON.stringify(p.extData),
            env.createdAt,
            this.workspaceId,
            p.skuId,
          );
        break;
      }
    }
  }

  /** 按编码查（业务键） */
  byCode(skuCode: string): SkuRecord | undefined {
    const row = this.db
      .prepare<unknown[], SkuRow>(
        `SELECT * FROM wms_sku WHERE workspace_id = ? AND sku_code = ?`,
      )
      .get(this.workspaceId, skuCode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): SkuRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部 SKU（v1 无分页；数据量守门是未来投影优化的事） */
  list(): SkuRecord[] {
    const rows = this.db
      .prepare<unknown[], SkuRow>(`SELECT * FROM wms_sku WHERE workspace_id = ? ORDER BY sku_code`)
      .all(this.workspaceId) as unknown as SkuRow[];
    return rows.map(rowToRecord);
  }

  #byIdRaw(id: string): SkuRow | undefined {
    return this.db
      .prepare<unknown[], SkuRow>(`SELECT * FROM wms_sku WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as SkuRow | undefined;
  }
}
