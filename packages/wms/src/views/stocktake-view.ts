import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type StocktakeCreatedPayload,
  type StocktakeCountedPayload,
  type StocktakeStateChangedPayload,
} from '../events/catalog.js';
import type { InventoryView } from './inventory-view.js';

/**
 * 盘点投影（StocktakeView，M17）——wms_stocktake / wms_stocktake_line 表。
 *
 * 纪律与兄弟投影同源（§8「事件是唯一真相」）：
 *  - applyEvent 是两表唯一写路径，幂等（主表按业务 id 查重早退；行表
 *    id 四段派生 + ON CONFLICT 覆盖）；
 *  - 事件不携带账面快照（禁冗余）——expected_qty 由本投影在应用
 *    created 事件时查库存汇总（InventoryView，同一追账事务内已应用到
 *    本事件之前的全部事件）现值生成。全序重放天然确定性：重放时同一
 *    位置的库存状态与原运行时一致，快照可逐字节重建；
 *  - counted 事件 upsert：预生成行覆盖实盘数（同桶重盘，后到者胜）；
 *    范围内新桶（创建时账面为零或当时尚不存在）补行，expected 取
 *    应用时点现值——两次盘点之间库存有动，快照如实记录当时账面。
 *
 * 生命周期词汇固定：created → closed / canceled（不进 Profile workflows，
 * 盘点生命周期不因配置而变）；state_changed 投影只记事实（from 的一致性
 * 由命令侧 StocktakeNotOpenError 守卫——单写者本地流程，无并发真冲突面）。
 */

export interface StocktakeRecord {
  readonly id: string;
  readonly stocktakeNo: string;
  /** 'created'（盘点中）/ 'closed'（已关单）/ 'canceled'（已取消） */
  readonly state: string;
  /** 盘点范围：库位 id 列表；null = 全场 */
  readonly locationIds: string[] | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StocktakeLineRecord {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  /** 账面快照（created 时点 / 后补行取 counted 时点现值） */
  readonly expectedQty: number;
  /** 实盘数；NULL = 未盘 */
  readonly countedQty: number | null;
}

interface StocktakeRow {
  id: string;
  stocktake_no: string;
  state: string;
  location_ids: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface StocktakeLineRow {
  sku_id: string;
  location_id: string;
  batch_no: string;
  expected_qty: number;
  counted_qty: number | null;
}

function rowToRecord(row: StocktakeRow): StocktakeRecord {
  return {
    id: row.id,
    stocktakeNo: row.stocktake_no,
    state: row.state,
    locationIds: row.location_ids ? (JSON.parse(row.location_ids) as string[]) : null,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StocktakeView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    private readonly inventory: InventoryView,
  ) {}

  /** 幂等应用一条 wms.stocktake.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.stocktakeCreated: {
        const p = env.payload as StocktakeCreatedPayload;
        if (this.#byIdRaw(p.stocktakeId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_stocktake (id, workspace_id, stocktake_no, state, location_ids, note, created_at, updated_at)
             VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
          )
          .run(
            p.stocktakeId,
            this.workspaceId,
            p.stocktakeNo,
            p.locationIds ? JSON.stringify(p.locationIds) : null,
            p.note ?? null,
            env.createdAt,
            env.createdAt,
          );
        // 账面快照行：范围内余量 > 0 的桶（零余量桶无盘点意义——货架上真有货
        // 而账面为零，count 工具会补行记盘盈）。scope 过滤 + 现值快照。
        const insertLine = this.db.prepare(
          `INSERT INTO wms_stocktake_line (id, workspace_id, stocktake_id, sku_id, location_id, batch_no, expected_qty, counted_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        for (const r of this.inventory.list()) {
          if (r.quantity <= 0) continue;
          if (p.locationIds && !p.locationIds.includes(r.locationId)) continue;
          insertLine.run(
            `${p.stocktakeId}:${r.skuId}:${r.locationId}:${r.batchNo}`,
            this.workspaceId,
            p.stocktakeId,
            r.skuId,
            r.locationId,
            r.batchNo,
            r.quantity,
          );
        }
        break;
      }
      case WMS_EVENT_TYPES.stocktakeCounted: {
        const p = env.payload as StocktakeCountedPayload;
        // 新桶补行：expected 取应用时点账面现值（范围内 count 之前账面为零、
        // 或创建后才入库的桶）；已有行只覆盖实盘数（同桶重盘，后到者胜）。
        this.db
          .prepare(
            `INSERT INTO wms_stocktake_line (id, workspace_id, stocktake_id, sku_id, location_id, batch_no, expected_qty, counted_qty)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET counted_qty = excluded.counted_qty`,
          )
          .run(
            `${p.stocktakeId}:${p.skuId}:${p.locationId}:${p.batchNo}`,
            this.workspaceId,
            p.stocktakeId,
            p.skuId,
            p.locationId,
            p.batchNo,
            this.inventory.quantityOf(p.skuId, p.locationId, p.batchNo),
            p.countedQty,
          );
        break;
      }
      case WMS_EVENT_TYPES.stocktakeStateChanged: {
        const p = env.payload as StocktakeStateChangedPayload;
        this.db
          .prepare(`UPDATE wms_stocktake SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.stocktakeId);
        break;
      }
    }
  }

  /** 按盘点单号查（业务键） */
  byNo(stocktakeNo: string): StocktakeRecord | undefined {
    const row = this.db
      .prepare<unknown[], StocktakeRow>(
        `SELECT * FROM wms_stocktake WHERE workspace_id = ? AND stocktake_no = ?`,
      )
      .get(this.workspaceId, stocktakeNo) as StocktakeRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): StocktakeRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部盘点单（新单在前；同刻按单号稳定化） */
  list(): StocktakeRecord[] {
    const rows = this.db
      .prepare<unknown[], StocktakeRow>(
        `SELECT * FROM wms_stocktake WHERE workspace_id = ? ORDER BY created_at DESC, stocktake_no`,
      )
      .all(this.workspaceId) as unknown as StocktakeRow[];
    return rows.map(rowToRecord);
  }

  /** 盘点明细行（按 SKU/库位/批次排序，展示稳定） */
  lines(stocktakeId: string): StocktakeLineRecord[] {
    const rows = this.db
      .prepare<unknown[], StocktakeLineRow>(
        `SELECT sku_id, location_id, batch_no, expected_qty, counted_qty
         FROM wms_stocktake_line WHERE workspace_id = ? AND stocktake_id = ?
         ORDER BY sku_id, location_id, batch_no`,
      )
      .all(this.workspaceId, stocktakeId) as unknown as StocktakeLineRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      expectedQty: r.expected_qty,
      countedQty: r.counted_qty,
    }));
  }

  /** 行进度统计（清单页进度条 + close 守卫「全部行必须已盘」的数据源） */
  stats(stocktakeId: string): { lineCount: number; countedCount: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(counted_qty) AS counted
         FROM wms_stocktake_line WHERE workspace_id = ? AND stocktake_id = ?`,
      )
      .get(this.workspaceId, stocktakeId) as { total: number; counted: number };
    return { lineCount: row.total, countedCount: row.counted };
  }

  #byIdRaw(id: string): StocktakeRow | undefined {
    return this.db
      .prepare<unknown[], StocktakeRow>(`SELECT * FROM wms_stocktake WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as StocktakeRow | undefined;
  }
}
