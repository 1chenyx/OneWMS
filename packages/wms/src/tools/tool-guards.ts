import type { WmsWorkspace } from '../wms.js';
import type { ProductSpecDim, SkuPackageDef } from '../events/catalog.js';
import type { ProductRecord } from '../views/product-view.js';
import { quantizeQty } from '../state/inventory-policy.js';
import {
  ProductArchivedError,
  ProductNotFoundError,
  SkuBarcodeExistsError,
  SkuPackagesInvalidError,
  VariantAttrsMismatchError,
  VariantComboExistsError,
} from '../errors.js';

/**
 * 条码规整（M18）：trim 两端空白（扫码枪可能带前缀/后缀符）；trim 后为空 → 拒。
 * 不约束格式（EAN-13 / Code128 / 自编码皆可）——唯一性才是业务不变量。
 */
export function normalizeBarcode(raw: string): string {
  const bc = raw.trim();
  if (!bc) throw new Error('TOOL_REJECTED: barcode 不能为空白字符串（不设置条码请不传该字段）');
  return bc;
}

/**
 * 条码唯一校验（M18）：同库条码不允许二义（扫码识读必须有唯一解）。
 * 占用者是当前 SKU 自身时放行（改其他字段不动条码 / 重复声明同码）。
 */
export function assertBarcodeFree(ws: WmsWorkspace, barcode: string, selfSkuId?: string): void {
  const holder = ws.skus.byBarcode(barcode);
  if (holder && holder.id !== selfSkuId) {
    throw new SkuBarcodeExistsError(barcode, holder.skuCode);
  }
}

// ── 包装单位换算守卫 ─────────────────────────────────

/** 包装单位上限：防误粘贴大数组（一个 SKU 的包装形态不会超过一页纸） */
const MAX_PACKAGES = 20;

/**
 * 包装单位定义的形状与语义校验（wms.sku.create / wms.sku.update 共用）。
 * 规则：包名 trim 非空且不重、不得与基本单位重名（换算的「分母」必须是
 * 基本单位，同名会让单据行选择器出现两个「箱」）、ratio 必须是正的有限数
 * （3 位量化）；定义包装单位必须先有基本单位（没有分母的换算没有意义）。
 * 返回量化后的规范数组；空数组原样返回（调用方按「清空」语义落事件）。
 */
export function normalizePackages(
  raw: readonly SkuPackageDef[],
  baseUnit: string | null,
): SkuPackageDef[] {
  if (!Array.isArray(raw)) throw new SkuPackagesInvalidError('packages 必须是数组');
  if (raw.length === 0) return [];
  if (!baseUnit) {
    throw new SkuPackagesInvalidError('先设基本单位（unit 字段），再定义包装单位——换算的分母是基本单位');
  }
  if (raw.length > MAX_PACKAGES) throw new SkuPackagesInvalidError(`最多 ${MAX_PACKAGES} 个包装单位`);
  const seen = new Set<string>([baseUnit]);
  const out: SkuPackageDef[] = [];
  for (const item of raw) {
    const unit = typeof item?.unit === 'string' ? item.unit.trim() : '';
    if (!unit) throw new SkuPackagesInvalidError('包装单位名不能为空（如 箱 / 包）');
    if (seen.has(unit)) {
      throw new SkuPackagesInvalidError(`单位名重复: ${unit}（包装单位互不重名，也不能与基本单位「${baseUnit}」重名）`);
    }
    const ratio = typeof item?.ratio === 'number' ? item.ratio : Number.NaN;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new SkuPackagesInvalidError(`包装单位 ${unit} 的换算比例必须是正数（1 ${unit} = N ${baseUnit}）`);
    }
    seen.add(unit);
    out.push({ unit, ratio: quantizeQty(ratio) });
  }
  return out;
}

// ── 多规格（SPU 层）守卫 ──────────────────────────────

/**
 * 规格维度定义的形状校验：维度名非空且不重、每个维度至少一个取值、
 * 取值非空且维度内不重（「红/黑/红」没有信息量，还破坏组合唯一键）。
 * 去重归一后返回（同名单维度 / 重复取值按用户笔误拒绝，不静默吞）。
 */
export function normalizeSpecDims(raw: readonly ProductSpecDim[]): ProductSpecDim[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seenNames = new Set<string>();
  const dims: ProductSpecDim[] = [];
  for (const dim of raw) {
    const name = typeof dim?.name === 'string' ? dim.name.trim() : '';
    if (!name) throw new Error('TOOL_REJECTED: 规格维度名不能为空（如 颜色 / 尺码）');
    if (seenNames.has(name)) {
      throw new Error(`TOOL_REJECTED: 规格维度名重复: ${name}（一个维度只声明一次）`);
    }
    if (!Array.isArray(dim.values) || dim.values.length === 0) {
      throw new Error(`TOOL_REJECTED: 规格维度 ${name} 至少要有一个取值（如 [红, 黑, 白]）`);
    }
    const seenValues = new Set<string>();
    const values: string[] = [];
    for (const value of dim.values) {
      const v = typeof value === 'string' ? value.trim() : '';
      if (!v) throw new Error(`TOOL_REJECTED: 规格维度 ${name} 的取值不能为空字符串`);
      if (seenValues.has(v)) {
        throw new Error(`TOOL_REJECTED: 规格维度 ${name} 的取值重复: ${v}`);
      }
      seenValues.add(v);
      values.push(v);
    }
    seenNames.add(name);
    dims.push({ name, values });
  }
  return dims;
}

/** 组合的规范键：按 specDims 顺序取值拼接（键顺序无关 → 对象键序漂移不影响唯一性比较） */
export function comboKeyOf(specDims: readonly ProductSpecDim[], attrs: Record<string, string>): string {
  return specDims.map((d) => attrs[d.name] ?? '').join('|');
}

