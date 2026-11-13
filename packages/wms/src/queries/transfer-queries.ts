import type { WmsWorkspace } from '../wms.js';
import { codeOfLocation } from '../state/inventory-policy.js';
import type { TransferLineRecord, TransferRecord } from '../views/transfer-view.js';

export type TransferWithCount = TransferRecord & {
  fromWarehouse: string | null;
  toWarehouse: string | null;
  lineCount: number;
};

function warehouseCode(ws: WmsWorkspace, warehouseId: string | null): string | null {
  return warehouseId ? (ws.warehouses.byId(warehouseId)?.warehouseCode ?? warehouseId) : null;
}

export function withTransferCount(ws: WmsWorkspace, transfer: TransferRecord): TransferWithCount {
  return {
    ...transfer,
    fromWarehouse: warehouseCode(ws, transfer.fromWarehouseId),
    toWarehouse: warehouseCode(ws, transfer.toWarehouseId),
    lineCount: ws.transfers.lines(transfer.id).length,
  };
}

export function listTransfers(ws: WmsWorkspace): TransferWithCount[] {
  return ws.transfers.list().map((t) => withTransferCount(ws, t));
}

export interface TransferDetailLine {
  skuCode: string;
  name: string;
  unit: string | null;
  fromLocationCode: string;
  toLocationCode: string;
  batchNo: string;
  quantity: number;
}

export type TransferDetail = TransferWithCount & { lines: TransferDetailLine[] };

export function transferLineStates(
  ws: WmsWorkspace,
  transferId: string,
): (TransferLineRecord & { skuCode: string; name: string; unit: string | null; fromLocationCode: string; toLocationCode: string })[] {
  return ws.transfers.lines(transferId).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    return {
      ...line,
      skuCode: sku?.skuCode ?? line.skuId,
      name: sku?.name ?? '',
      unit: sku?.unit ?? null,
      fromLocationCode: codeOfLocation(ws, line.fromLocationId),
      toLocationCode: codeOfLocation(ws, line.toLocationId),
    };
  });
}

/** 调拨明细：清单信息 + 逐行联查（SKU 编码/名称/单位、源/目标库位编码） */
export function getTransferDetail(ws: WmsWorkspace, transfer: TransferRecord): TransferDetail {
  const lines: TransferDetailLine[] = transferLineStates(ws, transfer.id).map(
    ({ skuCode, name, unit, fromLocationCode, toLocationCode, batchNo, quantity }) => ({
      skuCode,
      name,
      unit,
      fromLocationCode,
      toLocationCode,
      batchNo,
      quantity,
    }),
  );
  return { ...withTransferCount(ws, transfer), lines };
}
