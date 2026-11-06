import type { WmsWorkspace } from '../wms.js';
import { AllocationInsufficientError, SkuNotFoundError } from '../errors.js';
import { isExpired, resolveLocation } from './inventory-policy.js';

/**
 * 批次分配（M12）：出库单启用 allocation 时，把未指定批次的行按策略拆分为具体批次行。
 *  - fifo：桶按首笔流水时间升序（firstSeenAt）；fefo：按效期升序，无期批次（含
 *    DEFAULT）排最后——同段并列回落 firstSeenAt，再并列用 batchNo 字典序稳定化；
 *  - 分配范围 = 行库位内的全部余量桶（不跨库位）；按序扣到足额，一行可拆多批次；
 *  - 显式指定 batchNo 的行原样保留（显式优先，不参与分配）；
 *  - 各批次合计不足 → AllocationInsufficientError（纯计算不落事件，fail-fast）；
 *  - 过期桶（M13）：blockExpired 开启时跳过效期早于今日的桶——不让过期货堵死
 *    整单，可用桶凑不齐仍走 AllocationInsufficientError。
 * 分配是建单时的命令侧计算：事件里落的已是带批次的多行，与 M11 事件形态
 * 逐字节同构——零投影改动、旧节点可同步消费。
 */
export function expandAllocatedLines(
  ws: WmsWorkspace,
  lines: {
    skuCode: string;
    quantity: number;
    locationCode?: string;
    batchNo?: string;
    batchExpiryDate?: string;
  }[],
  strategy: 'fifo' | 'fefo',
  blockExpired: boolean,
): {
  skuCode: string;
  quantity: number;
  locationCode?: string;
  batchNo?: string;
  batchExpiryDate?: string;
}[] {
  const today = new Date().toISOString().slice(0, 10);
  return lines.flatMap((l, i) => {
    if (l.batchNo) return [l]; // 显式批次优先
    // 防御性结构校验（主校验循环兜底再跑一遍，此处保证分配自身不被坏输入绕过）
    if (typeof l?.skuCode !== 'string' || !l.skuCode) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
    }
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行数量必须是正整数`);
    }
    const sku = ws.skus.byCode(l.skuCode);
    if (!sku) throw new SkuNotFoundError(l.skuCode);
    const loc = resolveLocation(ws, l.locationCode);

    const buckets = ws.inventory.batchesOf(sku.id, loc.locationId);
    // M13：拦截开启时跳过过期桶（效期早于今天；今天到期 = 临期可用）
    const usable = blockExpired ? buckets.filter((b) => !isExpired(b.batchExpiryDate, today)) : buckets;
    usable.sort((a, b) => {
      if (strategy === 'fefo') {
        const ae = a.batchExpiryDate;
        const be = b.batchExpiryDate;
        if (ae === null && be !== null) return 1; // 无期批次最后（含 DEFAULT）
        if (ae !== null && be === null) return -1;
        if (ae !== null && be !== null && ae !== be) return ae < be ? -1 : 1;
      }
      if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
      return a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1 : 0;
    });

    let remaining = l.quantity;
    const parts: { batchNo: string; quantity: number }[] = [];
    for (const b of usable) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.quantity);
      parts.push({ batchNo: b.batchNo, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new AllocationInsufficientError(
        l.skuCode,
        loc.locationCode,
        l.quantity,
        l.quantity - remaining,
      );
    }
    // 拆分行不带效期（出库行效期纪律不变——效期随入库声明）
    return parts.map((p) => ({ ...l, batchNo: p.batchNo, quantity: p.quantity }));
  });
}
