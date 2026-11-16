import { describe, expect, it } from 'vitest';
import {
  BOARD_STOCK,
  BOARD_STOCK_FULL,
  conflictLine,
  inventorySummaryPath,
  locationContentsPath,
  manageOrderListPath,
  putawayCount,
  readBoard,
  receiveCount,
  showReserved,
  skuLocationPath,
  todayFlowPoint,
  utcDay,
  warehouseStockPath,
  type OrderStateCount,
} from '../src/board/model.js';
import { putawayListPath } from '../src/putaway/model.js';
import { receiveListPath } from '../src/receive/model.js';

const orders: OrderStateCount[] = [
  { direction: 'in', state: 'created', count: 2 },
  { direction: 'in', state: 'announced', count: 1 },
  { direction: 'in', state: 'received', count: 4 },
  { direction: 'in', state: 'inspected', count: 1 },
  { direction: 'out', state: 'created', count: 7 },
];

describe('管理看板口径', () => {
  it('待收只加已创建和预报，待上架跟质检开关走', () => {
    expect(receiveCount(orders)).toBe(3);
    expect(putawayCount(orders, false)).toBe(5);
    expect(putawayCount(orders, true)).toBe(1);
  });

  it('今日收发只取服务器 UTC 那一天', () => {
    const day = utcDay();
    const point = todayFlowPoint(
      [
        { day: '2000-01-01', inbound: 99, outbound: 88 },
        { day, inbound: 3, outbound: 1 },
      ],
      day,
    );
    expect(point).toEqual({ day, inbound: 3, outbound: 1 });
    expect(todayFlowPoint([{ day: '2000-01-01', inbound: 99, outbound: 88 }], day)).toBeNull();
  });

  it('单据下钻与现场同一组状态，但不带仓库', () => {
    expect(manageOrderListPath('receive', true, 0)).toBe(receiveListPath(null, 0));
    expect(manageOrderListPath('putaway', false, 0)).toBe(putawayListPath(false, null, 0));
    expect(manageOrderListPath('putaway', true, 50)).toBe(putawayListPath(true, null, 50));
    expect(manageOrderListPath('putaway', true, 50)).toBe(
      '/api/orders?direction=in&state=inspected&sort=updatedAtAsc&limit=50&offset=50',
    );
    expect(manageOrderListPath('receive', false, 0)).not.toContain('warehouseCode');
    expect(manageOrderListPath('putaway', false, 0)).not.toContain('warehouseCode');
  });

  it('低库存下钻用 full=1，库存查找不走 lowOnly', () => {
    expect(BOARD_STOCK).toBe('/api/dashboard/stock');
    expect(BOARD_STOCK_FULL).toBe('/api/dashboard/stock?full=1');
    expect(BOARD_STOCK_FULL).not.toContain('lowOnly');
    expect(inventorySummaryPath('A-1')).toBe('/api/inventory?skuCode=A-1&limit=5');
    expect(skuLocationPath('A-1')).toBe('/api/inventory/slices?view=location&q=A-1&limit=50');
    expect(locationContentsPath('A-01')).toBe('/api/inventory/slices?view=location&locationCode=A-01&limit=50');
    expect(warehouseStockPath('WH 1')).toBe('/api/warehouses/WH%201/stock');
    expect(inventorySummaryPath('A-1')).not.toContain('lowOnly');
  });

  it('冲突行用 fromState、toState、actualState', () => {
    expect(conflictLine({ eventId: 'e1', orderNo: 'IN-3', fromState: 'created', toState: 'received', actualState: 'canceled' })).toBe(
      'IN-3 created → received，实际 canceled',
    );
  });

  it('占用在本行大于 0 或全库还有占用时才出现', () => {
    expect(showReserved(0, false)).toBe(false);
    expect(showReserved(0, true)).toBe(true);
    expect(showReserved(2, false)).toBe(true);
  });

  it('看板把出库张数留在外面', () => {
    const home = readBoard(
      {
        orders,
        workload: { pickingOpen: 2 },
        stock: { lowStockCount: 0, lowStock: [] },
        urgent: [],
        alerts: { expiredCount: 0, criticalCount: 0, warningCount: 0, holdCount: 0, negativeCount: 0, negativeBuckets: [] },
        flow: [{ day: '2000-01-01', inbound: 99, outbound: 88 }],
        conflicts: [],
      },
      false,
      '2026-11-16',
    );
    expect(home?.receive).toBe(3);
    expect(home?.putaway).toBe(5);
    expect(home?.today).toBeNull();
  });
});
