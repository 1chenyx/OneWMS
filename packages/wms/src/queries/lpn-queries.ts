import type { WmsWorkspace } from '../wms.js';
import { LpnNotFoundError } from '../errors.js';
import { codeOfLocation } from '../state/inventory-policy.js';
import { assertLpnEnabled } from '../state/lpn-policy.js';

export interface LpnListRow {
  readonly lpnCode: string;
  readonly locationCode: string;
  readonly lineCount: number;
}

export interface LpnStockLine {
  readonly skuCode: string;
  readonly batchNo: string;
  readonly quantity: number;
}

export interface LpnStockView {
  readonly lpnCode: string;
  readonly locationCode: string;
  readonly lines: LpnStockLine[];
}

/** 托盘清单。模块关闭时拒绝。 */
export function listLpns(ws: WmsWorkspace): LpnListRow[] {
  ws.sync();
  assertLpnEnabled(ws);
  return ws.lpns.list().map((lpn) => ({
    lpnCode: lpn.lpnCode,
    locationCode: codeOfLocation(ws, lpn.locationId),
    lineCount: ws.lpns.lines(lpn.id).length,
  }));
}

/** 某个托盘上装了什么。托盘不存在就拒绝。 */
export function lpnStock(ws: WmsWorkspace, lpnCode: string): LpnStockView {
  ws.sync();
  assertLpnEnabled(ws);
  const code = lpnCode.trim();
  const lpn = code ? ws.lpns.byCode(code) : undefined;
  if (!lpn) throw new LpnNotFoundError(code || '(空)');
  return {
    lpnCode: lpn.lpnCode,
    locationCode: codeOfLocation(ws, lpn.locationId),
    lines: ws.lpns.lines(lpn.id).map((line) => ({
      skuCode: ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
      batchNo: line.batchNo,
      quantity: line.quantity,
    })),
  };
}
