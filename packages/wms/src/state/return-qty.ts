import {
  OrderNotFoundError,
  ReturnDirectionError,
  ReturnDisabledError,
  ReturnLineNotFoundError,
  ReturnNotPostedError,
  ReturnOfReturnError,
  ReturnQtyExceededError,
} from '../errors.js';
import type { OrderDirection } from './order-state-machine.js';
import { QTY_EPS, quantizeQty } from './inventory-policy.js';

/**
 * 退货不新增状态。客退是入库单，指向已拣货、已发货或已完成的出库单；退供是出库单，指向已收货的入库单。
 * 额度按 SKU + 批次，不看库位：货可以退回到别的库位，也可以从别的库位退走。
 */

const INBOUND_POSTED = new Set(['received', 'putaway', 'done']);
const OUTBOUND_POSTED = new Set(['picked', 'shipped', 'done']);

export function sourceIsPosted(direction: OrderDirection, state: string): boolean {
  return direction === 'in' ? INBOUND_POSTED.has(state) : OUTBOUND_POSTED.has(state);
}

/**
 * 已入账数量。出库短发把净量记成负数，额度看绝对值。
 * null = 没记过短收短发，按订单数量。
 */
export function accountedQty(quantity: number, fulfilledQty: number | null): number {
  return fulfilledQty === null ? quantity : Math.abs(fulfilledQty);
}

/** 一张未取消的退货单占掉的数量。还没入账按订单数量占着；入账后按实数。 */
export function committedQty(state: string, quantity: number, fulfilledQty: number | null): number {
  if (state === 'canceled') return 0;
  if (state === 'created' || state === 'picking') return quantity;
  return accountedQty(quantity, fulfilledQty);
}

export interface ReturnQtyLine {
  readonly skuId: string;
  readonly batchNo: string;
  readonly quantity: number;
  readonly fulfilledQty: number | null;
}

function bucketKey(skuId: string, batchNo: string): string {
  return `${skuId}\u0000${batchNo}`;
}

/** 原单已入账数量，按 SKU + 批次合计。调用前原单必须已经入过账。 */
export function postedBySkuBatch(lines: readonly ReturnQtyLine[]): Map<string, number> {
  const posted = new Map<string, number>();
  for (const line of lines) {
    const key = bucketKey(line.skuId, line.batchNo);
    const qty = accountedQty(line.quantity, line.fulfilledQty);
    posted.set(key, (posted.get(key) ?? 0) + qty);
  }
  return posted;
}

/**
 * 退货额度认实绩。有流水时按单据名下的净变动：出库看发走的批次，入库看收进的批次。
 * 没有任何流水时回退到单据行（老数据、或整单实数为 0 没写流水）。
 */
export function postedBucketsForReturn(
  direction: OrderDirection,
  lines: readonly ReturnQtyLine[],
  movements: readonly { skuId: string; batchNo: string; net: number }[],
): Map<string, number> {
  if (movements.length === 0) return postedBySkuBatch(lines);
  const posted = new Map<string, number>();
  for (const row of movements) {
    const qty = direction === 'out' ? -row.net : row.net;
    if (qty <= QTY_EPS) continue;
    const key = bucketKey(row.skuId, row.batchNo);
    posted.set(key, (posted.get(key) ?? 0) + qty);
  }
  return posted;
}

/** 原单已入账减去未取消退货占掉的数量。 */
export function remainingBySkuBatch(
  sourceLines: readonly ReturnQtyLine[],
  priorReturns: readonly { state: string; lines: readonly ReturnQtyLine[] }[],
  posted?: Map<string, number>,
): Map<string, number> {
  const left = new Map(posted ?? postedBySkuBatch(sourceLines));
  for (const ret of priorReturns) {
    for (const line of ret.lines) {
      const key = bucketKey(line.skuId, line.batchNo);
      if (!left.has(key)) continue;
      const used = committedQty(ret.state, line.quantity, line.fulfilledQty);
      left.set(key, (left.get(key) ?? 0) - used);
    }
  }
  return left;
}

export function assertReturnLines(args: {
  moduleEnabled: boolean;
  returnOf: string;
  direction: OrderDirection;
  source: { orderNo: string; direction: OrderDirection; state: string; returnOfOrderId: string | null } | undefined;
  sourceLines: readonly ReturnQtyLine[];
  priorReturns: readonly { state: string; lines: readonly ReturnQtyLine[] }[];
  lines: readonly { skuId: string; skuCode: string; batchNo: string; quantity: number }[];
  /** 实绩额度。缺省时按单据行。 */
  posted?: Map<string, number>;
}): void {
  if (!args.moduleEnabled) throw new ReturnDisabledError();
  const source = args.source;
  if (!source) throw new OrderNotFoundError(args.returnOf);
  if (source.returnOfOrderId) throw new ReturnOfReturnError(source.orderNo);
  const expected: OrderDirection = source.direction === 'in' ? 'out' : 'in';
  if (args.direction !== expected) throw new ReturnDirectionError(source.orderNo, source.direction);
  if (!sourceIsPosted(source.direction, source.state)) {
    throw new ReturnNotPostedError(source.orderNo, source.state);
  }
  const left = remainingBySkuBatch(args.sourceLines, args.priorReturns, args.posted);
  const asked = new Map<string, { skuCode: string; batchNo: string; quantity: number }>();
  for (const line of args.lines) {
    const key = bucketKey(line.skuId, line.batchNo);
    if (!left.has(key)) throw new ReturnLineNotFoundError(line.skuCode, line.batchNo);
    const prev = asked.get(key);
    asked.set(key, {
      skuCode: line.skuCode,
      batchNo: line.batchNo,
      quantity: (prev?.quantity ?? 0) + line.quantity,
    });
  }
  for (const [key, row] of asked) {
    const remain = quantizeQty(left.get(key) ?? 0);
    const qty = quantizeQty(row.quantity);
    if (qty - remain > QTY_EPS) throw new ReturnQtyExceededError(row.skuCode, row.batchNo, remain, qty);
  }
}
