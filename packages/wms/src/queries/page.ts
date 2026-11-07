/** 列表分页壳，与 wms.ledger.query / wms.order.query / core.oplog.query 相同。 */
export interface ListPage<T> {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  rows: T[];
}

export function toListPage<T>(rows: T[], total: number, limit: number, offset: number): ListPage<T> {
  return { total, limit, offset, hasMore: offset + rows.length < total, rows };
}
