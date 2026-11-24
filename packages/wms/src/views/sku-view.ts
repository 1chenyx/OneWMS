import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type SkuCreatedPayload,
  type SkuPackageDef,
  type SkuUpdatedPayload,
} from '../events/catalog.js';

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
  /** 单位（A3）：数量单位（kg / 箱 / 件…）；null = 不显示。换算语境下是基本单位 */
  readonly unit: string | null;
  /** unit 是从所属商品继承来的（SKU 自己没设）；改商品的默认单位会跟着变 */
  readonly unitInherited: boolean;
  /**
   * 包装单位（换算）：[{unit:'箱', ratio:24}]——1 箱 = 24 个基本单位；
   * null = 无包装单位（单据只能按基本单位录）。空数组读取层归一成 null。
   */
  readonly packages: readonly SkuPackageDef[] | null;
  /** packages 是从所属商品继承来的（SKU 自己没定义）；改商品的默认包装会跟着变 */
  readonly packagesInherited: boolean;
  /** 按序列号管理（module.serial）。老数据缺省否 */
  readonly serialTracked: boolean;
  /** 所属商品 id（多规格）：null = 独立商品（不挂 SPU，存量/单规格） */
  readonly productId: string | null;
  /** 规格组合（多规格）：null = 未声明；如 {"颜色":"红","尺码":"S"} */
  readonly variantAttrs: Record<string, string> | null;
  readonly extData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SkuRow {
  id: string;
  sku_code: string;
  barcode: string | null;
  name: string;
  product_id: string | null;
  variant_attrs: string | null;
  reorder_point: number;
  status: string;
  unit: string | null;
  packages: string | null;
  /** LEFT JOIN wms_product 带出的商品默认值（继承用）；没挂商品或商品没设 = null */
  product_unit: string | null;
  product_packages: string | null;
  serial_tracked: number;
  ext_data: string;
  created_at: string;
  updated_at: string;
}

/** 空对象 = 清空（换挂到无维度商品时事件写 {}），读取层归一成 null */
function parseVariantAttrs(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, string>;
  return Object.keys(parsed).length === 0 ? null : parsed;
}

/** 空数组 = 清空（sku.update 传 [] 时事件写 []），读取层归一成 null */
function parsePackages(raw: string): readonly SkuPackageDef[] | null {
  const parsed = JSON.parse(raw) as SkuPackageDef[];
  return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
}

/**
 * 读取层继承：SKU 自己没存的单位 / 包装（列 NULL）回落到所属商品的默认值。
 * 读取层解析而不是建 SKU 时抄一份——改商品的默认值，所有继承的 SKU 立即生效。
 * packages 列存过 '[]' = 这个 SKU 明确不要包装（覆盖成「无」），不回落。
 */
