import type { OrderDirection } from '../state/order-state-machine.js';

/**
 * 领域事件目录（DESIGN.md §8.2 事件目录的 wms 子集）。
 *
 * 纪律：
 *  - 类型全部**过去时**——事件是已发生的事实，不是命令（§8.2）；
 *  - 命名空间 `wms.实体.动作`，与工具 id `wms.动词.名词` 区分；
 *  - payload 结构在此集中声明——投影与工具共用同一份类型，避免漂移。
 *
 * 依赖说明：本文件单向依赖 state/order-state-machine 的纯类型
 * （领域词汇表同源）；db/migrations.ts 反向引用本文件的 DEFAULT_LOCATION_ID
 * （DDL 插值单一来源）——两条都是基础层内登记依赖。
 */
export const WMS_EVENT_TYPES = {
  skuCreated: 'wms.sku.created',
  skuUpdated: 'wms.sku.updated',
  locationCreated: 'wms.location.created',
  locationUpdated: 'wms.location.updated',
  partnerCreated: 'wms.partner.created',
  partnerUpdated: 'wms.partner.updated',
  orderCreated: 'wms.order.created',
  orderStateChanged: 'wms.order.state_changed',
  orderConflictDismissed: 'wms.order.conflict_dismissed',
  orderConflictAccepted: 'wms.order.conflict_accepted',
  inventoryAdjusted: 'wms.inventory.adjusted',
  inventoryHeld: 'wms.inventory.held',
  inventoryReleased: 'wms.inventory.released',
  stocktakeCreated: 'wms.stocktake.created',
  stocktakeCounted: 'wms.stocktake.counted',
  stocktakeStateChanged: 'wms.stocktake.state_changed',
  pickingCreated: 'wms.picking.created',
  pickingPicked: 'wms.picking.picked',
  pickingStateChanged: 'wms.picking.state_changed',
} as const;

export type WmsEventType = (typeof WMS_EVENT_TYPES)[keyof typeof WMS_EVENT_TYPES];

/** 判断事件类型是否属于本领域（投影分发的第一道过滤） */
export function isWmsEventType(type: string): type is WmsEventType {
  return Object.values(WMS_EVENT_TYPES).includes(type as WmsEventType);
}

/**
 * 默认库位保留词（M10）——虚拟桶，不占 wms_location 表：
 *  - 所有「未指定库位」的库存/流水归宿（老库历史数据自动收敛于此）；
 *  - id 与 code 同值，工具层拒绝创建同名实体；
 *  - 放在 catalog（领域词汇表同源），migrations DDL 插值引用——单一来源。
 */
export const DEFAULT_LOCATION_ID = 'DEFAULT';

/**
 * 默认批次保留词（M11）——虚拟桶，不占任何实体表：
 *  - 所有「未指定批次」的库存/流水归宿（老库历史数据自动收敛于此）；
 *  - 与 DEFAULT_LOCATION_ID 同词面同语义「未指定」，工具层拒绝对它声明效期；
 *  - 放在 catalog（领域词汇表同源），migrations DDL 插值引用——单一来源。
 */
export const DEFAULT_BATCH_NO = 'DEFAULT';

// ── payload 结构 ──────────────────────────────────────────────

export interface SkuCreatedPayload {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name: string;
  /** 条码（M18，可选）：扫码枪识读用（EAN/Code128 等）；同库唯一（NULL 互不冲突） */
  readonly barcode?: string;
  /** 安全库存（M20，可选）：低库存预警阈值；0 = 不预警（缺省）。预警按可用量（余量−冻结）判定 */
  readonly reorderPoint?: number;
  /** 单位（A3，可选）：数量单位（如 kg / 箱 / 件）；空 = 数量不显示单位（兼容存量） */
  readonly unit?: string;
  /** 字段注册表驱动的扩展字段（§5.2：核心列固定 + ext_data JSON 列） */
  readonly extData?: Record<string, unknown>;
}

export interface SkuUpdatedPayload {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name?: string;
  /** 条码（M18，可选）：显式传才改（未传保持不变——与 name/extData 同一 LWW 语义） */
  readonly barcode?: string;
  /** 安全库存（M20，可选）：显式传才改；传 0 = 关闭该 SKU 的预警 */
  readonly reorderPoint?: number;
  /** 单位（A3，可选）：显式传才改；空串 = 清空单位 */
  readonly unit?: string;
  /**
   * 档案状态（A2 软停用）：active = 启用（缺省）；archived = 已停用。
   * 只由 wms.sku.archive / wms.sku.unarchive 两个专用工具写入（不开放给通用 update）——
   * 停用 = 从列表/选择器隐藏 + 退出低库存/效期预警；剩余库存照常可扣（数据一条不动）。
   */
  readonly status?: 'active' | 'archived';
  readonly extData?: Record<string, unknown>;
}

