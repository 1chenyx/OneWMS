import type { WmsWorkspace } from '../wms.js';
import { DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { ZoneUseError } from '../errors.js';
import { isZoneKind, readEnabledZoneKinds, zoneKindAllows, type ZoneUse } from '../zone-kinds.js';

/**
 * 库区分类对单据的限制。
 * 模块关闭、未分区、DEFAULT、以及工作区关掉的分类都不限制。
 * 移库、调整、盘点不走这里。
 */

export function orderZoneUse(direction: 'in' | 'out', returnOf: boolean): ZoneUse {
  if (direction === 'out') return returnOf ? 'returnOut' : 'issue';
  return returnOf ? 'returnIn' : 'receive';
}

export function assertZoneUse(ws: WmsWorkspace, locationId: string, use: ZoneUse): void {
  if (ws.profile.getSnapshot().modules['module.zone']?.enabled !== true) return;
  if (locationId === DEFAULT_LOCATION_ID) return;
  const location = ws.locations.byId(locationId);
  if (!location?.zoneId) return;
  const zone = ws.zones.byId(location.zoneId);
  if (!zone || !isZoneKind(zone.kind)) return;
  const enabled = readEnabledZoneKinds(ws.profile.getSnapshot().modules['module.zone']?.settings?.enabledKinds);
  if (!enabled.includes(zone.kind)) return;
  if (zoneKindAllows(zone.kind, use)) return;
  throw new ZoneUseError(location.locationCode, zone.zoneCode, zone.kind, use);
}
