import type Database from 'better-sqlite3';
import { clearProjectionTables, type EventEnvelope, type ProjectionGroupSpec } from '@one/core';
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

/**
 * WMS 投影组的元数据：组名 + 版本 + 本组拥有的 20 张表。
 *
 * **加一张投影表就在这个清单里加一行**（建表在 db/migrations.ts），clear() 不用碰——
 * 漏登记会被 wms/test/projection-group.test.ts 对着 sqlite_master 查出来。
 * 顺序保持「先子表后主表」：外键当前没开强制，但确定性顺序让重放期的中间态可复现。
 */
export const WMS_PROJECTION_GROUP: ProjectionGroupSpec = {
  group: 'wms',
  codeVersion: WMS_PROJECTION_VERSION,
  tables: [
    { table: 'wms_sku' },
    { table: 'wms_location' },
    { table: 'wms_warehouse' },
    { table: 'wms_serial' },
    { table: 'wms_lpn_line' },
    { table: 'wms_lpn' },
    { table: 'wms_partner' },
    { table: 'wms_order_line' },
    { table: 'wms_order_conflict' },
    { table: 'wms_order_apply' },
    { table: 'wms_order' },
    { table: 'wms_inventory_ledger' },
    { table: 'wms_inventory_hold' },
    { table: 'wms_inventory_reservation' },
    { table: 'wms_inventory' },
    { table: 'wms_stocktake_line' },
    { table: 'wms_stocktake' },
    { table: 'wms_picking_line' },
    { table: 'wms_picking_allocation' },
    { table: 'wms_picking' },
  ],
};

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

  /**
   * 清空本组全部投影表（按 WMS_PROJECTION_GROUP.tables 清单驱动）。
   * 含 wms_order_apply：那是「已入账」标记，不清掉的话全量重放时 applyEvent
   * 会认为单据已入账而整段跳过，单据再也写不回来。
   * 由 replay() 在事务内调用。
   */
  clear(): void {
    clearProjectionTables(this.db, this.workspaceId, WMS_PROJECTION_GROUP.tables);
  }
}