export interface LocationCreatedPayload {
  readonly locationId: string;
  readonly locationCode: string;
  readonly name: string;
}

/** 库位更名（LWW：只携带变更字段；locationCode 是业务键不可改——历史单据引用它） */
export interface LocationUpdatedPayload {
  readonly locationId: string;
  readonly locationCode: string;
  readonly name?: string;
}

// ── 往来单位（partner）payload ────────────────────────────────

/**
 * 往来单位诞生（M21）：供应商/客户统一实体（kind 区分），全库 partner_code 唯一。
 * created 携带全量字段；updated 只携带变更字段（LWW，未传保持不变）。
 */
export interface PartnerCreatedPayload {
  readonly partnerId: string;
  readonly partnerCode: string;
  /** supplier = 供应商（入库单往来单位）/ customer = 客户（出库单往来单位） */
  readonly kind: 'supplier' | 'customer';
  readonly name: string;
  readonly contact?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly note?: string;
  readonly extData?: Record<string, unknown>;
}

export interface PartnerUpdatedPayload {
  readonly partnerId: string;
  readonly partnerCode: string;
  readonly name?: string;
  readonly contact?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly note?: string;
  readonly extData?: Record<string, unknown>;
}

export interface OrderLinePayload {
  readonly skuId: string;
  readonly quantity: number;
  /** 收货上架/发货扣减的目标库位（镜像行内 skuId-only 先例不带 code；缺省 DEFAULT，投影层兜底） */
  readonly locationId?: string;
  /** 批次维度（M11）：入库行声明批次（新批次可带效期）、出库行指定扣减批次；缺省 DEFAULT 虚拟批次 */
  readonly batchNo?: string;
  /** 批次效期（YYYY-MM-DD，仅入库行有意义）：随收货流水登记，同批次后继流水须一致（工具层校验） */
  readonly batchExpiryDate?: string;
}

export interface OrderCreatedPayload {
  readonly orderId: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  /** 往来单位 id（M21，可选）：入库单=供应商 / 出库单=客户；缺省 null */
  readonly partnerId?: string;
  readonly lines: readonly OrderLinePayload[];
  readonly note?: string;
}

/** 一次转移之后某行的净入账（module.partial）。正=净入库，负=净出库，0=冲平或实数为零 */
export interface OrderFulfillmentPayload {
  readonly skuId: string;
  readonly locationId?: string;
  readonly batchNo?: string;
  readonly quantity: number;
}

export interface OrderStateChangedPayload {
  readonly orderId: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  /** 状态词汇由流程配置定义（模块可贡献新状态）——事件是事实记录，不持词汇表权威（M8） */
  readonly from: string;
  readonly to: string;
  /**
   * 本转移改写的行净入账。缺省 = 这些行仍按订单数量理解（旧事件、整单入账）。
   * 只在短收短发或冲销已记账的行时出现。
   */
  readonly fulfillments?: readonly OrderFulfillmentPayload[];
}

/** 关闭一条状态冲突（驳回或接受）。eventId 是冲突的那条 state_changed */
export interface OrderConflictResolvedPayload {
  readonly eventId: string;
  readonly orderId: string;
  readonly orderNo: string;
}

export interface InventoryAdjustedPayload {
  readonly skuId: string;
  readonly skuCode: string;
  /** 正数入库 / 负数出库——只有流水事件，没有「改库存」事件（§8.2） */
  readonly delta: number;
  readonly reason: string;
  /** 库位维度（M10）：镜像 skuId+skuCode 双携带先例；缺省 DEFAULT，投影层兜底 */
  readonly locationId?: string;
  readonly locationCode?: string;
  /** 批次维度（M11）：缺省 DEFAULT 虚拟批次，投影层兜底；批次随首条流水诞生（无实体表） */
  readonly batchNo?: string;
  /** 批次效期（YYYY-MM-DD）：同批次首个非空效期登记后，后继流水必须一致（工具层校验） */
  readonly batchExpiryDate?: string;
  readonly orderId?: string;
  readonly orderNo?: string;
}

// ── 冻结（M19）payload ─────────────────────────────────────────

