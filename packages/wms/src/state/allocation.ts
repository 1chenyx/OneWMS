import { isExpired } from './inventory-policy.js';

/**
 * 批次分配核心（M21 自 batch-allocation.ts 提取）：按策略排序候选桶并依序
 * 装载到需求量。纯计算（不查库、不落事件），两个消费方共用：
 *  - 建单展开（expandAllocatedLines，M12）：不足即 AllocationInsufficientError；
 *  - 拣货单建议桶（picking-tools，M21）：部分分配也接受——建议桶只是建议，
 *    余量硬校验在关单（assertOutboundBuckets）。
 * 排序语义不变：fefo 效期升序（无期批次殿后）；同段并列回落 firstSeenAt，
 * 再并列 batchNo 字典序稳定化。blockExpired 开启时跳过过期桶。
 */

/** 候选桶（数据源 InventoryView.batchesOf；与库存余量同源） */
export interface AllocatableBucket {
  readonly batchNo: string;
  readonly quantity: number;
  readonly batchExpiryDate: string | null;
  readonly firstSeenAt: string;
}

/** 分配结果：parts 依序装载（策略最优在前）；remaining = 未满足余量（0 = 足额） */
export interface AllocationResult {
  readonly parts: { batchNo: string; quantity: number }[];
  readonly remaining: number;
}

export function allocateFromBuckets(
  buckets: readonly AllocatableBucket[],
  quantity: number,
  strategy: 'fifo' | 'fefo',
  blockExpired: boolean,
  today: string,
): AllocationResult {
  const usable = blockExpired ? buckets.filter((b) => !isExpired(b.batchExpiryDate, today)) : [...buckets];
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

  let remaining = quantity;
  const parts: { batchNo: string; quantity: number }[] = [];
  for (const b of usable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.quantity);
    parts.push({ batchNo: b.batchNo, quantity: take });
    remaining -= take;
  }
  return { parts, remaining };
}
