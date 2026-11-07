import type { WmsWorkspace } from '../wms.js';
import { WarehouseDisabledError, WarehouseNotFoundError } from '../errors.js';
import type { LocationRecord } from '../views/location-view.js';

export interface WarehouseListRow {
  readonly id: string;
  readonly warehouseCode: string;
  readonly name: string;
  readonly locationCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WarehouseStockRow {
  readonly skuCode: string;
  readonly name: string;
  readonly unit: string | null;
  readonly locationCode: string;
  readonly batchNo: string;
  readonly quantity: number;
}

export interface WarehouseStock {
  readonly warehouseCode: string;
  readonly name: string;
  readonly rows: WarehouseStockRow[];
}

/** 库位清单附上仓库编码。未分仓两边都是 null。 */
export function presentLocation(ws: WmsWorkspace, location: LocationRecord) {
  const warehouse = location.warehouseId ? ws.warehouses.byId(location.warehouseId) : undefined;
  return {
    ...location,
    warehouseCode: warehouse?.warehouseCode ?? null,
    warehouseName: warehouse?.name ?? null,
  };
}

export function assertWarehouseEnabled(ws: WmsWorkspace): void {
  if (ws.profile.getSnapshot().modules['module.warehouse']?.enabled !== true) {
    throw new WarehouseDisabledError();
  }
}

/** 仓库清单。模块关闭时拒绝。空清单不是错误。 */
export function listWarehouses(ws: WmsWorkspace): WarehouseListRow[] {
  ws.sync();
  assertWarehouseEnabled(ws);
  const locations = ws.locations.list();
  return ws.warehouses.list().map((warehouse) => ({
    id: warehouse.id,
    warehouseCode: warehouse.warehouseCode,
    name: warehouse.name,
    locationCount: locations.filter((location) => location.warehouseId === warehouse.id).length,
    createdAt: warehouse.createdAt,
    updatedAt: warehouse.updatedAt,
  }));
}

/**
 * 某个仓库里的库存。只加总划进该仓库的库位。
 * DEFAULT 和未分仓的库位不算进来。零余量的桶不列出。
 */
export function listWarehouseStock(ws: WmsWorkspace, warehouseCode: string): WarehouseStock {
  ws.sync();
  assertWarehouseEnabled(ws);
  const warehouse = ws.warehouses.byCode(warehouseCode);
  if (!warehouse) throw new WarehouseNotFoundError(warehouseCode);
  const locations = ws.locations.list().filter((location) => location.warehouseId === warehouse.id);
  const byId = new Map(locations.map((location) => [location.id, location.locationCode]));
  const rows: WarehouseStockRow[] = [];
  for (const bucket of ws.inventory.list()) {
    const locationCode = byId.get(bucket.locationId);
    if (!locationCode || bucket.quantity === 0) continue;
    const sku = ws.skus.byId(bucket.skuId);
    rows.push({
      skuCode: sku?.skuCode ?? bucket.skuId,
      name: sku?.name ?? '',
      unit: sku?.unit ?? null,
      locationCode,
      batchNo: bucket.batchNo,
      quantity: bucket.quantity,
    });
  }
  rows.sort(
    (a, b) =>
      a.skuCode.localeCompare(b.skuCode) ||
      a.locationCode.localeCompare(b.locationCode) ||
      a.batchNo.localeCompare(b.batchNo),
  );
  return { warehouseCode: warehouse.warehouseCode, name: warehouse.name, rows };
}
