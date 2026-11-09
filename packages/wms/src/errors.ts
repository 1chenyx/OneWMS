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

// ── 多仓（module.warehouse）─────────────────────────

/** 模块关闭时拒绝新建仓库，也拒绝把库位划进仓库。 */
export class WarehouseDisabledError extends CoreError {
  constructor() {
    super(
      'WMS_WAREHOUSE_DISABLED',
      '多仓已关闭（module.warehouse）。请去掉仓库参数，或在设置里重新启用该模块。',
    );
  }
}

/** 仓库编码已存在 */
export class WarehouseAlreadyExistsError extends CoreError {
  constructor(warehouseCode: string) {
    super('WMS_WAREHOUSE_EXISTS', `仓库编码已存在: ${warehouseCode}`);
  }
}

/** 仓库不存在 */
export class WarehouseNotFoundError extends CoreError {
  constructor(warehouseCode: string) {
    super('WMS_WAREHOUSE_NOT_FOUND', `仓库不存在: ${warehouseCode}`);
  }
}

/** 模块关闭时拒绝序列号参数。 */
export class SerialDisabledError extends CoreError {
  constructor() {
    super(
      'WMS_SERIAL_DISABLED',
      '序列号已关闭（module.serial）。请去掉序列号参数，或在设置里重新启用该模块。',
    );
  }
}

/** 按序列号管理的商品，这次数量变动没有写序列号。 */
export class SerialRequiredError extends CoreError {
  constructor(skuCode: string) {
    super('WMS_SERIAL_REQUIRED', `SKU ${skuCode} 按序列号管理，请写上每一件的序列号`);
  }
}

/** 没按序列号管理的商品却带了序列号。 */
export class SerialNotTrackedError extends CoreError {
  constructor(skuCode: string) {
    super('WMS_SERIAL_NOT_TRACKED', `SKU ${skuCode} 不按序列号管理，请去掉序列号`);
  }
}

/** 件数和序列号个数对不上。 */
export class SerialCountError extends CoreError {
  constructor(skuCode: string, quantity: number, count: number) {
    super(
      'WMS_SERIAL_COUNT',
      `SKU ${skuCode} 的数量 ${quantity} 和序列号个数 ${count} 不一致。一个序列号对应一件`,
    );
  }
}

/** 要出库或移动的序列号不在这个库位批次上。 */
export class SerialNotFoundError extends CoreError {
  constructor(serialNo: string) {
    super('WMS_SERIAL_NOT_FOUND', `序列号不在库或不在这个库位批次: ${serialNo}`);
  }
}

/** 序列号已经在库，不能再入库。 */
export class SerialAlreadyInStockError extends CoreError {
  constructor(serialNo: string) {
    super('WMS_SERIAL_IN_STOCK', `序列号已在库: ${serialNo}`);
  }
}

/** 同一次提交里序列号重复。 */
export class SerialDuplicateError extends CoreError {
  constructor(serialNo: string) {
    super('WMS_SERIAL_DUPLICATE', `序列号重复: ${serialNo}`);
  }
}

/** 序列号和当前操作对不上：已有库存才启用、盘点改数、被单据占用、在托盘上。 */
export class SerialStockError extends CoreError {
  constructor(message: string) {
    super('WMS_SERIAL_STOCK', message);
  }
}

/** 模块关闭时拒绝托盘操作。 */
export class LpnDisabledError extends CoreError {
  constructor() {
    super('WMS_LPN_DISABLED', '托盘已关闭（module.lpn）。请去掉托盘操作，或在设置里重新启用该模块。');
  }
}

/** 托盘编码已存在 */
export class LpnAlreadyExistsError extends CoreError {
  constructor(lpnCode: string) {
    super('WMS_LPN_EXISTS', `托盘编码已存在: ${lpnCode}`);
  }
}

/** 托盘不存在 */
export class LpnNotFoundError extends CoreError {
  constructor(lpnCode: string) {
    super('WMS_LPN_NOT_FOUND', `托盘不存在: ${lpnCode}`);
  }
}

