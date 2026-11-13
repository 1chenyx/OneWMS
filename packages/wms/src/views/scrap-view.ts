import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type ScrapCreatedPayload,
  type ScrapStateChangedPayload,
} from '../events/catalog.js';

/**
 * 报损投影——wms_scrap / wms_scrap_line 表。
 *
 * 纪律与兄弟投影同源：applyEvent 是两表唯一写路径，幂等（主表按业务 id 查重早退；
 * 行 id 五段派生 + ON CONFLICT 覆盖）。生命周期词汇固定：
 * created → confirmed / canceled（不进 Profile workflows）。
 * 扣减是普通 inventory.adjusted（reason: scrap:{单号}），由 InventoryView 应用。
 */

export interface ScrapRecord {
  readonly id: string;
  readonly scrapNo: string;
  /** 'created'（待确认）/ 'confirmed'（已确认）/ 'canceled'（已取消） */
  readonly state: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScrapLineRecord {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

interface ScrapRow {
  id: string;
  scrap_no: string;
  state: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface ScrapLineRow {
  sku_id: string;
  location_id: string;
  batch_no: string;
  quantity: number;
}

function rowToRecord(row: ScrapRow): ScrapRecord {
  return {
    id: row.id,
    scrapNo: row.scrap_no,
    state: row.state,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScrapView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.scrap.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.scrapCreated: {
        const p = env.payload as ScrapCreatedPayload;
        if (this.#byIdRaw(p.scrapId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_scrap (id, workspace_id, scrap_no, state, note, created_at, updated_at)
             VALUES (?, ?, ?, 'created', ?, ?, ?)`,
          )
          .run(p.scrapId, this.workspaceId, p.scrapNo, p.note ?? null, env.createdAt, env.createdAt);
        const insertLine = this.db.prepare(
          `INSERT INTO wms_scrap_line (id, workspace_id, scrap_id, sku_id, location_id, batch_no, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET quantity = excluded.quantity`,
        );
        for (const line of p.lines) {
          insertLine.run(
            `${p.scrapId}:${line.skuId}:${line.locationId}:${line.batchNo}`,
            this.workspaceId,
            p.scrapId,
            line.skuId,
            line.locationId,
            line.batchNo,
            line.quantity,
          );
        }
        break;
      }
      case WMS_EVENT_TYPES.scrapStateChanged: {
        const p = env.payload as ScrapStateChangedPayload;
        this.db
          .prepare(`UPDATE wms_scrap SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.scrapId);
        break;
      }
    }
  }

  /** 按报损单号查（业务键） */
  byNo(scrapNo: string): ScrapRecord | undefined {
    const row = this.db
      .prepare<unknown[], ScrapRow>(`SELECT * FROM wms_scrap WHERE workspace_id = ? AND scrap_no = ?`)
      .get(this.workspaceId, scrapNo) as ScrapRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部报损单（新单在前；同刻按单号稳定化） */
  list(): ScrapRecord[] {
    const rows = this.db
      .prepare<unknown[], ScrapRow>(
        `SELECT * FROM wms_scrap WHERE workspace_id = ? ORDER BY created_at DESC, scrap_no`,
      )
      .all(this.workspaceId) as unknown as ScrapRow[];
    return rows.map(rowToRecord);
  }

  /** 报损明细行（按 SKU/库位/批次排序，展示稳定） */
  lines(scrapId: string): ScrapLineRecord[] {
    const rows = this.db
      .prepare<unknown[], ScrapLineRow>(
        `SELECT sku_id, location_id, batch_no, quantity
         FROM wms_scrap_line WHERE workspace_id = ? AND scrap_id = ?
         ORDER BY sku_id, location_id, batch_no`,
      )
      .all(this.workspaceId, scrapId) as unknown as ScrapLineRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      quantity: r.quantity,
    }));
  }

  #byIdRaw(id: string): ScrapRow | undefined {
    return this.db
      .prepare<unknown[], ScrapRow>(`SELECT * FROM wms_scrap WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as ScrapRow | undefined;
  }
}
