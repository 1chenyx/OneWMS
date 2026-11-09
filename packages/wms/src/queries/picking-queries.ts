import type { WmsWorkspace } from '../wms.js';
import type { PickingRecord, PickingLineRecord } from '../views/picking-view.js';

/** 拣货单行 + 展示联查（SKU 编码/名称/单位、建议/实拣库位编码——经视图 API，不碰 SQL） */
export interface PickingLineWithMeta extends PickingLineRecord {
  skuCode: string;
  skuName: string;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  suggestedLocationCode: string;
  pickedLocationCode: string | null;
  allocations: { locationCode: string; batchNo: string; quantity: number }[];
}

export interface PickingWithLines extends PickingRecord {
  lines: PickingLineWithMeta[];
}

function locCode(ws: WmsWorkspace, locationId: string): string {
  return ws.locations.byId(locationId)?.locationCode ?? locationId;
}

export function withPickingLines(ws: WmsWorkspace, picking: PickingRecord): PickingWithLines {
  const lines = ws.pickings.lines(picking.id).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    return {
      ...line,
      skuCode: sku?.skuCode ?? '(未知)',
      skuName: sku?.name ?? '',
      unit: sku?.unit ?? null,
      suggestedLocationCode: locCode(ws, line.suggestedLocationId),
      pickedLocationCode: line.pickedLocationId ? locCode(ws, line.pickedLocationId) : null,
      allocations: ws.pickings.allocations(line.id).map((row) => ({
        locationCode: locCode(ws, row.locationId),
        batchNo: row.batchNo,
        quantity: row.quantity,
      })),
    };
  });
  return { ...picking, lines };
}

export function listPickingsWithLines(ws: WmsWorkspace, state?: string): PickingWithLines[] {
  return ws.pickings.list(state).map((p) => withPickingLines(ws, p));
}
