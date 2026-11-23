import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type ProductCreatedPayload,
  type ProductSpecDim,
  type ProductUpdatedPayload,
} from '../events/catalog.js';

/**
 * 商品投影（ProductView，多规格 SPU 层）——wms_product 表的事件投影 + 查询。
 *
 * 纪律（与 SkuView / PartnerView 同款）：
 *  - applyEvent 是本表唯一写路径，幂等（按事件携带的 productId 查重早退）；
 *  - product.updated 字段级 LWW 由全序重放天然实现（COALESCE 未传保持不变）；
 *  - 商品不参与库存维度——规格组合在 wms_sku 上（product_id + variant_attrs），
 *    「商品下有哪些规格」走 SkuView.byProduct，不在本投影联查。
 */

export interface ProductRecord {
  readonly id: string;
  readonly productCode: string;
  readonly name: string;
  /** 规格维度定义（顺序即展示序）；空数组 = 未声明维度 */
  readonly specDims: readonly ProductSpecDim[];
  /** 档案状态（A2 软停用先例）：active = 启用；archived = 已停用 */
  readonly status: string;
  readonly extData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProductRow {
  id: string;
  product_code: string;
  name: string;
  spec_dims: string;
  status: string;
  ext_data: string;
  created_at: string;
  updated_at: string;
}

function parseDims(raw: string): readonly ProductSpecDim[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ProductSpecDim[]) : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    productCode: row.product_code,
    name: row.name,
    specDims: parseDims(row.spec_dims),
    status: row.status,
    extData: JSON.parse(row.ext_data) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProductView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.product.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.productCreated: {
        const p = env.payload as ProductCreatedPayload;
        if (this.#byIdRaw(p.productId)) return; // 已应用过（幂等）
        // product_code 唯一冲突不走 OR IGNORE 静默——业务冲突必须显式炸出来
        this.db
          .prepare(
            `INSERT INTO wms_product (id, workspace_id, product_code, name, spec_dims, status, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.productId,
            this.workspaceId,
            p.productCode,
            p.name,
            JSON.stringify(p.specDims ?? []),
            'active',
            JSON.stringify(p.extData ?? {}),
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.productUpdated: {
        const p = env.payload as ProductUpdatedPayload;
        this.db
          .prepare(
            `UPDATE wms_product SET
               name = COALESCE(?, name),
               spec_dims = COALESCE(?, spec_dims),
               status = COALESCE(?, status),
               ext_data = COALESCE(?, ext_data),
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.specDims === undefined ? null : JSON.stringify(p.specDims),
            p.status ?? null,
            p.extData === undefined ? null : JSON.stringify(p.extData),
            env.createdAt,
            this.workspaceId,
            p.productId,
          );
        break;
      }
    }
  }

  /** 按编码查（业务键） */
  byCode(productCode: string): ProductRecord | undefined {
    const row = this.db
      .prepare<unknown[], ProductRow>(
        `SELECT * FROM wms_product WHERE workspace_id = ? AND product_code = ?`,
      )
      .get(this.workspaceId, productCode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查（SKU 联查展示用） */
  byId(id: string): ProductRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 启用中的商品（选择器/清单缺省口径）；含停用用 listMatching({ includeArchived: true }) */
  list(): ProductRecord[] {
    return this.listMatching({});
  }

  /** q 对编码和名称做包含匹配；includeArchived 缺省 false（排除已停用档） */
  listMatching(opts: { q?: string; includeArchived?: boolean }): ProductRecord[] {
    const { where, args } = this.#match(opts);
    const rows = this.db
      .prepare<unknown[], ProductRow>(
        `SELECT * FROM wms_product WHERE ${where} ORDER BY product_code`,
      )
      .all(...args) as unknown as ProductRow[];
    return rows.map(rowToRecord);
  }

  /** 与 listMatching 同一套条件，SQL LIMIT/OFFSET。total 用同一 WHERE。 */
  listMatchingPage(opts: {
    q?: string;
    includeArchived?: boolean;
    limit: number;
    offset: number;
  }): { rows: ProductRecord[]; total: number } {
    const { where, args } = this.#match(opts);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM wms_product WHERE ${where}`).get(...args) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare<unknown[], ProductRow>(
        `SELECT * FROM wms_product WHERE ${where} ORDER BY product_code LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as ProductRow[];
    return { rows: rows.map(rowToRecord), total };
  }

  #match(opts: { q?: string; includeArchived?: boolean }): { where: string; args: unknown[] } {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (!opts.includeArchived) {
      where.push(`(status = 'active' OR status IS NULL)`);
    }
    if (opts.q) {
      where.push(`(product_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`);
      const pat = `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      args.push(pat, pat);
    }
    return { where: where.join(' AND '), args };
  }

  #byIdRaw(id: string): ProductRow | undefined {
    return this.db
      .prepare<unknown[], ProductRow>(`SELECT * FROM wms_product WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as ProductRow | undefined;
  }
}
