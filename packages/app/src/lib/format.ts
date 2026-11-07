/**
 * 数量展示（A3）：带单位的数量统一拼装——`3.5 kg`；空单位原样返回（兼容存量档与汇总值）。
 * 全项目数量渲染共用（库存/单据/拣货/盘点/效期/打印），避免各页自拼格式漂移。
 */
export function fmtQty(qty: number, unit?: string | null): string {
  return unit ? `${qty} ${unit}` : String(qty);
}
