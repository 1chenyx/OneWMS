import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
  WMS_EVENT_TYPES,
  type OrderConflictResolvedPayload,
  type OrderCreatedPayload,
  type OrderStateChangedPayload,
} from '../events/catalog.js';
import type { OrderDirection } from '../state/order-state-machine.js';

/**
 * 单据投影（OrderView）——wms_order / wms_order_line 表的事件投影 + 查询。
 *
 * 冲突语义（DESIGN.md §8.3）：state_changed 的 from 与当前态不符时不改状态、
 * 写入 wms_order_conflict，追账继续。接受/驳回是后续事件，重放可重建队列。
 */

export interface OrderRecord {
  readonly id: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  /** 状态词汇由流程配置定义（模块可贡献新状态）——投影只记事实（M8） */
  readonly state: string;
  /** 往来单位 id（M21）：入库=供应商 / 出库=客户；null = 未关联 */
  readonly partnerId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderConflictRecord {
  readonly eventId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  readonly fromState: string;
  readonly toState: string;
  readonly actualState: string;
  readonly status: 'open' | 'dismissed' | 'accepted';
  readonly createdAt: string;
}

export interface OrderLineRecord {
  readonly skuId: string;
  /** 行目标库位（M10）：收货上架/发货扣减的维度；老事件兜底 DEFAULT */
  readonly locationId: string;
  /** 行批次（M11）：入库声明/出库扣减的批次桶；老事件兜底 DEFAULT 虚拟批次 */
  readonly batchNo: string;
  /** 行声明的批次效期（M11，仅入库行有意义；未声明为 null） */
  readonly batchExpiryDate: string | null;
  readonly quantity: number;
  /** 已入账净量。null = 没记过短收短发（按订单数量） */
  readonly fulfilledQty: number | null;
}

interface OrderRow {
  id: string;
  order_no: string;
  direction: string;
  state: string;
  partner_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderLineRow {
  sku_id: string;
  location_id: string;
  batch_no: string;
  batch_expiry_date: string | null;
  quantity: number;
  fulfilled_qty: number | null;
}

interface ConflictRow {
  event_id: string;
  order_id: string;
  order_no: string;
  direction: string;
  from_state: string;
  to_state: string;
  actual_state: string;
  status: string;
  created_at: string;
}

function conflictToRecord(row: ConflictRow): OrderConflictRecord {
  return {
    eventId: row.event_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    direction: row.direction as OrderDirection,
    fromState: row.from_state,
    toState: row.to_state,
    actualState: row.actual_state,
    status: row.status as OrderConflictRecord['status'],
    createdAt: row.created_at,
  };
}

function rowToRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNo: row.order_no,
    direction: row.direction as OrderDirection,
    state: row.state,
    partnerId: row.partner_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OrderView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.order.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.orderCreated: {
        const p = env.payload as OrderCreatedPayload;
        if (this.#byIdRaw(p.orderId)) return; // 已应用过（幂等）
        this.db
          .prepare(
            `INSERT INTO wms_order (id, workspace_id, order_no, direction, state, partner_id, note, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'created', ?, ?, '{}', ?, ?)`,
          )
          .run(p.orderId, this.workspaceId, p.orderNo, p.direction, p.partnerId ?? null, p.note ?? null, env.createdAt, env.createdAt);
        const insertLine = this.db.prepare(
          `INSERT INTO wms_order_line (id, workspace_id, order_id, sku_id, location_id, batch_no, batch_expiry_date, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const line of p.lines) {
          // 行 id 由 orderId+skuId+locationId+batchNo 四段派生（M11）：同一事件重放
          // 不产生重复行，且同单同 SKU 可分多库位/多批次多行（唯一约束同四段）
          const locationId = line.locationId ?? DEFAULT_LOCATION_ID;
          const batchNo = line.batchNo ?? DEFAULT_BATCH_NO;
          insertLine.run(
            `${p.orderId}:${line.skuId}:${locationId}:${batchNo}`,
            this.workspaceId,
            p.orderId,
            line.skuId,
            locationId,
            batchNo,
            line.batchExpiryDate ?? null,
            line.quantity,
          );
        }
        break;
      }
      case WMS_EVENT_TYPES.orderStateChanged: {
        const p = env.payload as OrderStateChangedPayload;
        const current = this.#byIdRaw(p.orderId);
        if (!current || current.state !== p.from) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO wms_order_conflict
                 (event_id, workspace_id, order_id, order_no, direction, from_state, to_state, actual_state, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            )
            .run(
              env.eventId,
              this.workspaceId,
              p.orderId,
              p.orderNo,
              p.direction,
              p.from,
              p.to,
              current?.state ?? '（单据不存在）',
              env.createdAt,
            );
          break;
        }
        this.db
          .prepare(`UPDATE wms_order SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.orderId);
        if (p.fulfillments?.length) {
          const updateLine = this.db.prepare(
            `UPDATE wms_order_line SET fulfilled_qty = ?
             WHERE workspace_id = ? AND order_id = ? AND sku_id = ? AND location_id = ? AND batch_no = ?`,
          );
          for (const line of p.fulfillments) {
            updateLine.run(
              line.quantity,
              this.workspaceId,
              p.orderId,
              line.skuId,
              line.locationId ?? DEFAULT_LOCATION_ID,
              line.batchNo ?? DEFAULT_BATCH_NO,
            );
          }
        }
        break;
      }
      case WMS_EVENT_TYPES.orderConflictDismissed:
      case WMS_EVENT_TYPES.orderConflictAccepted: {
        const p = env.payload as OrderConflictResolvedPayload;
        const status = env.type === WMS_EVENT_TYPES.orderConflictAccepted ? 'accepted' : 'dismissed';
        this.db
          .prepare(
            `UPDATE wms_order_conflict SET status = ? WHERE workspace_id = ? AND event_id = ? AND status = 'open'`,
          )
          .run(status, this.workspaceId, p.eventId);
        break;
      }
    }
  }

