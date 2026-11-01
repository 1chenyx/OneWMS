import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  DEFAULT_BATCH_NO,
  DEFAULT_LOCATION_ID,
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
  /** 行目标库位（M10）：收货上架/发货扣减的维度；老事件兜底 DEFAULT */
  readonly locationId: string;
  /** 行批次（M11）：入库声明/出库扣减的批次桶；老事件兜底 DEFAULT 虚拟批次 */
  readonly batchNo: string;
  /** 行声明的批次效期（M11，仅入库行有意义；未声明为 null） */
  readonly batchExpiryDate: string | null;
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
  location_id: string;
  batch_no: string;
  batch_expiry_date: string | null;
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
        `SELECT sku_id, location_id, batch_no, batch_expiry_date, quantity FROM wms_order_line WHERE workspace_id = ? AND order_id = ? ORDER BY rowid`,
      )
      .all(this.workspaceId, orderId) as unknown as OrderLineRow[];
    return rows.map((r) => ({
      skuId: r.sku_id,
      locationId: r.location_id,
      batchNo: r.batch_no,
      batchExpiryDate: r.batch_expiry_date,
      quantity: r.quantity,
    }));
  }

  #byIdRaw(id: string): OrderRow | undefined {
    return this.db
      .prepare<unknown[], OrderRow>(`SELECT * FROM wms_order WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as OrderRow | undefined;
  }
}
