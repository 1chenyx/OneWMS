import type { WmsWorkspace } from '../wms.js';
import { LpnDisabledError, LpnPackedError } from '../errors.js';
import { bucketLabel, QTY_EPS, quantizeQty } from './inventory-policy.js';

/** 托盘模块开着。缺模块或 enabled 不是 true 都算关。 */
export function lpnEnabled(ws: WmsWorkspace): boolean {
  return ws.profile.getSnapshot().modules['module.lpn']?.enabled === true;
}

export function assertLpnEnabled(ws: WmsWorkspace): void {
  if (!lpnEnabled(ws)) throw new LpnDisabledError();
}

/**
 * 桶里还能动的散货 = 余量 − 已装托盘。
 * 余量本身不够时不要调用：先抛库存不足，装托盘的占用只在余量够、散货不够时拒绝。
 */
export function assertLooseEnough(
  ws: WmsWorkspace,
  args: {
    skuCode: string;
    skuId: string;
    locationId: string;
    locationCode: string;
    batchNo: string;
    take: number;
    onHand: number;
  },
): void {
  if (!lpnEnabled(ws)) return;
  const packed = ws.lpns.packedAt(args.locationId, args.skuId, args.batchNo);
  if (packed <= QTY_EPS) return;
  const loose = quantizeQty(args.onHand - packed);
  if (loose + QTY_EPS < args.take) {
    throw new LpnPackedError(
      bucketLabel(args.skuCode, args.locationCode, args.batchNo),
      args.take,
      loose > 0 ? loose : 0,
    );
  }
}