function rowToRecord(row: SkuRow): SkuRecord {
  const productPackages = row.product_packages ? parsePackages(row.product_packages) : null;
  const ownPackages = row.packages === null ? undefined : parsePackages(row.packages);
  return {
    id: row.id,
    skuCode: row.sku_code,
    barcode: row.barcode,
    name: row.name,
    productId: row.product_id ?? null,
    variantAttrs: parseVariantAttrs(row.variant_attrs),
    reorderPoint: row.reorder_point,
    status: row.status,
    unit: row.unit || row.product_unit || null,
    unitInherited: !row.unit && Boolean(row.product_unit),
    packages: ownPackages === undefined ? productPackages : ownPackages,
    packagesInherited: ownPackages === undefined && productPackages !== null,
    serialTracked: row.serial_tracked === 1,
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
            `INSERT INTO wms_sku (id, workspace_id, sku_code, barcode, name, product_id, variant_attrs, reorder_point, status, unit, packages, serial_tracked, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.skuId,
            this.workspaceId,
            p.skuCode,
            p.barcode ?? null,
            p.name,
            p.productId ?? null,
            p.variantAttrs === undefined ? null : JSON.stringify(p.variantAttrs),
            p.reorderPoint ?? 0,
            'active',
            p.unit ?? null,
            p.packages === undefined ? null : JSON.stringify(p.packages),
            p.serialTracked === true ? 1 : 0,
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
               product_id = COALESCE(?, product_id),
               variant_attrs = COALESCE(?, variant_attrs),
               reorder_point = COALESCE(?, reorder_point),
               unit = COALESCE(?, unit),
               packages = COALESCE(?, packages),
               serial_tracked = COALESCE(?, serial_tracked),
               status = COALESCE(?, status),
               ext_data = COALESCE(?, ext_data),
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.barcode ?? null,
            p.productId ?? null,
            p.variantAttrs === undefined ? null : JSON.stringify(p.variantAttrs),
            p.reorderPoint ?? null,
            p.unit ?? null,
            p.packages === undefined ? null : JSON.stringify(p.packages),
            p.serialTracked === undefined ? null : p.serialTracked ? 1 : 0,
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
      .prepare<unknown[], SkuRow>(`${SELECT_WITH_PRODUCT} WHERE s.workspace_id = ? AND s.sku_code = ?`)
      .get(this.workspaceId, skuCode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按条码查（M18：扫码枪识读入口——wms.sku.resolve 工具与唯一校验共用） */
  byBarcode(barcode: string): SkuRecord | undefined {
    const row = this.db
      .prepare<unknown[], SkuRow>(`${SELECT_WITH_PRODUCT} WHERE s.workspace_id = ? AND s.barcode = ?`)
      .get(this.workspaceId, barcode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查 */
  byId(id: string): SkuRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * 某商品下的全部规格 SKU（多规格下钻）。含已停用——组合唯一性守卫
   * 要看见同商品下的所有行（工具层校验用），界面过滤交给消费端。
   */
  byProduct(productId: string): SkuRecord[] {
    const rows = this.db
      .prepare<unknown[], SkuRow>(
        `${SELECT_WITH_PRODUCT} WHERE s.workspace_id = ? AND s.product_id = ? ORDER BY s.sku_code`,
      )
      .all(this.workspaceId, productId) as unknown as SkuRow[];
    return rows.map(rowToRecord);
  }

  /** 全部 SKU，含已停用。界面清单用 listMatching 排除停用档 */
  list(): SkuRecord[] {
    return this.listMatching({ includeArchived: true });
  }

  /**
   * barcode、skuCode 都是全等。q 对编码/名称/条码做包含匹配。
   * includeArchived 缺省 false：不带条码、也不带 skuCode 时排除已停用。
   * 扫码（barcode 或 skuCode）包含停用档，避免把旧码说成没有这个货。
   */
  listMatching(opts: { barcode?: string; skuCode?: string; q?: string; includeArchived?: boolean }): SkuRecord[] {
    const { where, args } = this.#match(opts);
    const rows = this.db
      .prepare<unknown[], SkuRow>(`${SELECT_WITH_PRODUCT} WHERE ${where} ORDER BY s.sku_code`)
      .all(...args) as unknown as SkuRow[];
    return rows.map(rowToRecord);
  }

  /** 与 listMatching 同一套条件，SQL LIMIT/OFFSET。total 用同一 WHERE。 */
  listMatchingPage(opts: {
    barcode?: string;
    skuCode?: string;
    q?: string;
    includeArchived?: boolean;
    limit: number;
    offset: number;
  }): { rows: SkuRecord[]; total: number } {
    const { where, args } = this.#match(opts);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM wms_sku s WHERE ${where}`).get(...args) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare<unknown[], SkuRow>(
        `${SELECT_WITH_PRODUCT} WHERE ${where} ORDER BY s.sku_code LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as SkuRow[];
    return { rows: rows.map(rowToRecord), total };
  }

  /** 列都带 s. 前缀：SELECT_WITH_PRODUCT 关联了 wms_product，它也有 workspace_id / name */
  #match(opts: { barcode?: string; skuCode?: string; q?: string; includeArchived?: boolean }): {
    where: string;
    args: unknown[];
  } {
    const where = ['s.workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (opts.barcode) {
      where.push('s.barcode = ?');
      args.push(opts.barcode);
    }
    if (opts.skuCode) {
      where.push('s.sku_code = ?');
      args.push(opts.skuCode);
    }
    if (!opts.includeArchived && !opts.barcode && !opts.skuCode) {
      where.push(`(s.status = 'active' OR s.status IS NULL)`);
    }
    if (opts.q) {
      where.push(
        `(s.sku_code LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR IFNULL(s.barcode, '') LIKE ? ESCAPE '\\')`,
      );
      const pat = likeContains(opts.q);
      args.push(pat, pat, pat);
    }
    return { where: where.join(' AND '), args };
  }

  #byIdRaw(id: string): SkuRow | undefined {
    return this.db
      .prepare<unknown[], SkuRow>(`${SELECT_WITH_PRODUCT} WHERE s.workspace_id = ? AND s.id = ?`)
      .get(this.workspaceId, id) as SkuRow | undefined;
  }
}

/**
 * 读取用的 FROM：LEFT JOIN 所属商品，带出它的默认单位 / 包装（读取层继承，见 rowToRecord）。
 * 关联后 wms_sku 的列必须带 s. 前缀——wms_product 也有 workspace_id / name。
 */
const SELECT_WITH_PRODUCT = `SELECT s.*, p.unit AS product_unit, p.packages AS product_packages
       FROM wms_sku s
       LEFT JOIN wms_product p ON p.workspace_id = s.workspace_id AND p.id = s.product_id`;

function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
