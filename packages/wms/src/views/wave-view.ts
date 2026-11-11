import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type WaveCreatedPayload,
  type WaveStateChangedPayload,
} from '../events/catalog.js';

/**
 * 波次投影。wms_wave / wms_wave_order 只由 applyEvent 写。
 * 状态固定 open → picking / canceled，不进 Profile workflows。
 * 组波把多张已创建的出库单放进同一波；按这波拣货后再记下拣货单号。
 */

export interface WaveRecord {
  readonly id: string;
  readonly waveNo: string;
  /** open 待拣 / picking 已生成拣货单 / canceled 已取消 */
  readonly state: string;
  readonly note: string | null;
  readonly pickingNo: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WaveOrderRecord {
  readonly orderId: string;
  readonly orderNo: string;
}

interface WaveRow {
  id: string;
  wave_no: string;
  state: string;
  note: string | null;
  picking_no: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: WaveRow): WaveRecord {
  return {
    id: row.id,
    waveNo: row.wave_no,
    state: row.state,
    note: row.note,
    pickingNo: row.picking_no,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WaveView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.waveCreated: {
        const p = env.payload as WaveCreatedPayload;
        if (this.#byIdRaw(p.waveId)) return;
        this.db
          .prepare(
            `INSERT INTO wms_wave (id, workspace_id, wave_no, state, note, picking_no, created_at, updated_at)
             VALUES (?, ?, ?, 'open', ?, NULL, ?, ?)`,
          )
          .run(p.waveId, this.workspaceId, p.waveNo, p.note ?? null, env.createdAt, env.createdAt);
        const insertOrder = this.db.prepare(
          `INSERT INTO wms_wave_order (id, workspace_id, wave_id, order_id, order_no)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const order of p.orders) {
          insertOrder.run(`${p.waveId}:${order.orderId}`, this.workspaceId, p.waveId, order.orderId, order.orderNo);
        }
        break;
      }
      case WMS_EVENT_TYPES.waveStateChanged: {
        const p = env.payload as WaveStateChangedPayload;
        if (!this.#byIdRaw(p.waveId)) return;
        this.db
          .prepare(
            `UPDATE wms_wave SET state = ?, picking_no = COALESCE(?, picking_no), updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(p.to, p.pickingNo ?? null, env.createdAt, this.workspaceId, p.waveId);
        break;
      }
      default:
        break;
    }
  }

  byNo(waveNo: string): WaveRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM wms_wave WHERE workspace_id = ? AND wave_no = ?`)
      .get(this.workspaceId, waveNo) as WaveRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  byId(id: string): WaveRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  list(): WaveRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM wms_wave WHERE workspace_id = ? ORDER BY updated_at DESC, wave_no`)
      .all(this.workspaceId) as WaveRow[];
    return rows.map(rowToRecord);
  }

  orders(waveId: string): WaveOrderRecord[] {
    const rows = this.db
      .prepare(
        `SELECT order_id, order_no FROM wms_wave_order
         WHERE workspace_id = ? AND wave_id = ? ORDER BY order_no`,
      )
      .all(this.workspaceId, waveId) as { order_id: string; order_no: string }[];
    return rows.map((row) => ({ orderId: row.order_id, orderNo: row.order_no }));
  }

  /** 还没取消、并且包含这张出库单的波次。一张单同时只在一个这样的波次里。 */
  activeForOrder(orderId: string): WaveRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT w.* FROM wms_wave w
         JOIN wms_wave_order o ON o.workspace_id = w.workspace_id AND o.wave_id = w.id
         WHERE w.workspace_id = ? AND o.order_id = ? AND w.state != 'canceled'
         LIMIT 1`,
      )
      .get(this.workspaceId, orderId) as WaveRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 还开着、等整波拣货的那一波。 */
  openForOrder(orderId: string): WaveRecord | undefined {
    const wave = this.activeForOrder(orderId);
    return wave?.state === 'open' ? wave : undefined;
  }

  #byIdRaw(id: string): WaveRow | undefined {
    return this.db
      .prepare(`SELECT * FROM wms_wave WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as WaveRow | undefined;
  }
}