/** 要动的数量里有一部分已经装在托盘上。 */
export class LpnPackedError extends CoreError {
  constructor(label: string, take: number, loose: number) {
    super('WMS_LPN_PACKED', `${label} 可动数量只有 ${loose}，这次要动 ${take}。已装托盘的货请整托移动或先卸下`);
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

/** 修订碰到了已经入账、已结束，或这张单当前不允许的字段 */
export class OrderReviseRejectedError extends CoreError {
  constructor(message: string) {
    super('WMS_ORDER_REVISE_REJECTED', message);
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

/**
 * 其他出库单已占用（module.reservation）。只拦单据出库。
 * 占用方自己的发货不撞这条；手工调整、移库、盘点也不看占用。
 */
export class StockReservedError extends CoreError {
  constructor(label: string, requested: number, onHand: number, reserved: number, held = 0) {
    const free = onHand - held - reserved;
    super(
      'WMS_STOCK_RESERVED',
      `SKU ${label} 已被其他出库单占用：余量 ${onHand}，冻结 ${held}，占用 ${reserved}，可再出库 ${free}，需出库 ${requested}`,
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

/** 冲突队列里没有这条事件 */
export class OrderConflictNotFoundError extends CoreError {
  constructor(eventId: string) {
    super('WMS_CONFLICT_NOT_FOUND', `状态冲突不存在: ${eventId}`);
  }
}

/** 冲突已经接受或驳回 */
export class OrderConflictClosedError extends CoreError {
  constructor(eventId: string) {
    super('WMS_CONFLICT_CLOSED', `状态冲突已裁决: ${eventId}`);
  }
}

/** 冻结单不存在（M19：活动冻结里找不到该 holdId——从未创建或已释放） */
export class HoldNotFoundError extends CoreError {
  constructor(holdId: string) {
    super('WMS_HOLD_NOT_FOUND', `冻结单不存在或已释放: ${holdId}`);
  }
}

/**
 * 历史错误码。投影不再抛出：from 对不上的 state_changed 进入冲突队列。
 * 保留类型，避免已编译的调用方断开。
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

// ── 往来单位（M21）───────────────────────────────────

/** 往来单位编码已存在（业务键唯一） */
export class PartnerAlreadyExistsError extends CoreError {
  constructor(partnerCode: string) {
    super('WMS_PARTNER_EXISTS', `往来单位编码已存在: ${partnerCode}`);
  }
}

/** 往来单位不存在 */
export class PartnerNotFoundError extends CoreError {
  constructor(partnerCode: string) {
    super('WMS_PARTNER_NOT_FOUND', `往来单位不存在: ${partnerCode}`);
  }
}

/** 往来单位种类与单据方向不匹配（入库=供应商 / 出库=客户） */
export class PartnerKindMismatchError extends CoreError {
  constructor(partnerCode: string, kind: string, direction: string) {
    super(
      'WMS_PARTNER_KIND_MISMATCH',
      `往来单位 ${partnerCode} 是${kind === 'supplier' ? '供应商' : '客户'}，不适用于${
        direction === 'in' ? '入库' : '出库'
      }单（入库单选供应商，出库单选客户）`,
    );
  }
}

// ── 上架（M21，module.putaway）───────────────────────

/** 上架只对入库单开放（出库单调用了 wms.order.putaway） */
export class PutawayOnlyInboundError extends CoreError {
  constructor(orderNo: string) {
    super('WMS_PUTAWAY_ONLY_INBOUND', `上架只适用于入库单：${orderNo} 是出库单`);
  }
}

/** 上架目标行未找到（sku+源库位+批次 匹配不到入库单行） */
export class PutawayLineNotFoundError extends CoreError {
  constructor(orderNo: string, lineKey: string) {
    super('WMS_PUTAWAY_LINE_NOT_FOUND', `入库单 ${orderNo} 中找不到匹配的上架行: ${lineKey}`);
  }
}

// ── 短收短发（module.partial）────────────────────────

/** 模块关闭时拒绝改少数量。不传 lines 时仍按订单数量整单入账。 */
export class PartialDisabledError extends CoreError {
  constructor() {
    super(
      'WMS_PARTIAL_DISABLED',
      '短收短发已关闭（module.partial）。这次转移请按订单数量整单入账，或在设置里重新启用该模块。',
    );
  }
}

/** 实收/实发对不上单据行，或同一行指定了两次 */
export class PartialLineNotFoundError extends CoreError {
  constructor(lineKey: string) {
    super('WMS_PARTIAL_LINE', `单据里没有这条明细，或实收/实发重复指定了它: ${lineKey}`);
  }
}

/** 实收/实发大于订单数量 */
export class PartialQtyExceededError extends CoreError {
  constructor(lineKey: string, ordered: number, actual: number) {
    super('WMS_PARTIAL_QTY', `明细 ${lineKey} 的实收/实发 ${actual} 大于订单数量 ${ordered}`);
  }
}

/** 已经入过账的行，冲销只能按已入账数量，不能再改 */
export class PartialUnwindError extends CoreError {
  constructor(lineKey: string, posted: number, asked: number) {
    super('WMS_PARTIAL_UNWIND', `明细 ${lineKey} 已入账 ${posted}，冲销不能改成 ${asked}`);
  }
}

/** 这次转移不动库存，不接受实收/实发 */
export class PartialNotOnPostError extends CoreError {
  constructor() {
    super('WMS_PARTIAL_NOT_ON_POST', '这次转移不动库存，不能改实收/实发数量');
  }
}

// ── 退货（module.return）────────────────────────────

/** 模块关闭时拒绝带原单号建单。不带原单号的出入库不受影响。 */
export class ReturnDisabledError extends CoreError {
  constructor() {
    super('WMS_RETURN_DISABLED', '退货已关闭（module.return）。请去掉原单号，或在设置里重新启用该模块。');
  }
}

/** 退货方向必须和原单相反 */
export class ReturnDirectionError extends CoreError {
  constructor(orderNo: string, sourceDirection: string) {
    const hint = sourceDirection === 'out' ? '入库单（客退）' : '出库单（退供）';
    super('WMS_RETURN_DIRECTION', `原单 ${orderNo} 只能开${hint}`);
  }
}

/** 原单还没入账，没有可退的数量 */
export class ReturnNotPostedError extends CoreError {
  constructor(orderNo: string, state: string) {
    super('WMS_RETURN_NOT_POSTED', `原单 ${orderNo} 当前是 ${state}，还没有入账，不能退货`);
  }
}

/** 退货单不能再当原单 */
export class ReturnOfReturnError extends CoreError {
  constructor(orderNo: string) {
    super('WMS_RETURN_OF_RETURN', `${orderNo} 本身是退货单，不能再对它退货`);
  }
}

/** 原单没有这个 SKU + 批次 */
export class ReturnLineNotFoundError extends CoreError {
  constructor(skuCode: string, batchNo: string) {
    super('WMS_RETURN_LINE', `原单没有 SKU ${skuCode} 批次 ${batchNo}`);
  }
}

/** 超过原单剩余可退数量 */
export class ReturnQtyExceededError extends CoreError {
  constructor(skuCode: string, batchNo: string, remaining: number, asked: number) {
    super(
      'WMS_RETURN_QTY',
      `SKU ${skuCode} 批次 ${batchNo} 还可退 ${remaining}，这次要退 ${asked}`,
    );
  }
}

/** 退货行的批次必须是原单上的批次，不能再按策略拆 */
export class ReturnAllocationError extends CoreError {
  constructor() {
    super('WMS_RETURN_ALLOCATION', '退货单不分配批次，请按原单批次填写，不要传 allocation');
  }
}

// ── 到货预报（module.asn）──────────────────────────

/** 模块关闭时拒绝开预报。不带预报参数的直接入库不受影响。 */
export class AsnDisabledError extends CoreError {
  constructor() {
    super('WMS_ASN_DISABLED', '到货预报已关闭（module.asn）。请去掉预报参数，或在设置里重新启用该模块。');
  }
}

/** 预报只适用于入库 */
export class AsnDirectionError extends CoreError {
  constructor() {
    super('WMS_ASN_DIRECTION', '到货预报只能开入库单');
  }
}

/** 预报和退货不能是同一张单 */
export class AsnWithReturnError extends CoreError {
  constructor() {
    super('WMS_ASN_WITH_RETURN', '到货预报不能同时是退货单');
  }
}

/** 预计到货日必须是 YYYY-MM-DD，且只能写在预报单上 */
export class AsnExpectedAtError extends CoreError {
  constructor(value: string) {
    super('WMS_ASN_EXPECTED_AT', `预计到货日无效：${value}。请用 YYYY-MM-DD，并且要打开到货预报。`);
  }
}

// ── 补货（module.replenish）─────────────────────────

/** 模块关闭时拒绝生成补货单。低库存预警不受影响。 */
export class ReplenishDisabledError extends CoreError {
  constructor() {
    super(
      'WMS_REPLENISH_DISABLED',
      '补货已关闭（module.replenish）。低库存预警仍在；请在设置里重新启用该模块后再生成补货单。',
    );
  }
}

/** 没有可补的数量。不产生事件。 */
export class ReplenishEmptyError extends CoreError {
  constructor() {
    super('WMS_REPLENISH_EMPTY', '没有需要补的货');
  }
}

/** 指定的 SKU 当前没有正的补货缺口（已停用、不缺、或在途已经盖住） */
export class ReplenishNotShortError extends CoreError {
  constructor(skuCode: string) {
    super('WMS_REPLENISH_NOT_SHORT', `SKU ${skuCode} 没有需要补的数量`);
  }
}

/** 上架源桶余量不足（该行收货入库的库位/批次余量已被挪用） */
export class PutawaySourceShortError extends CoreError {
  constructor(skuCode: string, locationCode: string, batchNo: string, needed: number, available: number) {
    super(
      'WMS_PUTAWAY_SOURCE_SHORT',
      `SKU ${skuCode} 在库位 ${locationCode} 批次 ${batchNo} 余量不足：需 ${needed}，仅有 ${available}——该行收货库存已被挪用`,
    );
  }
}

// ── 拣货单（M21）─────────────────────────────────────

/** 拣货单不存在 */
export class PickingNotFoundError extends CoreError {
  constructor(pickingNo: string) {
    super('WMS_PICKING_NOT_FOUND', `拣货单不存在: ${pickingNo}`);
  }
}

/** 拣货单号已存在（业务键唯一） */
export class PickingExistsError extends CoreError {
  constructor(pickingNo: string) {
    super('WMS_PICKING_EXISTS', `拣货单号已存在: ${pickingNo}`);
  }
}

/** 拣货单不在拣货中状态（pick/close/cancel 只对 created 态开放） */
export class PickingNotOpenError extends CoreError {
  constructor(pickingNo: string, state: string) {
    const label = state === 'closed' ? '已关单' : state === 'canceled' ? '已取消' : state;
    super('WMS_PICKING_NOT_OPEN', `拣货单 ${pickingNo} 已${label}——只有拣货中的单据才能操作`);
  }
}

/** 关单时仍有未拣满的行 */
export class PickingIncompleteError extends CoreError {
  constructor(pickingNo: string, unpicked: number) {
    super(
      'WMS_PICKING_INCOMPLETE',
      `拣货单 ${pickingNo} 还有 ${unpicked} 行未拣满——全部行实拣数量等于应拣数量后才能关单（不需要的行请拣 0）`,
    );
  }
}

/** 实拣量超过应拣量 */
export class PickingOverPickError extends CoreError {
  constructor(pickingNo: string, lineKey: string, toPick: number, already: number, given: number) {
    super(
      'WMS_PICKING_OVER_PICK',
      `拣货单 ${pickingNo} 行 ${lineKey} 实拣超量：应拣 ${toPick}，已拣 ${already}，本次 ${given}`,
    );
  }
}

/** 建单时出库单不在「拣货中」状态 */
export class PickingOrderStateError extends CoreError {
  constructor(orderNo: string, state: string) {
    super(
      'WMS_PICKING_ORDER_STATE',
      `出库单 ${orderNo} 当前状态为 ${state}——只有「拣货中」状态的出库单才能聚合进拣货单`,
    );
  }
}

/** 拣货单行未找到（pickingNo + orderNo + skuCode + 建议批次 定位不到行） */
export class PickingLineNotFoundError extends CoreError {
  constructor(pickingNo: string, lineKey: string) {
    super('WMS_PICKING_LINE_NOT_FOUND', `拣货单 ${pickingNo} 中没有匹配的行：${lineKey}`);
  }
}

/** 建单时未提供任何出库单 */
export class PickingNoOrdersError extends CoreError {
  constructor() {
    super('WMS_PICKING_NO_ORDERS', 'orderNos 不能为空——至少聚合一张「拣货中」状态的出库单');
  }
}
