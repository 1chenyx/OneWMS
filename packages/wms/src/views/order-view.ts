import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type OrderCreatedPayload,
  type OrderStateChangedPayload,
} from '../events/catalog.js';
import type { OrderDirection } from '../state/order-state-machine.js';
import { OrderStateConflictError } from '../errors.js';

/**
 * 单据投影（OrderView）——wms_order / wms_order_line 表的事件投影 + 查询。
 *
 * 冲突语义（DESIGN.md §8.3「唯一真冲突」）：
 * state_changed 事件的 from 与投影当前态不匹配 = 并发状态转移。
 * v1 直接抛 OrderStateConflictError 停下（仓储数据宁可停下来等人）；
 * 冲突队列 + UI 人工裁决是同步里程碑（M5）的实现项。
 */

export interface OrderRecord {
  readonly id: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  /** 状态词汇由流程配置定义（模块可贡献新状态）——投影只记事实（M8） */
  readonly state: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderLineRecord {
  readonly skuId: string;
  readonly quantity: number;
}

interface OrderRow {
  id: string;
  order_no: string;
  direction: string;
  state: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderLineRow {
  sku_id: string;
  quantity: number;
}

function rowToRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNo: row.order_no,
    direction: row.direction as OrderDirection,
    state: row.state,
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
            `INSERT INTO wms_order (id, workspace_id, order_no, direction, state, note, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'created', ?, '{}', ?, ?)`,
          )
          .run(p.orderId, this.workspaceId, p.orderNo, p.direction, p.note ?? null, env.createdAt, env.createdAt);
        const insertLine = this.db.prepare(
          `INSERT INTO wms_order_line (id, workspace_id, order_id, sku_id, quantity)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const line of p.lines) {
          // 行 id 由 orderId+skuId 派生：同一事件重放不产生重复行
          insertLine.run(`${p.orderId}:${line.skuId}`, this.workspaceId, p.orderId, line.skuId, line.quantity);
        }
        break;
      }
      case WMS_EVENT_TYPES.orderStateChanged: {
        const p = env.payload as OrderStateChangedPayload;
        const current = this.#byIdRaw(p.orderId);
        if (!current) {
          throw new OrderStateConflictError(p.orderNo, p.from, '（单据不存在）');
        }
        if (current.state !== p.from) {
          // 唯一真冲突：并发状态转移（§8.3）——v1 抛错，未来进冲突队列
          throw new OrderStateConflictError(p.orderNo, p.from, current.state);
        }
        this.db
          .prepare(`UPDATE wms_order SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
          .run(p.to, env.createdAt, this.workspaceId, p.orderId);
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

  /** 单据行（按事件中的行序——rowid 即插入序，重放后保持一致） */
  lines(orderId: string): OrderLineRecord[] {
    const rows = this.db
      .prepare<unknown[], OrderLineRow>(
        `SELECT sku_id, quantity FROM wms_order_line WHERE workspace_id = ? AND order_id = ? ORDER BY rowid`,
      )
      .all(this.workspaceId, orderId) as unknown as OrderLineRow[];
    return rows.map((r) => ({ skuId: r.sku_id, quantity: r.quantity }));
  }

  #byIdRaw(id: string): OrderRow | undefined {
    return this.db
      .prepare<unknown[], OrderRow>(`SELECT * FROM wms_order WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as OrderRow | undefined;
  }
}
