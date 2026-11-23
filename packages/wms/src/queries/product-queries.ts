import type { WmsWorkspace } from '../wms.js';
import { ProductNotFoundError } from '../errors.js';
import type { ProductRecord } from '../views/product-view.js';
import type { SkuRecord } from '../views/sku-view.js';

/**
 * 商品 / SKU 的界面查询（多规格 SPU 层）。
 *
 * 投影只存 product_id（无外键，引用完整性在工具层守卫），界面要的是 productCode
 * 和「这个商品下挂了几个规格」——联查在这里做一次，路由与前端都不必自己拼
 * （routes/wms.ts 的纪律：读端点只做参数解析 + 调共享查询）。
 */

export interface ProductListRow extends ProductRecord {
  /** 已挂的 SKU 数（含停用档，与 SkuView.byProduct 口径一致） */
  readonly skuCount: number;
}

export interface SkuListRow extends SkuRecord {
  /** 所属商品编码；null = 没挂商品（独立 / 单规格 SKU） */
  readonly productCode: string | null;
}

/** 商品清单（q = 编码/名称包含；includeArchived 缺省 false） */
export function listProducts(
  ws: WmsWorkspace,
  opts: { q?: string; includeArchived?: boolean } = {},
): ProductListRow[] {
  return withSkuCount(ws, ws.products.listMatching(opts));
}

/** 单个商品（按业务键）。不存在 → WMS_PRODUCT_NOT_FOUND（经 onError 映射 400） */
export function getProduct(ws: WmsWorkspace, productCode: string): ProductListRow {
  const product = ws.products.byCode(productCode);
  if (!product) throw new ProductNotFoundError(productCode);
  return withSkuCount(ws, [product])[0]!;
}

/** 商品记录 → 界面行。SKU 全表扫一次分组，避免每商品一次 byProduct（N+1） */
export function withSkuCount(ws: WmsWorkspace, products: readonly ProductRecord[]): ProductListRow[] {
  const counts = new Map<string, number>();
  for (const sku of ws.skus.list()) {
    if (!sku.productId) continue;
    counts.set(sku.productId, (counts.get(sku.productId) ?? 0) + 1);
  }
  return products.map((product) => ({ ...product, skuCount: counts.get(product.id) ?? 0 }));
}

/** SKU 记录 → 界面行（补 productCode）。只按出现过的商品 id 反查，同一商品不重复查 */
export function withProductCode(ws: WmsWorkspace, skus: readonly SkuRecord[]): SkuListRow[] {
  const codes = new Map<string, string | null>();
  return skus.map((sku) => {
    const productId = sku.productId;
    if (!productId) return { ...sku, productCode: null };
    if (!codes.has(productId)) codes.set(productId, ws.products.byId(productId)?.productCode ?? null);
    return { ...sku, productCode: codes.get(productId)! };
  });
}
