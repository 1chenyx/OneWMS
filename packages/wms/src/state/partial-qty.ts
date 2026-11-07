import { QTY_EPS } from './inventory-policy.js';
import {
  PartialDisabledError,
  PartialLineNotFoundError,
  PartialQtyExceededError,
  PartialUnwindError,
} from '../errors.js';

/** 参与一次库存效应的单据行。fulfilledQty 是已入账净量。 */
export interface PostingLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
  /**
   * 已入账净量：正数 = 净入库，负数 = 净出库，0 = 记过账但数量为零。
   * null = 没走过短收短发（按订单数量理解，含旧事件）。
   */
  readonly fulfilledQty: number | null;
}

/** 调用方声明的实收/实发。键已经解析成 sku + 库位 + 批次。 */
export interface PostingRequest {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly quantity: number;
}

export interface ResolvedPostLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  /** 本次库存移动的绝对值。0 = 不写流水。 */
  readonly move: number;
  /**
   * 本转移之后该行的净入账。undefined = 投影保持原样
   * （整单数量、且此前没记过短收短发）。
   */
  readonly nextPosted?: number;
}

export function postingLineKey(skuId: string, locationId: string, batchNo: string): string {
  return `${skuId}:${locationId}:${batchNo}`;
}

/**
 * 算出每行这次要移动的数量，以及要写进状态事件的净入账。
 * 模块关闭时，实收/实发必须等于订单数量。
 * 已经入过账的行，反向转移按已入账数量冲回，不能再改。
 */
export function resolvePostingMoves(args: {
  post: 'increase' | 'decrease';
  moduleEnabled: boolean;
  lines: readonly PostingLine[];
  requests: readonly PostingRequest[];
}): ResolvedPostLine[] {
  const known = new Set(args.lines.map((line) => postingLineKey(line.skuId, line.locationId, line.batchNo)));
  const requested = new Map<string, number>();
  for (const req of args.requests) {
    const key = postingLineKey(req.skuId, req.locationId, req.batchNo);
    if (requested.has(key) || !known.has(key)) throw new PartialLineNotFoundError(key);
    requested.set(key, req.quantity);
  }

  return args.lines.map((line) => {
    const key = postingLineKey(line.skuId, line.locationId, line.batchNo);
    const recorded = line.fulfilledQty;
    const asked = requested.get(key);
    const unwinding =
      recorded !== null &&
      ((args.post === 'decrease' && recorded >= 0) || (args.post === 'increase' && recorded <= 0));
    if (unwinding) {
      const move = Math.abs(recorded);
      if (asked !== undefined && Math.abs(asked - move) > QTY_EPS) {
        throw new PartialUnwindError(key, move, asked);
      }
      return {
        skuId: line.skuId,
        locationId: line.locationId,
        batchNo: line.batchNo,
        move,
        nextPosted: 0,
      };
    }

    const move = asked ?? line.quantity;
    if (move - line.quantity > QTY_EPS) throw new PartialQtyExceededError(key, line.quantity, move);
    if (!args.moduleEnabled && asked !== undefined && Math.abs(asked - line.quantity) > QTY_EPS) {
      throw new PartialDisabledError();
    }
    const record = Math.abs(move - line.quantity) > QTY_EPS || recorded !== null;
    return {
      skuId: line.skuId,
      locationId: line.locationId,
      batchNo: line.batchNo,
      move,
      nextPosted: record ? (args.post === 'increase' ? move : -move) : undefined,
    };
  });
}
