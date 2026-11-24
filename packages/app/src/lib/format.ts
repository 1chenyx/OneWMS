/**
 * 数量展示（A3）：带单位的数量统一拼装——`3.5 kg`；空单位原样返回（兼容存量档与汇总值）。
 * 全项目数量渲染共用（库存/单据/拣货/盘点/效期/打印），避免各页自拼格式漂移。
 */
export function fmtQty(qty: number, unit?: string | null): string {
  return unit ? `${qty} ${unit}` : String(qty);
}

/**
 * 单据行数量（包装录入）：有录入快照时显示「原录入 + 基本」——`2 箱（48 瓶）`；
 * 按基本单位录入的行（无快照）退回 fmtQty。库存与账面始终是基本单位，这里只是把开单时怎么录的还原出来。
 */
export function fmtQtyEntered(line: {
  quantity: number;
  unit?: string | null;
  enteredQty?: number | null;
  enteredUnit?: string | null;
}): string {
  if (line.enteredQty == null || !line.enteredUnit) return fmtQty(line.quantity, line.unit);
  return `${line.enteredQty} ${line.enteredUnit}${line.unit ? `（${line.quantity} ${line.unit}）` : ''}`;
}

/**
 * SKU 单位列：`瓶（箱=24、包=6）`；没有包装时就是基本单位本身，空单位返回 '-'。
 * ratio 按 3 位小数量化后去尾零（24 → `24`，1.5 → `1.5`）。
 */
export function fmtUnitWithPackages(
  unit: string | null | undefined,
  packages?: readonly { unit: string; ratio: number }[] | null,
): string {
  if (!unit) return '-';
  if (!packages || packages.length === 0) return unit;
  return `${unit}（${packages.map((p) => `${p.unit}=${trimNum(p.ratio)}`).join('、')}）`;
}

function trimNum(n: number): string {
  return String(Number(n.toFixed(3)));
}
