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
  orderCreated: 'wms.order.created',
  orderStateChanged: 'wms.order.state_changed',
  inventoryAdjusted: 'wms.inventory.adjusted',
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
  /** 字段注册表驱动的扩展字段（§5.2：核心列固定 + ext_data JSON 列） */
  readonly extData?: Record<string, unknown>;
}

export interface SkuUpdatedPayload {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name?: string;
  readonly extData?: Record<string, unknown>;
}

export interface LocationCreatedPayload {
  readonly locationId: string;
  readonly locationCode: string;
  readonly name: string;
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
  readonly lines: readonly OrderLinePayload[];
  readonly note?: string;
}

export interface OrderStateChangedPayload {
  readonly orderId: string;
  readonly orderNo: string;
  readonly direction: OrderDirection;
  /** 状态词汇由流程配置定义（模块可贡献新状态）——事件是事实记录，不持词汇表权威（M8） */
  readonly from: string;
  readonly to: string;
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
