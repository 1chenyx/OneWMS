import type { WmsWorkspace } from '../wms.js';
import { codeOfLocation, quantizeQty } from '../state/inventory-policy.js';
import type { StocktakeLineRecord, StocktakeRecord } from '../views/stocktake-view.js';

export type StocktakeWithProgress = StocktakeRecord & {
  scope: string[] | '全场';
  lineCount: number;
  countedCount: number;
};

/** 盘点清单行：范围 id → 编码展示 + 盘点进度（已盘行数 / 总行数） */
export function withStocktakeProgress(
  ws: WmsWorkspace,
  stocktake: StocktakeRecord,
): StocktakeWithProgress {
  const stats = ws.stocktakes.stats(stocktake.id);
  return {
    ...stocktake,
    scope: stocktake.locationIds
      ? stocktake.locationIds.map((id) => codeOfLocation(ws, id))
      : '全场',
    lineCount: stats.lineCount,
    countedCount: stats.countedCount,
  };
}

export function listStocktakes(ws: WmsWorkspace): StocktakeWithProgress[] {
  return ws.stocktakes.list().map((stocktake) => withStocktakeProgress(ws, stocktake));
}

/** 面向命令与查询共用的行状态：保留原始行 id 维度，同时补齐展示与现值。 */
export interface StocktakeLineState {
  line: StocktakeLineRecord;
  skuCode: string;
  name: string;
  locationCode: string;
  /** 数量单位（A3）：null = 不显示 */
  unit: string | null;
  bookQty: number;
  delta: number | null;
}

export function listStocktakeLineStates(
  ws: WmsWorkspace,
  stocktakeId: string,
): StocktakeLineState[] {
  return ws.stocktakes
    .lines(stocktakeId)
    .map((line) => {
      const sku = ws.skus.byId(line.skuId);
      const bookQty = ws.inventory.quantityOf(line.skuId, line.locationId, line.batchNo);
      return {
        line,
        skuCode: sku?.skuCode ?? line.skuId,
        name: sku?.name ?? '',
        locationCode: codeOfLocation(ws, line.locationId),
        unit: sku?.unit ?? null,
        bookQty,
        delta: line.countedQty === null ? null : quantizeQty(line.countedQty - bookQty),
      };
    })
    .sort(
      (a, b) =>
        a.skuCode.localeCompare(b.skuCode) ||
        a.locationCode.localeCompare(b.locationCode) ||
        a.line.batchNo.localeCompare(b.line.batchNo),
    );
}

export type StocktakeDetail = StocktakeWithProgress & {
  lines: {
    skuCode: string;
    name: string;
    locationCode: string;
    batchNo: string;
    unit: string | null;
    expectedQty: number;
    countedQty: number | null;
    bookQty: number;
    delta: number | null;
  }[];
};

/** 盘点明细：清单信息 + 逐行联查（SKU 编码/名称/单位、库位编码、当前账面与差异）。 */
export function getStocktakeDetail(
  ws: WmsWorkspace,
  stocktake: StocktakeRecord,
): StocktakeDetail {
  const lines = listStocktakeLineStates(ws, stocktake.id).map((state) => ({
    skuCode: state.skuCode,
    name: state.name,
    locationCode: state.locationCode,
    batchNo: state.line.batchNo,
    unit: state.unit,
    expectedQty: state.line.expectedQty,
    countedQty: state.line.countedQty,
    bookQty: state.bookQty,
    delta: state.delta,
  }));
  return { ...withStocktakeProgress(ws, stocktake), lines };
}
