import type { WmsWorkspace } from '../wms.js';
import { SerialNotFoundError } from '../errors.js';
import { codeOfLocation, resolveLocation } from '../state/inventory-policy.js';
import { assertSerialEnabled } from '../state/serial-policy.js';
import type { SerialRecord } from '../views/serial-view.js';

export interface SerialRowView {
  readonly serialNo: string;
  readonly skuCode: string;
  readonly locationCode: string;
  readonly batchNo: string;
  readonly status: 'in' | 'out';
  readonly lpnCode?: string;
}

function present(ws: WmsWorkspace, row: SerialRecord): SerialRowView {
  const sku = ws.skus.byId(row.skuId);
  const lpn = row.lpnId ? ws.lpns.byId(row.lpnId) : undefined;
  const view: SerialRowView = {
    serialNo: row.serialNo,
    skuCode: sku?.skuCode ?? row.skuId,
    locationCode: codeOfLocation(ws, row.locationId),
    batchNo: row.batchNo,
    status: row.status,
  };
  return lpn ? { ...view, lpnCode: lpn.lpnCode } : view;
}

/** 在库序列号清单。status 缺省 in；all 含已出库。模块关闭时拒绝。 */
export function listSerials(
  ws: WmsWorkspace,
  opts: { skuCode?: string; locationCode?: string; status?: string } = {},
): SerialRowView[] {
  ws.sync();
  assertSerialEnabled(ws);
  const status = opts.status && opts.status.trim() ? opts.status.trim() : 'in';
  if (status !== 'in' && status !== 'out' && status !== 'all') {
    throw new Error('TOOL_REJECTED: status 只能是 in、out 或 all');
  }
  let skuId: string | undefined;
  if (opts.skuCode && opts.skuCode.trim()) {
    const sku = ws.skus.byCode(opts.skuCode.trim());
    if (!sku) return [];
    skuId = sku.id;
  }
  const locationId =
    opts.locationCode && opts.locationCode.trim()
      ? resolveLocation(ws, opts.locationCode.trim()).locationId
      : undefined;
  return ws.serials
    .list({ skuId, locationId, status })
    .map((row) => present(ws, row));
}

/** 按号查一件。不存在就拒绝。模块关闭时拒绝。 */
export function querySerial(ws: WmsWorkspace, serialNo: string): SerialRowView {
  ws.sync();
  assertSerialEnabled(ws);
  const code = serialNo.trim();
  if (!code) throw new Error('TOOL_REJECTED: serialNo 不能为空');
  const row = ws.serials.byNo(code);
  if (!row) throw new SerialNotFoundError(code);
  return present(ws, row);
}
