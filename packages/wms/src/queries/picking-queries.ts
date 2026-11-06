import type { WmsWorkspace } from '../wms.js';
import type { PickingRecord, PickingLineRecord } from '../views/picking-view.js';

/** 拣货单行 + 展示联查（SKU 编码/名称、建议/实拣库位编码——经视图 API，不碰 SQL） */
export interface PickingLineWithMeta extends PickingLineRecord {
  skuCode: string;
  skuName: string;
  suggestedLocationCode: string;
  pickedLocationCode: string | null;
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
      suggestedLocationCode: locCode(ws, line.suggestedLocationId),
      pickedLocationCode: line.pickedLocationId ? locCode(ws, line.pickedLocationId) : null,
    };
  });
  return { ...picking, lines };
}

export function listPickingsWithLines(ws: WmsWorkspace, state?: string): PickingWithLines[] {
  return ws.pickings.list(state).map((p) => withPickingLines(ws, p));
}
