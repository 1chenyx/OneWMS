import { CoreError } from '@one/core';

/**
 * 领域错误（@one/wms）。
 * 全部继承内核 CoreError——code 机器可读，UI / AI 工具层用同一套识别逻辑。
 * 工具 handler 抛出的业务拒绝 = DESIGN.md §4.2「规则即护栏」的墙。
 */

/** SKU 编码已存在（业务键唯一） */
export class SkuAlreadyExistsError extends CoreError {
  constructor(skuCode: string) {
    super('WMS_SKU_EXISTS', `SKU 编码已存在: ${skuCode}`);
  }
}

/** SKU 不存在 */
export class SkuNotFoundError extends CoreError {
  constructor(skuCode: string) {
    super('WMS_SKU_NOT_FOUND', `SKU 不存在: ${skuCode}`);
  }
}

/** SKU 条码已被其他 SKU 占用（M18：同库条码唯一——扫码识读不允许二义） */
export class SkuBarcodeExistsError extends CoreError {
  constructor(barcode: string, skuCode: string) {
    super('WMS_SKU_BARCODE_EXISTS', `条码 ${barcode} 已被 SKU ${skuCode} 使用`);
  }
}

/** 单据号已存在 */
export class OrderAlreadyExistsError extends CoreError {
  constructor(orderNo: string) {
    super('WMS_ORDER_EXISTS', `单据号已存在: ${orderNo}`);
  }
}

/** 库位编码已存在（业务键唯一，M10） */
export class LocationAlreadyExistsError extends CoreError {
  constructor(locationCode: string) {
    super('WMS_LOCATION_EXISTS', `库位编码已存在: ${locationCode}`);
  }
}

/** 库位不存在（M10） */
export class LocationNotFoundError extends CoreError {
  constructor(locationCode: string) {
    super('WMS_LOCATION_NOT_FOUND', `库位不存在: ${locationCode}`);
  }
}

/** 批次效期不一致（M11：同 SKU 同批次首个非空效期登记后，后继流水必须一致） */
export class BatchExpiryMismatchError extends CoreError {
  constructor(skuCode: string, batchNo: string, known: string, given: string) {
    super(
      'WMS_BATCH_EXPIRY_MISMATCH',
      `SKU ${skuCode} 批次 ${batchNo} 效期不一致：已登记 ${known}，本次声明 ${given}`,
    );
  }
}

/**
 * 批次分配失败（M12）：出库行走分配策略时，行库位内全部批次桶合计余量不足。
 * 区别于 InsufficientStockError（指定桶不足）：这是「策略扫遍全库位仍凑不齐」。
 */
export class AllocationInsufficientError extends CoreError {
  constructor(skuCode: string, locationCode: string, requested: number, available: number) {
    super(
      'WMS_ALLOCATION_INSUFFICIENT',
      `SKU ${skuCode} 在库位 ${locationCode} 各批次合计余量不足：需 ${requested}，仅有 ${available}`,
    );
  }
}

/**
 * 过期批次出库拦截（M13）：settings.blockExpiredOutbound 开启后，单据出库
 * （拣货预检/发货扣减）遇到效期早于今日的批次即拒绝——今天到期 = 临期可出。
 * 效期以流水中该批次首个非空登记为准（expiryOfBatch 同源）。
 */
export class ExpiredBatchError extends CoreError {
  constructor(skuCode: string, batchNo: string, expiry: string) {
    super('WMS_BATCH_EXPIRED', `SKU ${skuCode} 批次 ${batchNo} 已于 ${expiry} 过期，拒绝出库`);
  }
}

/** 单据不存在 */
export class OrderNotFoundError extends CoreError {
  constructor(orderNo: string) {
    super('WMS_ORDER_NOT_FOUND', `单据不存在: ${orderNo}`);
  }
}

/** 状态机非法转移（命令侧拒绝——工具校验的第一道墙） */
export class InvalidTransitionError extends CoreError {
  constructor(direction: string, from: string, to: string, legal: readonly string[]) {
    super(
      'WMS_INVALID_TRANSITION',
      `${direction === 'in' ? '入库' : '出库'}单不允许 ${from} → ${to}；合法后继: ${
        legal.length ? legal.join(', ') : '（终态）'
      }`,
    );
  }
}

/** 方向对应的流程定义缺失（M8：配置是唯一行为权威，缺配置不静默回退硬编码表） */
export class WorkflowNotFoundError extends CoreError {
  constructor(direction: string) {
    super(
      'WMS_WORKFLOW_NOT_FOUND',
      `${direction === 'in' ? '入库' : '出库'}单的流程定义（workflows.${
        direction === 'in' ? 'inbound' : 'outbound'
      }）不存在——请经配置确认通道恢复流程定义后再流转`,
    );
  }
}

