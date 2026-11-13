import type { WmsWorkspace } from '../wms.js';
import {
  ZoneDisabledError,
  ZoneNotFoundError,
  ZoneOccupiedError,
  ZoneWarehouseMismatchError,
} from '../errors.js';
import { zoneKindLabel, type ZoneKind } from '../zone-kinds.js';

export interface ZoneListRow {
  readonly id: string;
  readonly zoneCode: string;
  readonly name: string;
  readonly kind: ZoneKind;
  readonly kindLabel: string;
  readonly warehouseCode: string | null;
  readonly warehouseName: string | null;
  readonly locationCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assertZoneEnabled(ws: WmsWorkspace): void {
  if (ws.profile.getSnapshot().modules['module.zone']?.enabled !== true) {
    throw new ZoneDisabledError();
  }
}

/**
 * 解析本次要写入的库区。
 * 没传 zoneCode → undefined（创建即未分区，更新则不动归属）。
 * 模块关闭时只要键在（含空字符串）就拒绝。
 * 模块开启时：创建的空字符串当没传；更新的空字符串是划出库区。
 */
export function resolveZoneId(
  ws: WmsWorkspace,
  params: { zoneCode?: string },
  mode: 'create' | 'update',
): string | null | undefined {
  if (!Object.hasOwn(params, 'zoneCode')) return undefined;
  assertZoneEnabled(ws);
  const code = typeof params.zoneCode === 'string' ? params.zoneCode.trim() : '';
  if (!code) return mode === 'create' ? undefined : null;
  const zone = ws.zones.byCode(code);
  if (!zone) throw new ZoneNotFoundError(code);
  return zone.id;
}

/**
 * 库位的仓库必须和库区的仓库相同。
 * 创建时没写仓库、或库位还没分仓：跟着库区进那个仓库。
 * 库位已经在另一个仓库：拒绝，不悄悄换仓。
 * 两边都没改时不检查，改名不受历史归属影响。
 */
export function alignLocationParents(
  ws: WmsWorkspace,
  input: {
    mode: 'create' | 'update';
    warehouseId: string | null | undefined;
    zoneId: string | null | undefined;
    currentWarehouseId: string | null;
    currentZoneId: string | null;
  },
): { warehouseId: string | null | undefined; zoneId: string | null | undefined } {
  const warehouseTouched = input.warehouseId !== undefined;
  const zoneTouched = input.zoneId !== undefined;
  if (!warehouseTouched && !zoneTouched) {
    return { warehouseId: input.warehouseId, zoneId: input.zoneId };
  }

  let warehouseId = input.warehouseId;
  const zoneId = input.zoneId;
  const nextZoneId = zoneTouched ? zoneId : input.currentZoneId;
  const zone = nextZoneId ? ws.zones.byId(nextZoneId) : undefined;

  if (zoneTouched && zone && !warehouseTouched) {
    const currentWarehouse = input.mode === 'create' ? null : input.currentWarehouseId;
    if (currentWarehouse == null) {
      if (zone.warehouseId) warehouseId = zone.warehouseId;
    } else if (currentWarehouse !== zone.warehouseId) {
      throw mismatch(ws, zone.zoneCode, zone.warehouseId);
    }
  }

  const finalWarehouse = warehouseId !== undefined ? warehouseId : input.currentWarehouseId;
  const finalZoneId = zoneId !== undefined ? zoneId : input.currentZoneId;
  const finalZone = finalZoneId ? ws.zones.byId(finalZoneId) : undefined;
  if (finalZone && (finalWarehouse ?? null) !== (finalZone.warehouseId ?? null)) {
    throw mismatch(ws, finalZone.zoneCode, finalZone.warehouseId);
  }
  return { warehouseId, zoneId };
}

function mismatch(ws: WmsWorkspace, zoneCode: string, warehouseId: string | null): ZoneWarehouseMismatchError {
  const warehouseCode = warehouseId ? (ws.warehouses.byId(warehouseId)?.warehouseCode ?? warehouseId) : null;
  return new ZoneWarehouseMismatchError(zoneCode, warehouseCode);
}

/** 库区还挂着库位时，不能改它的仓库。 */
export function assertZoneWarehouseMovable(ws: WmsWorkspace, zoneId: string, zoneCode: string, nextWarehouseId: string | null, currentWarehouseId: string | null): void {
  if ((nextWarehouseId ?? null) === (currentWarehouseId ?? null)) return;
  const locationCount = ws.locations.list().filter((location) => location.zoneId === zoneId).length;
  if (locationCount > 0) throw new ZoneOccupiedError(zoneCode, locationCount);
}

/** 库区清单。模块关闭时拒绝。空清单不是错误。 */
export function listZones(ws: WmsWorkspace): ZoneListRow[] {
  ws.sync();
  assertZoneEnabled(ws);
  const locations = ws.locations.list();
  return ws.zones.list().map((zone) => {
    const warehouse = zone.warehouseId ? ws.warehouses.byId(zone.warehouseId) : undefined;
    return {
      id: zone.id,
      zoneCode: zone.zoneCode,
      name: zone.name,
      kind: zone.kind,
      kindLabel: zoneKindLabel(zone.kind),
      warehouseCode: warehouse?.warehouseCode ?? null,
      warehouseName: warehouse?.name ?? null,
      locationCount: locations.filter((location) => location.zoneId === zone.id).length,
      createdAt: zone.createdAt,
      updatedAt: zone.updatedAt,
    };
  });
}
