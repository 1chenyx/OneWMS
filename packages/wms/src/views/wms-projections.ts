import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { InventoryView } from './inventory-view.js';
import { LocationView } from './location-view.js';
import { OrderView } from './order-view.js';
import { PartnerView } from './partner-view.js';
import { PickingView } from './picking-view.js';
import { SkuView } from './sku-view.js';
import { StocktakeView } from './stocktake-view.js';
import { WarehouseView } from './warehouse-view.js';
import { SerialView } from './serial-view.js';
import { LpnView } from './lpn-view.js';

/**
 * WMS 投影组的版本号（sku / location / partner / order / inventory /
 * stocktake / picking / warehouse / serial / lpn 十张派生表）。
 *
 * **改了本文件或任何 *-view.ts 里的派生语义就把它 +1**：库存聚合口径、
 * 单据状态机的投影结果、批次/序列号的分配规则、盘点快照的生成时机、
 * 事件应用顺序（见下方 applyEvent 的注释）。只加表、只加列、只改查询 → 不用动。
 *
 * +1 之后不需要写迁移脚本：用户下次启动会自动清空这十张表并从 oplog 全量重放
 * （见 core/projection/projection-version.ts）。这也是它替代「手写 table_info 探测
 * + DROP」的地方——探测代码只能覆盖你想起来的那几种改动，版本号覆盖全部。
 */
export const WMS_PROJECTION_VERSION = 1;

/** WMS 投影组：统一事件应用顺序与投影清理，供增量追账和全量重放共用。 */
export class WmsProjections {
  readonly skus: SkuView;
  readonly locations: LocationView;
  readonly partners: PartnerView;
  readonly orders: OrderView;
  readonly inventory: InventoryView;
  readonly stocktakes: StocktakeView;
  readonly pickings: PickingView;
  readonly warehouses: WarehouseView;
  readonly serials: SerialView;
  readonly lpns: LpnView;

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
    this.warehouses = new WarehouseView(db, workspaceId);
    this.serials = new SerialView(db, workspaceId);
    this.lpns = new LpnView(db, workspaceId);
  }

  applyEvent(envelope: EventEnvelope): void {
    this.skus.applyEvent(envelope);
    this.locations.applyEvent(envelope);
    this.warehouses.applyEvent(envelope);
    this.serials.applyEvent(envelope);
    this.lpns.applyEvent(envelope);
    this.partners.applyEvent(envelope);
    this.orders.applyEvent(envelope);
    this.inventory.applyEvent(envelope);
    this.stocktakes.applyEvent(envelope);
    this.pickings.applyEvent(envelope);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM wms_sku WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_location WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_warehouse WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_serial WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_lpn_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_lpn WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_partner WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_order WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_order_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory_ledger WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory_hold WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_inventory_reservation WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_stocktake WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_stocktake_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_picking WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_picking_line WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_picking_allocation WHERE workspace_id = ?`).run(this.workspaceId);
    this.db.prepare(`DELETE FROM wms_order_conflict WHERE workspace_id = ?`).run(this.workspaceId);
    // 清掉已入账标记，全量重放才能把单据再写回来（标记还在的话 applyEvent 会整段跳过）。
    this.db.prepare(`DELETE FROM wms_order_apply WHERE workspace_id = ?`).run(this.workspaceId);
  }
}
