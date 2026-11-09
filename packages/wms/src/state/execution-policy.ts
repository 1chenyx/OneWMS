import { DEFAULT_BATCH_NO, DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { PickingSubstitutionError, SerialStockError } from '../errors.js';
import { QTY_EPS } from './inventory-policy.js';

/** 单据上写了批次或库位时怎么执行。没写的行始终是不限，不受这档约束。 */
export type SpecifiedConstraint = 'prefer' | 'lock';

export function specifiedConstraint(raw: unknown): SpecifiedConstraint {
  return raw === 'lock' ? 'lock' : 'prefer';
}

export interface SubstitutionCheck {
  readonly skuCode: string;
  readonly serialTracked: boolean;
  readonly returnOrder: boolean;
  readonly promiseLocationId: string;
  readonly promiseLocationCode: string;
  readonly promiseBatchNo: string;
  readonly actualLocationId: string;
  readonly actualLocationCode: string;
  readonly actualBatchNo: string;
  readonly batchConstraint: SpecifiedConstraint;
  readonly locationConstraint: SpecifiedConstraint;
}

/**
 * 实拣桶是否允许离开单据行。
 * 没填的批次、库位是不限。填了的按建议或锁定。
 * 序列号和退货单的批次是锁定，不看仓库设置。
 */
export function assertSubstitution(check: SubstitutionCheck): void {
  const batchDiff = check.actualBatchNo !== check.promiseBatchNo;
  const locationDiff = check.actualLocationId !== check.promiseLocationId;
  if (!batchDiff && !locationDiff) return;
  if (check.serialTracked) {
    throw new SerialStockError(`序列号必须从单据指定的库位批次拣出: ${check.skuCode}`);
  }
  if (check.returnOrder && batchDiff) {
    throw new PickingSubstitutionError(check.skuCode, '退货单的批次已锁定，只能拣原单上的批次');
  }
  if (
    check.promiseBatchNo !== DEFAULT_BATCH_NO &&
    batchDiff &&
    check.batchConstraint === 'lock'
  ) {
    throw new PickingSubstitutionError(
      check.skuCode,
      `批次已锁定在 ${check.promiseBatchNo}，不能改拣 ${check.actualBatchNo}`,
    );
  }
  if (
    check.promiseLocationId !== DEFAULT_LOCATION_ID &&
    locationDiff &&
    check.locationConstraint === 'lock'
  ) {
    throw new PickingSubstitutionError(
      check.skuCode,
      `库位已锁定在 ${check.promiseLocationCode}，不能改拣 ${check.actualLocationCode}`,
    );
  }
}

export interface PickBucket {
  locationId: string;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

/** 同一库位同一批次的数量合并。数量接近 0 的桶丢掉。 */
export function mergeBuckets(rows: readonly PickBucket[]): PickBucket[] {
  const merged = new Map<string, PickBucket>();
  for (const row of rows) {
    if (row.quantity <= QTY_EPS) continue;
    const key = `${row.locationId}\u0000${row.batchNo}`;
    const prev = merged.get(key);
    if (prev) prev.quantity += row.quantity;
    else merged.set(key, { ...row });
  }
  return [...merged.values()];
}