  /** 按单据号查（业务键） */
  byNo(orderNo: string): OrderRecord | undefined {
    const row = this.db
      .prepare<unknown[], OrderRow>(`SELECT * FROM wms_order WHERE workspace_id = ? AND order_no = ?`)
      .get(this.workspaceId, orderNo) as OrderRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): OrderRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按方向列出单据（in / out） */
  list(direction?: OrderDirection): OrderRecord[] {
    const rows = direction
      ? (this.db
          .prepare<unknown[], OrderRow>(
            `SELECT * FROM wms_order WHERE workspace_id = ? AND direction = ? ORDER BY order_no`,
          )
          .all(this.workspaceId, direction) as unknown as OrderRow[])
      : (this.db
          .prepare<unknown[], OrderRow>(`SELECT * FROM wms_order WHERE workspace_id = ? ORDER BY order_no`)
          .all(this.workspaceId) as unknown as OrderRow[]);
    return rows.map(rowToRecord);
  }

  /**
   * 单据分页查询（AI 工具 wms.order.query 的数据源）：
   * direction / state 精确过滤，from/to 为创建时间 ISO 闭区间。
   * 最新在前（created_at DESC）；total 与行同条件——分页壳计算 hasMore 的依据。
   */
  listPage(opts: {
    direction?: OrderDirection;
    state?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): { rows: OrderRecord[]; total: number } {
    const where: string[] = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (opts.direction) {
      where.push('direction = ?');
      args.push(opts.direction);
    }
    if (opts.state) {
      where.push('state = ?');
      args.push(opts.state);
    }
    if (opts.from) {
      where.push('created_at >= ?');
      args.push(opts.from);
    }
    if (opts.to) {
      where.push('created_at <= ?');
      args.push(opts.to);
    }
    const whereSql = where.join(' AND ');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM wms_order WHERE ${whereSql}`)
        .get(...args) as { total: number }
    ).total;
    const rows = this.db
      .prepare<unknown[], OrderRow>(
        `SELECT * FROM wms_order WHERE ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as OrderRow[];
    return { rows: rows.map(rowToRecord), total };
  }

  /** 单据行（按事件中的行序——rowid 即插入序，重放后保持一致） */
  lines(orderId: string): OrderLineRecord[] {
    const rows = this.db
      .prepare<unknown[], OrderLineRow>(
        `SELECT sku_id, location_id, batch_no, batch_expiry_date, quantity, fulfilled_qty FROM wms_order_line WHERE workspace_id = ? AND order_id = ? ORDER BY rowid`,
      )
      .all(this.workspaceId, orderId) as unknown as OrderLineRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      quantity: r.quantity,
      fulfilledQty: r.fulfilled_qty,
    }));
  }

  listConflicts(status: OrderConflictRecord['status'] = 'open'): OrderConflictRecord[] {
    const rows = this.db
      .prepare<unknown[], ConflictRow>(
        `SELECT * FROM wms_order_conflict WHERE workspace_id = ? AND status = ? ORDER BY created_at, event_id`,
      )
      .all(this.workspaceId, status) as unknown as ConflictRow[];
    return rows.map(conflictToRecord);
  }

  conflictByEventId(eventId: string): OrderConflictRecord | undefined {
    const row = this.db
      .prepare<unknown[], ConflictRow>(
        `SELECT * FROM wms_order_conflict WHERE workspace_id = ? AND event_id = ?`,
      )
      .get(this.workspaceId, eventId) as ConflictRow | undefined;
    return row ? conflictToRecord(row) : undefined;
  }

  #byIdRaw(id: string): OrderRow | undefined {
    return this.db
      .prepare<unknown[], OrderRow>(`SELECT * FROM wms_order WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as OrderRow | undefined;
  }
}
