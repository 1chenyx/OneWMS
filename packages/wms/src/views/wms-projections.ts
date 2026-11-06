import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { InventoryView } from './inventory-view.js';
import { LocationView } from './location-view.js';
import { OrderView } from './order-view.js';
import { PartnerView } from './partner-view.js';
import { PickingView } from './picking-view.js';
import { SkuView } from './sku-view.js';
import { StocktakeView } from './stocktake-view.js';

/** WMS 投影组：统一事件应用顺序与投影清理，供增量追账和全量重放共用。 */
export class WmsProjections {
  readonly skus: SkuView;
  readonly locations: LocationView;
  readonly partners: PartnerView;
  readonly orders: OrderView;
  readonly inventory: InventoryView;
  readonly stocktakes: StocktakeView;
  readonly pickings: PickingView;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {
    this.skus = new SkuView(db, workspaceId);
    this.locations = new LocationView(db, workspaceId);
    this.partners = new PartnerView(db, workspaceId);
    this.orders = new OrderView(db, workspaceId);
    this.inventory = new InventoryView(db, workspaceId);
    // 盘点 created 事件从库存投影生成快照，库存必须先于盘点应用。
    this.stocktakes = new StocktakeView(db, workspaceId, this.inventory);
    // 拣货行展示联查 SKU（投影层互不依赖——联查走查询层；此处仅事件分发）。
    this.pickings = new PickingView(db, workspaceId);
  }

  applyEvent(envelope: EventEnvelope): void {
    this.skus.applyEvent(envelope);
    this.locations.applyEvent(envelope);
    this.partners.applyEvent(envelope);
    this.orders.applyEvent(envelope);
    this.inventory.applyEvent(envelope);
    this.stocktakes.applyEvent(envelope);
    this.pickings.applyEvent(envelope);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM wms_sku WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_location WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_partner WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_order WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_order_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory_ledger WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory_hold WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_stocktake WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_stocktake_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_picking WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_picking_line WHERE workspace_id = ?`).run(this.workspaceId);
  }
}
