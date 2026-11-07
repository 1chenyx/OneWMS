import type { WmsWorkspace } from '../wms.js';
import { ReplenishDisabledError } from '../errors.js';
import { QTY_EPS, quantizeQty } from '../state/inventory-policy.js';

/** 补货建议。suggestedQty 已经扣掉尚未收货的入库。 */
export interface ReplenishmentSuggestion {
  readonly skuCode: string;
  readonly name: string;
  readonly unit: string | null;
  readonly total: number;
  readonly held: number;
  readonly reserved: number;
  readonly available: number;
  readonly reorderPoint: number;
  readonly inboundOpen: number;
  readonly suggestedQty: number;
}

const OPEN_INBOUND = new Set(['created', 'announced']);

/**
 * 尚未入账的入库数量（按 SKU 合计订单数量）。
 * created / announced 还没加库存；received 及之后已经在可用量里，再扣会少补。
 * 客退只要还停在这两态，也算即将入库。
 */
function openInboundBySku(ws: WmsWorkspace): Map<string, number> {
  const totals = new Map<string, number>();
  for (const order of ws.orders.list('in')) {
    if (!OPEN_INBOUND.has(order.state)) continue;
    for (const line of ws.orders.lines(order.id)) {
      totals.set(line.skuId, (totals.get(line.skuId) ?? 0) + line.quantity);
    }
  }
  return totals;
}

/** 有缺口的在用 SKU。调用方先 sync。停用检查不在这里。 */
export function listReplenishmentSuggestions(ws: WmsWorkspace): ReplenishmentSuggestion[] {
  const inboundOpen = openInboundBySku(ws);
  const rows: ReplenishmentSuggestion[] = [];
  for (const sku of ws.skus.list()) {
    if (!(sku.reorderPoint > 0)) continue;
    if ((sku.status ?? 'active') !== 'active') continue;
    const total = ws.inventory.totalOf(sku.id);
    const held = ws.inventory.heldOf(sku.id);
    const reserved = ws.inventory.reservedOfSku(sku.id);
    const available = total - held - reserved;
    const open = quantizeQty(inboundOpen.get(sku.id) ?? 0);
    const suggestedQty = quantizeQty(sku.reorderPoint - available - open);
    if (suggestedQty <= QTY_EPS) continue;
    rows.push({
      skuCode: sku.skuCode,
      name: sku.name,
      unit: sku.unit,
      total,
      held,
      reserved,
      available,
      reorderPoint: sku.reorderPoint,
      inboundOpen: open,
      suggestedQty,
    });
  }
  rows.sort((a, b) => b.suggestedQty - a.suggestedQty || a.skuCode.localeCompare(b.skuCode));
  return rows;
}

/** 读建议。模块关闭时拒绝。空清单不是错误。 */
export function getReplenishment(ws: WmsWorkspace): ReplenishmentSuggestion[] {
  ws.sync();
  if (ws.profile.getSnapshot().modules['module.replenish']?.enabled !== true) {
    throw new ReplenishDisabledError();
  }
  return listReplenishmentSuggestions(ws);
}
