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
  /** 条码（M18）：null = 未设置；同库唯一（扫码识读的物理标识） */
  readonly barcode: string | null;
  readonly name: string;
  /** 安全库存（M20）：低库存预警阈值；0 = 不预警。预警按可用量（余量−冻结）判定 */
  readonly reorderPoint: number;
  /**
   * 档案状态（A2 软停用）：'active' = 启用（缺省）；'archived' = 已停用。
   * 声明为可选——老事件重放/测试 fixture 字面量不破，消费端统一 `?? 'active'` 容忍。
   */
  readonly status?: string;
  /** 单位（A3）：数量单位（kg / 箱 / 件…）；null = 不显示 */
  readonly unit: string | null;
  readonly extData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SkuRow {
  id: string;
  sku_code: string;
  barcode: string | null;
  name: string;
  reorder_point: number;
  status: string;
  unit: string | null;
  ext_data: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SkuRow): SkuRecord {
  return {
    id: row.id,
    skuCode: row.sku_code,
    barcode: row.barcode,
    name: row.name,
    reorderPoint: row.reorder_point,
    status: row.status,
    unit: row.unit || null,
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
        // sku_code / barcode 唯一冲突不走 OR IGNORE 静默——那是业务冲突，必须显式炸出来
        this.db
          .prepare(
            `INSERT INTO wms_sku (id, workspace_id, sku_code, barcode, name, reorder_point, status, unit, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.skuId,
            this.workspaceId,
            p.skuCode,
            p.barcode ?? null,
            p.name,
            p.reorderPoint ?? 0,
            'active',
            p.unit ?? null,
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
               barcode = COALESCE(?, barcode),
               reorder_point = COALESCE(?, reorder_point),
               unit = COALESCE(?, unit),
               status = COALESCE(?, status),
               ext_data = COALESCE(?, ext_data),
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.barcode ?? null,
            p.reorderPoint ?? null,
            p.unit ?? null,
            p.status ?? null,
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

  /** 按条码查（M18：扫码枪识读入口——wms.sku.resolve 工具与唯一校验共用） */
  byBarcode(barcode: string): SkuRecord | undefined {
    const row = this.db
      .prepare<unknown[], SkuRow>(
        `SELECT * FROM wms_sku WHERE workspace_id = ? AND barcode = ?`,
      )
      .get(this.workspaceId, barcode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): SkuRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部 SKU，含已停用。界面清单用 listMatching 排除停用档 */
  list(): SkuRecord[] {
    return this.listMatching({ includeArchived: true });
  }

  /**
   * barcode 精确，q 对编码/名称/条码做包含匹配。
   * includeArchived 缺省 false：不带条码时排除已停用。扫码（带 barcode）由调用方传 true。
   */
  listMatching(opts: { barcode?: string; q?: string; includeArchived?: boolean }): SkuRecord[] {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (opts.barcode) {
      where.push('barcode = ?');
      args.push(opts.barcode);
    }
    if (!opts.includeArchived && !opts.barcode) {
      where.push(`(status = 'active' OR status IS NULL)`);
    }
    if (opts.q) {
      where.push(
        `(sku_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR IFNULL(barcode, '') LIKE ? ESCAPE '\\')`,
      );
      const pat = likeContains(opts.q);
      args.push(pat, pat, pat);
    }
    const rows = this.db
      .prepare<unknown[], SkuRow>(
        `SELECT * FROM wms_sku WHERE ${where.join(' AND ')} ORDER BY sku_code`,
      )
      .all(...args) as unknown as SkuRow[];
    return rows.map(rowToRecord);
  }

  #byIdRaw(id: string): SkuRow | undefined {
    return this.db
      .prepare<unknown[], SkuRow>(`SELECT * FROM wms_sku WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as SkuRow | undefined;
  }
}

function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