/** 库存不足（负库存防线——DESIGN.md §7.2 对抗型冲突的 v1 默认规则） */
export class InsufficientStockError extends CoreError {
  constructor(skuCode: string, requested: number, available: number) {
    super(
      'WMS_INSUFFICIENT_STOCK',
      `SKU ${skuCode} 库存不足：需出库 ${Math.abs(requested)}，当前余量 ${available}`,
    );
  }
}

// ── 冻结（M19）───────────────────────────────────────

/**
 * 冻结量不可出库（M19）：单据出库撞上活动冻结——SKU 级可用量 =
 * 全库位合计余量 − 冻结合计。只拦单据出库（对齐 M13 过期拦截先例：
 * 库存调整/移库/盘点修正是物理修正通道，不拦）。
 */
export class StockHeldError extends CoreError {
  constructor(skuCode: string, requested: number, total: number, held: number) {
    super(
      'WMS_STOCK_HELD',
      `SKU ${skuCode} 可用量不足：余量 ${total}，冻结 ${held}，可用 ${total - held}，需出库 ${requested}`,
    );
  }
}

/** 冻结量超过账面余量（M19：已冻结合计 + 本次 ≤ 全库位合计余量，fail-fast 挡荒谬冻结） */
export class HoldExceedsStockError extends CoreError {
  constructor(skuCode: string, quantity: number, total: number, held: number) {
    super(
      'WMS_HOLD_EXCEEDS_STOCK',
      `SKU ${skuCode} 冻结超量：余量 ${total}，已冻结 ${held}，再冻 ${quantity} 超出账面`,
    );
  }
}

/** 冻结单不存在（M19：活动冻结里找不到该 holdId——从未创建或已释放） */
export class HoldNotFoundError extends CoreError {
  constructor(holdId: string) {
    super('WMS_HOLD_NOT_FOUND', `冻结单不存在或已释放: ${holdId}`);
  }
}

/**
 * 投影期状态冲突：state_changed 事件的 from 与投影当前态不匹配。
 * 唯一真冲突（§8.3）——v1 直接抛错停下；冲突队列 + 人工裁决是里程碑 5 的事。
 */
export class OrderStateConflictError extends CoreError {
  constructor(orderNo: string, eventFrom: string, actual: string) {
    super(
      'WMS_STATE_CONFLICT',
      `单据 ${orderNo} 状态冲突：事件声明 ${eventFrom} → 实际当前 ${actual}（并发状态转移，待人工裁决）`,
    );
  }
}

// ── 盘点（M17）───────────────────────────────────────

/** 盘点单不存在 */
export class StocktakeNotFoundError extends CoreError {
  constructor(stocktakeNo: string) {
    super('WMS_STOCKTAKE_NOT_FOUND', `盘点单不存在: ${stocktakeNo}`);
  }
}

/** 盘点单号已存在（业务键唯一） */
export class StocktakeExistsError extends CoreError {
  constructor(stocktakeNo: string) {
    super('WMS_STOCKTAKE_EXISTS', `盘点单号已存在: ${stocktakeNo}`);
  }
}

/** 盘点单不在盘点中状态（count/close/cancel 只对 created 态开放） */
export class StocktakeNotOpenError extends CoreError {
  constructor(stocktakeNo: string, state: string) {
    const label = state === 'closed' ? '已关单' : state === 'canceled' ? '已取消' : state;
    super('WMS_STOCKTAKE_NOT_OPEN', `盘点单 ${stocktakeNo} 已${label}——只有盘点中的单据才能操作`);
  }
}

/** 关单时仍有未盘行（全部行录入实盘数后才能关单收敛差异） */
export class StocktakeLinesUncountedError extends CoreError {
  constructor(stocktakeNo: string, uncounted: number) {
    super(
      'WMS_STOCKTAKE_LINES_UNCOUNTED',
      `盘点单 ${stocktakeNo} 还有 ${uncounted} 行未录实盘数——全部录完后才能关单（不需要的行请录 0）`,
    );
  }
}

/** 实盘录入的库位不在盘点范围内 */
export class StocktakeScopeViolationError extends CoreError {
  constructor(stocktakeNo: string, locationCode: string) {
    super(
      'WMS_STOCKTAKE_SCOPE_VIOLATION',
      `库位 ${locationCode} 不在盘点单 ${stocktakeNo} 的盘点范围内`,
    );
  }
}
