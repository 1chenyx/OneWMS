import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import DashboardPage from '../src/pages/DashboardPage';
import { AppNavProvider, useAppNav } from '../src/app-nav';

/**
 * 运营看板把库存、作业积压、临期和流水放在同一屏。
 * 数据层整页 mock：这里只断言排版和跳转，不算数。
 */

const snapshot = {
  workspaceId: 'ws-test',
  version: 1,
  schema: { entities: {} },
  workflows: {
    inbound: {
      states: [
        { id: 'created', label: '已创建' },
        { id: 'done', label: '已完成' },
        { id: 'canceled', label: '已取消' },
      ],
      transitions: [],
    },
    outbound: {
      states: [
        { id: 'picking', label: '拣货中' },
        { id: 'done', label: '已完成' },
        { id: 'canceled', label: '已取消' },
      ],
      transitions: [],
    },
  },
  modules: {
    'module.wave': { enabled: false },
    'module.picking': { enabled: false },
  },
  roles: {},
} as unknown as ProfileSnapshot;

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshot }),
  useDashboardOverview: () => ({
    isLoading: false,
    data: {
      skuCount: 3,
      totalQuantity: 40,
      openOrderCount: 3,
      locationCount: 2,
      locationUsedCount: 1,
      openPickingCount: 2,
      activeHoldCount: 1,
      expiringSoonCount: 1,
    },
  }),
  useDashboardFlowTrend: () => ({
    isLoading: false,
    data: [
      { day: '2026-11-12', inbound: 0, outbound: 0 },
      { day: '2026-11-13', inbound: 6, outbound: 2 },
    ],
  }),
  useDashboardLocations: () => ({
    isLoading: false,
    data: [{ locationCode: 'A-01', quantity: 40 }],
  }),
  useDashboardOrders: () => ({
    isLoading: false,
    data: [
      { direction: 'in', state: 'created', count: 2 },
      { direction: 'in', state: 'done', count: 4 },
      { direction: 'out', state: 'picking', count: 1 },
    ],
  }),
  useDashboardAlerts: () => ({
    isLoading: false,
    data: {
      expiredCount: 1,
      criticalCount: 0,
      warningCount: 0,
      holdCount: 1,
      negativeCount: 0,
      negativeBuckets: [],
    },
  }),
  useDashboardWorkload: () => ({
    isLoading: false,
    data: {
      inboundOpen: 3,
      outboundOpen: 1,
      pickingOpen: 2,
      waveOpen: 0,
      stocktakeOpen: 0,
      transferOpen: 1,
      transferInTransit: 1,
      scrapOpen: 0,
    },
  }),
  useDashboardStock: () => ({
    isLoading: false,
    data: {
      onHand: 40,
      held: 5,
      reserved: 0,
      available: 35,
      lowStockCount: 1,
      lowStock: [
        { skuCode: 'GAP-1', name: '缺货件', unit: '个', total: 2, available: 2, reorderPoint: 10, shortage: 8 },
      ],
      topSkus: [
        { skuCode: 'BIG-1', name: '大货', unit: null, quantity: 40, available: 35, held: 5, reserved: 0 },
      ],
      holds: [{ id: 'h-1', skuCode: 'GAP-1', name: '缺货件', quantity: 5, reason: '质检隔离', createdAt: '2026-11-13T01:00:00.000Z' }],
    },
  }),
  useDashboardActivity: () => ({
    isLoading: false,
    data: [
      {
        eventId: 'e-1',
        skuCode: 'BIG-1',
        name: '大货',
        locationCode: 'A-01',
        batchNo: 'DEFAULT',
        delta: 6,
        reason: 'putaway:IN-1',
        orderNo: 'IN-1',
        createdAt: '2026-11-13T08:30:00.000Z',
      },
    ],
  }),
  useDashboardUrgent: () => ({
    isLoading: false,
    data: [
      {
        skuCode: 'OLD-1',
        name: '过期胶',
        batchNo: 'B-OLD',
        batchExpiryDate: '2026-11-10',
        daysLeft: -3,
        level: 'expired',
        quantity: 4,
        unit: null,
      },
    ],
  }),
}));

function Where() {
  const nav = useAppNav();
  return (
    <div>
      <span data-testid="where">{nav.page}</span>
      <button
        type="button"
        onClick={() => {
          const filter = nav.takeInitialFilter();
          const slot = document.getElementById('filter-slot');
          if (slot) slot.textContent = filter?.skuCode ?? '';
        }}
      >
        读过滤
      </button>
      <span id="filter-slot" />
    </div>
  );
}

function wrap(ui: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>
            <Where />
            {ui}
          </AppNavProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('运营看板', () => {
  it('四区分开：库存、作业、进出、异常', () => {
    render(wrap(<DashboardPage />));

    expect(screen.getByRole('navigation', { name: '看板分区' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '库存' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '作业' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '进出' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '异常' })).toBeInTheDocument();
    expect(screen.getByText('库存最多的 SKU')).toBeInTheDocument();
    expect(screen.getByText('大货')).toBeInTheDocument();
    expect(screen.getByText('低库存（1）')).toBeInTheDocument();
    expect(screen.getAllByText('缺货件').length).toBeGreaterThan(0);
    expect(screen.getByText('已过期 3 天')).toBeInTheDocument();
    expect(screen.getByText('上架 IN-1')).toBeInTheDocument();
    expect(screen.getByText('质检隔离')).toBeInTheDocument();
    expect(screen.getAllByText('A-01').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: '出入库流量趋势图' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '在途入库 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拣货中 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '调拨未完成 1' })).toBeInTheDocument();
    expect(screen.getByText('其中在途 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '待拣波次 0' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已创建 2' })).toBeInTheDocument();
    expect(screen.getByText('已完成 4 · 已取消 0')).toBeInTheDocument();
  });

  it('积压格子和低库存行能跳到对应页面', async () => {
    const user = userEvent.setup();
    render(wrap(<DashboardPage />));

    await user.click(screen.getByRole('button', { name: '在途入库 3' }));
    expect(screen.getByTestId('where')).toHaveTextContent('inbound');

    await user.click(screen.getAllByText('缺货件')[0]!);
    expect(screen.getByTestId('where')).toHaveTextContent('inventory');
    await user.click(screen.getByRole('button', { name: '读过滤' }));
    expect(document.getElementById('filter-slot')).toHaveTextContent('GAP-1');
  });
});
