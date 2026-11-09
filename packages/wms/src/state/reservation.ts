import type { WmsWorkspace } from '../wms.js';
import type {
  InventoryReservationReleasedPayload,
  InventoryReservedPayload,
} from '../events/catalog.js';
import { QTY_EPS, codeOfLocation } from './inventory-policy.js';

/** 占用行的稳定 id：同一单据同一桶只有一笔。 */
export function reservationId(
  orderId: string,
  skuId: string,
  locationId: string,
  batchNo: string,
): string {
  return `${orderId}:${skuId}:${locationId}:${batchNo}`;
}

export function reservationEnabled(ws: WmsWorkspace): boolean {
  return ws.profile.getSnapshot().modules['module.reservation']?.enabled === true;
}

interface ReservableOrder {
  readonly id: string;
  readonly orderNo: string;
}

interface ReservableLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

/**
 * 进入只预检的出库转移时要落下的占用。模块关闭，或这张单已经有占用，返回空。
 */
export function planReservations(
  ws: WmsWorkspace,
  order: ReservableOrder,
  lines: readonly ReservableLine[],
): InventoryReservedPayload[] {
  if (!reservationEnabled(ws)) return [];
  if (ws.inventory.listReservations(order.id).length > 0) return [];
  const planned: InventoryReservedPayload[] = [];
  for (const line of lines) {
    if (line.quantity <= QTY_EPS) continue;
    const sku = ws.skus.byId(line.skuId);
    planned.push({
      reservationId: reservationId(order.id, line.skuId, line.locationId, line.batchNo),
      orderId: order.id,
      orderNo: order.orderNo,
      skuId: line.skuId,
      skuCode: sku?.skuCode ?? line.skuId,
      locationId: line.locationId,
      locationCode: codeOfLocation(ws, line.locationId),
      batchNo: line.batchNo,
      quantity: line.quantity,
    });
  }
  return planned;
}

export interface ReservationClaim {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

/**
 * 这张出库单现在应该占住的桶。
 * picked 里没有的行仍占单据上的桶。空数组表示这行明确拣了 0，不再占用。
 */
export function desiredReservationClaims(
  lines: readonly {
    lineId: string;
    skuId: string;
    locationId: string;
    batchNo: string;
    quantity: number;
  }[],
  picked: ReadonlyMap<string, readonly { locationId: string; batchNo: string; quantity: number }[]>,
): ReservationClaim[] {
  const merged = new Map<string, ReservationClaim>();
  const add = (skuId: string, locationId: string, batchNo: string, quantity: number) => {
    if (quantity <= QTY_EPS) return;
    const key = `${skuId}\u0000${locationId}\u0000${batchNo}`;
    const prev = merged.get(key);
    if (prev) {
      merged.set(key, { ...prev, quantity: prev.quantity + quantity });
      return;
    }
    merged.set(key, { skuId, locationId, batchNo, quantity });
  };
  for (const line of lines) {
    const allocs = picked.get(line.lineId);
    if (!allocs) {
      add(line.skuId, line.locationId, line.batchNo, line.quantity);
      continue;
    }
    const pickedQty = allocs.reduce((sum, row) => sum + row.quantity, 0);
    if (pickedQty <= QTY_EPS) continue;
    for (const row of allocs) add(line.skuId, row.locationId, row.batchNo, row.quantity);
    const remainder = line.quantity - pickedQty;
    if (remainder > QTY_EPS) add(line.skuId, line.locationId, line.batchNo, remainder);
  }
  return [...merged.values()];
}

/**
 * 把活动占用改成 desired。数量相同的行不产生事件。
 * 模块关闭时两边都空：不释放已经存在的占用，调用方在模块关闭后本来也不会进来。
 */
export function planReservationSync(
  ws: WmsWorkspace,
  order: ReservableOrder,
  desired: readonly ReservationClaim[],
): { releases: InventoryReservationReleasedPayload[]; reserves: InventoryReservedPayload[] } {
  if (!reservationEnabled(ws)) return { releases: [], reserves: [] };
  const current = ws.inventory.listReservations(order.id);
  const next = new Map<string, ReservationClaim>();
  for (const claim of desired) {
    if (claim.quantity <= QTY_EPS) continue;
    next.set(reservationId(order.id, claim.skuId, claim.locationId, claim.batchNo), claim);
  }
  const currentById = new Map(current.map((row) => [row.id, row]));
  const releases: InventoryReservationReleasedPayload[] = [];
  for (const row of current) {
    const claim = next.get(row.id);
    if (claim && Math.abs(claim.quantity - row.quantity) <= QTY_EPS) continue;
    const sku = ws.skus.byId(row.skuId);
    releases.push({
      reservationId: row.id,
      orderId: row.orderId,
      orderNo: row.orderNo,
      skuId: row.skuId,
      skuCode: sku?.skuCode ?? row.skuId,
      locationId: row.locationId,
      locationCode: codeOfLocation(ws, row.locationId),
      batchNo: row.batchNo,
      quantity: row.quantity,
    });
  }
  const reserves: InventoryReservedPayload[] = [];
  for (const [id, claim] of next) {
    const prev = currentById.get(id);
    if (prev && Math.abs(prev.quantity - claim.quantity) <= QTY_EPS) continue;
    const sku = ws.skus.byId(claim.skuId);
    reserves.push({
      reservationId: id,
      orderId: order.id,
      orderNo: order.orderNo,
      skuId: claim.skuId,
      skuCode: sku?.skuCode ?? claim.skuId,
      locationId: claim.locationId,
      locationCode: codeOfLocation(ws, claim.locationId),
      batchNo: claim.batchNo,
      quantity: claim.quantity,
    });
  }
  return { releases, reserves };
}

/** 这一桶上有别人的拣货占用时给一句提示。调整、移库、盘点仍照常记账。 */
export function bucketReservationNotice(
  ws: WmsWorkspace,
  skuId: string,
  locationId: string,
  batchNo: string,
): string | undefined {
  const rows = ws.inventory
    .listReservations()
    .filter(
      (row) =>
        row.skuId === skuId &&
        row.locationId === locationId &&
        row.batchNo === batchNo &&
        row.quantity > QTY_EPS,
    );
  if (rows.length === 0) return undefined;
  const orders = [...new Set(rows.map((row) => row.orderNo))].join('、');
  return `这一桶被出库单 ${orders} 占用着。这次照常记账，拣货关单时如果不够会被拦住。`;
}

/** 发货或取消时释放这张单的全部占用。没有占用则空。不看模块开关。 */
export function planReservationReleases(
  ws: WmsWorkspace,
  order: ReservableOrder,
): InventoryReservationReleasedPayload[] {
  return ws.inventory.listReservations(order.id).map((row) => {
    const sku = ws.skus.byId(row.skuId);
    return {
      reservationId: row.id,
      orderId: row.orderId,
      orderNo: row.orderNo,
      skuId: row.skuId,
      skuCode: sku?.skuCode ?? row.skuId,
      locationId: row.locationId,
      locationCode: codeOfLocation(ws, row.locationId),
      batchNo: row.batchNo,
      quantity: row.quantity,
    };
  });
}
