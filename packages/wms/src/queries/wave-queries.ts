import type { WmsWorkspace } from '../wms.js';
import type { WaveRecord } from '../views/wave-view.js';

export interface WaveOrderView {
  orderId: string;
  orderNo: string;
  state: string;
  partnerName: string | null;
}

/** 按库位 + 商品 + 批次加总。拣货员走一趟，数量是这几张单的合计。 */
export interface WaveWalkLine {
  locationCode: string;
  skuCode: string;
  skuName: string;
  unit: string | null;
  batchNo: string;
  quantity: number;
  orders: { orderNo: string; quantity: number }[];
}

export interface WaveDetail extends WaveRecord {
  orders: WaveOrderView[];
  walk: WaveWalkLine[];
}

export interface WaveSummary extends WaveRecord {
  orderNos: string[];
}

export function listWaves(ws: WmsWorkspace): WaveSummary[] {
  return ws.waves.list().map((wave) => ({
    ...wave,
    orderNos: ws.waves.orders(wave.id).map((row) => row.orderNo),
  }));
}

export function getWave(ws: WmsWorkspace, waveNo: string): WaveDetail | undefined {
  const wave = ws.waves.byNo(waveNo);
  if (!wave) return undefined;
  return presentWave(ws, wave);
}

function presentWave(ws: WmsWorkspace, wave: WaveRecord): WaveDetail {
  const orders: WaveOrderView[] = ws.waves.orders(wave.id).map((row) => {
    const order = ws.orders.byId(row.orderId);
    const partner = order?.partnerId ? ws.partners.byId(order.partnerId) : undefined;
    return {
      orderId: row.orderId,
      orderNo: row.orderNo,
      state: order?.state ?? '（单据不存在）',
      partnerName: partner?.name ?? null,
    };
  });
  return { ...wave, orders, walk: walkOf(ws, orders) };
}

function walkOf(ws: WmsWorkspace, orders: readonly WaveOrderView[]): WaveWalkLine[] {
  const merged = new Map<string, WaveWalkLine>();
  for (const order of orders) {
    if (order.state === 'canceled' || order.state === '（单据不存在）') continue;
    const found = ws.orders.byId(order.orderId);
    if (!found) continue;
    for (const line of ws.orders.lines(found.id)) {
      const sku = ws.skus.byId(line.skuId);
      const locationCode = ws.locations.byId(line.locationId)?.locationCode ?? line.locationId;
      const skuCode = sku?.skuCode ?? line.skuId;
      const key = `${locationCode}\u0000${skuCode}\u0000${line.batchNo}`;
      const part = { orderNo: order.orderNo, quantity: line.quantity };
      const hit = merged.get(key);
      if (hit) {
        hit.quantity += line.quantity;
        hit.orders.push(part);
        continue;
      }
      merged.set(key, {
        locationCode,
        skuCode,
        skuName: sku?.name ?? '',
        unit: sku?.unit ?? null,
        batchNo: line.batchNo,
        quantity: line.quantity,
        orders: [part],
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      a.locationCode.localeCompare(b.locationCode) ||
      a.skuCode.localeCompare(b.skuCode) ||
      a.batchNo.localeCompare(b.batchNo),
  );
}
