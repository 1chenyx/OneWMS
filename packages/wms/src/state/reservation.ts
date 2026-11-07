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