/** 组合的人话标签（错误信息用）：颜色=红 / 尺码=S */
export function comboLabelOf(specDims: readonly ProductSpecDim[], attrs: Record<string, string>): string {
  return specDims.map((d) => `${d.name}=${attrs[d.name]}`).join(' / ');
}

/**
 * 解析并校验「SKU 挂商品」参数（wms.sku.create / wms.sku.update 共用）。
 *
 * 入参语义：
 *  - productCode 与 variantAttrs 都没传 → 返回 null（不挂 / 不改挂，事件不携带两字段）；
 *  - 只传 variantAttrs → 只对已挂 SKU 合法（改组合，沿用现挂商品）；
 *  - 只传 productCode → 换挂：目标商品无维度则清空组合，有维度则必须补传新组合。
 *
 * 守卫（拒绝零事件）：商品存在且启用；组合键值与 specDims 严格对齐（不多不少、
 * 取值在清单内）；同商品下组合唯一（排除自身）。
 *
 * 返回：目标商品 + 按维度顺序重建的规范 variantAttrs + 建议默认 skuCode
 * （`${productCode}-${取值连写}`，仅在有维度时；调用方仅在不传 skuCode 时采用）。
 */
export function resolveVariantAttachment(
  ws: WmsWorkspace,
  params: { productCode?: string; variantAttrs?: Record<string, string> },
  current?: { skuId: string; productId: string | null; variantAttrs: Record<string, string> | null },
): { product: ProductRecord; variantAttrs: Record<string, string> | null; defaultSkuCode: string | null } | null {
  const wantsProduct = params.productCode !== undefined;
  const wantsAttrs = params.variantAttrs !== undefined;
  if (!wantsProduct && !wantsAttrs) return null;

  let product: ProductRecord | undefined;
  if (wantsProduct) {
    const code = params.productCode!.trim();
    if (!code) throw new Error('TOOL_REJECTED: productCode 不能为空白字符串');
    product = ws.products.byCode(code);
    if (!product) throw new ProductNotFoundError(code);
  } else {
    if (!current?.productId) {
      throw new Error('TOOL_REJECTED: 请同时指定 productCode——这个 SKU 还没有挂商品');
    }
    product = ws.products.byId(current.productId);
    if (!product) throw new ProductNotFoundError(current.productId);
  }
  if (product.status !== 'active') throw new ProductArchivedError(product.productCode);

  // 组合缺省沿用现值（同商品改组合）；换挂到别的商品不沿用——旧商品的组合
  // 对新商品没有意义（无维度商品必须为空，有维度商品必须重新给）
  const sameProduct = current !== undefined && current.productId === product.id;
  const rawAttrs =
    params.variantAttrs ??
    (sameProduct && current!.variantAttrs && Object.keys(current!.variantAttrs).length > 0
      ? current!.variantAttrs
      : undefined);

  if (product.specDims.length === 0) {
    if (rawAttrs && Object.keys(rawAttrs).length > 0) {
      throw new VariantAttrsMismatchError(
        product.productCode,
        `商品没有声明规格维度，请不要携带 variantAttrs（多规格先在商品上定义 specDims）`,
      );
    }
  } else {
    if (!rawAttrs || Object.keys(rawAttrs).length === 0) {
      throw new VariantAttrsMismatchError(
        product.productCode,
        `缺少规格组合——请按维度 ${product.specDims.map((d) => d.name).join(' / ')} 填 variantAttrs`,
      );
    }
    const missing = product.specDims.filter((d) => !(d.name in rawAttrs)).map((d) => d.name);
    if (missing.length > 0) {
      throw new VariantAttrsMismatchError(product.productCode, `缺少维度 ${missing.join(' / ')}`);
    }
    const extra = Object.keys(rawAttrs).filter((k) => !product.specDims.some((d) => d.name === k));
    if (extra.length > 0) {
      throw new VariantAttrsMismatchError(product.productCode, `多出的键 ${extra.join(' / ')} 不在维度定义里`);
    }
    for (const dim of product.specDims) {
      const value = String(rawAttrs[dim.name]).trim();
      if (!value) {
        throw new VariantAttrsMismatchError(product.productCode, `维度 ${dim.name} 的取值不能为空`);
      }
      if (!dim.values.includes(value)) {
        throw new VariantAttrsMismatchError(
          product.productCode,
          `维度 ${dim.name} 没有取值 ${value}（可用: ${dim.values.join(' / ')}）`,
        );
      }
    }
  }

  // 按维度顺序重建规范组合（存储确定性 + 组合键比较与对象键序无关）
  const attrs: Record<string, string> = {};
  for (const dim of product.specDims) attrs[dim.name] = String(rawAttrs![dim.name]).trim();
  const hasCombo = product.specDims.length > 0;

  // 同商品下组合唯一（含已停用 SKU——组合被占就是被占；排除自身）
  const comboKey = hasCombo ? comboKeyOf(product.specDims, attrs) : '';
  for (const existing of ws.skus.byProduct(product.id)) {
    if (current && existing.id === current.skuId) continue;
    const existingKey = existing.variantAttrs ? comboKeyOf(product.specDims, existing.variantAttrs) : '';
    if (existingKey === comboKey) {
      throw new VariantComboExistsError(
        product.productCode,
        hasCombo ? comboLabelOf(product.specDims, attrs) : '（无规格组合）',
        existing.skuCode,
      );
    }
  }

  return {
    product,
    variantAttrs: hasCombo ? attrs : null,
    defaultSkuCode: hasCombo
      ? `${product.productCode}-${product.specDims.map((d) => attrs[d.name]).join('-')}`
      : null,
  };
}
