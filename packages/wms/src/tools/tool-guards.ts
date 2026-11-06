import type { WmsWorkspace } from '../wms.js';
import { SkuBarcodeExistsError } from '../errors.js';

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