/**
 * 冻结诞生（M19）：把某 SKU 的一部分数量冻结（质检隔离 / 客订预留等）。
 * 冻结量不可被单据出库消耗：可用量 = 全库位合计余量 − 冻结合计（SKU 级）。
 * 不落库存流水——冻结不改物理量，wms_inventory_ledger 只记物理增减；
 * 冻结的真相在 held/released 事件对，投影是 wms_inventory_hold 表。
 */
export interface InventoryHeldPayload {
  readonly holdId: string;
  readonly skuId: string;
  /** 镜像 skuId+skuCode 双携带先例（投影与调用方免联查） */
  readonly skuCode: string;
  readonly quantity: number;
  readonly reason: string;
}

/**
 * 冻结释放（M19）：整笔解除（按 holdId 定位）。released 事件不携带数量——
 * 数量在 held 事件里，投影按 holdId 删行；释放原因可选（如 质检合格放行）。
 */
export interface InventoryReleasedPayload {
  readonly holdId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly reason?: string;
}

// ── 盘点（M17）payload ─────────────────────────────────────────

/**
 * 盘点单诞生（M17）。范围是库位 id 列表：null = 全场盘点。
 * 事件只携带范围声明，不携带账面快照——账面行由投影在应用本事件时
 * 查库存汇总现值生成（事件是事实，快照是派生缓存，禁冗余）。
 */
export interface StocktakeCreatedPayload {
  readonly stocktakeId: string;
  readonly stocktakeNo: string;
  /** 盘点范围：库位 id 列表；null = 全场（所有库位含 DEFAULT 虚拟桶） */
  readonly locationIds: string[] | null;
  readonly note?: string;
}

/**
 * 一个桶的实盘数（M17）。同桶重盘 = 再落一条 counted 事件，投影 upsert 覆盖
 * （后到者胜，全序重放天然收敛）。countedQty 允许 0（盘亏到零）。
 */
export interface StocktakeCountedPayload {
  readonly stocktakeId: string;
  readonly stocktakeNo: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly batchNo: string;
  readonly countedQty: number;
}

/**
 * 盘点单生命周期（M17）：created → closed / canceled。
 * 固定语义词汇（不进 Profile workflows）——盘点的生命周期不因配置而变；
 * 差异调整不落新事件类型：close 发的就是普通 inventory.adjusted
 * （reason: stocktake:{单号}），与单据联动共用同一条流水通道。
 */
export interface StocktakeStateChangedPayload {
  readonly stocktakeId: string;
  readonly stocktakeNo: string;
  readonly from: string;
  readonly to: string;
}

// ── 拣货单（picking，M21）payload ─────────────────────────────

/** 拣货单行 payload：一行 = 关联出库单行（四段键定位）+ 建议桶 + 待拣量 */
export interface PickingLinePayload {
  /** 拣货单行 id（pickingId:orderLineId 派生，重放幂等键） */
  readonly lineId: string;
  readonly orderId: string;
  readonly orderNo: string;
  /** 关联出库单行 id（= orderId:skuId:locationId:batchNo 四段派生） */
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly qtyToPick: number;
  /** 建议桶（行声明的库位/批次；分配策略展开后的具体桶） */
  readonly suggestedLocationId: string;
  readonly suggestedLocationCode: string;
  readonly suggestedBatchNo: string;
}

/**
 * 拣货单诞生（M21）：聚合多张「拣货中」出库单的行成一张拣货单。
 * 行的建议桶随事件携带（建单时点的事实）；实拣是后续 picked 事件的增量。
 */
export interface PickingCreatedPayload {
  readonly pickingId: string;
  readonly pickingNo: string;
  readonly lines: readonly PickingLinePayload[];
  readonly note?: string;
}

/**
 * 一行实拣记录（M21）。pickedQty 是本行累计实拣量（后到者胜，重盘覆盖）；
 * 实拣桶缺省用建议桶，picker 可改拣其他库位/批次（记录事实）。
 * 不落库存流水——扣减发生在关单（close）时的 inventory.adjusted。
 */
export interface PickingPickedPayload {
  readonly pickingId: string;
  readonly pickingNo: string;
  readonly lineId: string;
  readonly pickedQty: number;
  readonly pickedLocationId?: string;
  readonly pickedLocationCode?: string;
  readonly pickedBatchNo?: string;
}

/**
 * 拣货单生命周期（M21）：created → closed / canceled（固定词汇，不进 Profile
 * workflows——M17 盘点先例）。close 联动的扣减是普通 inventory.adjusted
 * （reason: picking:{单号}）+ 各出库单的 order.state_changed，不落新事件类型。
 */
export interface PickingStateChangedPayload {
  readonly pickingId: string;
  readonly pickingNo: string;
  readonly from: string;
  readonly to: string;
}
