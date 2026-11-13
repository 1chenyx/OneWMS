import type { WmsWorkspace } from '../wms.js';
import { codeOfLocation } from '../state/inventory-policy.js';
import type { ScrapRecord } from '../views/scrap-view.js';

export type ScrapWithCount = ScrapRecord & { lineCount: number };

export function withScrapCount(ws: WmsWorkspace, scrap: ScrapRecord): ScrapWithCount {
  return { ...scrap, lineCount: ws.scraps.lines(scrap.id).length };
}

export function listScraps(ws: WmsWorkspace): ScrapWithCount[] {
  return ws.scraps.list().map((s) => withScrapCount(ws, s));
}

export interface ScrapDetailLine {
  skuCode: string;
  name: string;
  unit: string | null;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

export type ScrapDetail = ScrapWithCount & { lines: ScrapDetailLine[] };

/** 报损明细：清单信息 + 逐行联查（SKU 编码/名称/单位、库位编码） */
export function getScrapDetail(ws: WmsWorkspace, scrap: ScrapRecord): ScrapDetail {
  const lines: ScrapDetailLine[] = ws.scraps.lines(scrap.id).map((line) => {
    const sku = ws.skus.byId(line.skuId);
    return {
      skuCode: sku?.skuCode ?? line.skuId,
      name: sku?.name ?? '',
      unit: sku?.unit ?? null,
      locationCode: codeOfLocation(ws, line.locationId),
      batchNo: line.batchNo,
      quantity: line.quantity,
    };
  });
  return { ...withScrapCount(ws, scrap), lines };
}
