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
 * （领域词汇表同源），是 wms 分层规则里登记的唯一基础层内依赖。
 */
export const WMS_EVENT_TYPES = {
  skuCreated: 'wms.sku.created',
  skuUpdated: 'wms.sku.updated',
  orderCreated: 'wms.order.created',
  orderStateChanged: 'wms.order.state_changed',
  inventoryAdjusted: 'wms.inventory.adjusted',
} as const;

export type WmsEventType = (typeof WMS_EVENT_TYPES)[keyof typeof WMS_EVENT_TYPES];

/** 判断事件类型是否属于本领域（投影分发的第一道过滤） */
export function isWmsEventType(type: string): type is WmsEventType {
  return Object.values(WMS_EVENT_TYPES).includes(type as WmsEventType);
}

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

export interface OrderLinePayload {
  readonly skuId: string;
  readonly quantity: number;
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
  readonly orderId?: string;
  readonly orderNo?: string;
}
