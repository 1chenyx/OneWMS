import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import LocationsPage from '../src/pages/LocationsPage';
import type { Location, Warehouse } from '../src/api/client';

/**
 * 库位管理：多仓打开时，仓库是父、库位是子，不再上下两张表。
 * mock HTTP，走真实 hooks，点选父节点后子表跟着收窄。
 */

let warehouseOn = true;

const warehousesFixture: Warehouse[] = [
  {
    id: 'w1',
    warehouseCode: 'WH-1',
    name: '一号仓',
    locationCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'w2',
    warehouseCode: 'WH-2',
    name: '二号仓',
    locationCount: 1,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];

function location(
  id: string,
  locationCode: string,
  name: string,
  warehouseCode: string | null,
  warehouseName: string | null,
): Location {
  return {
    id,
    locationCode,
    name,
    warehouseId: warehouseCode ? `id-${warehouseCode}` : null,
    warehouseCode,
    warehouseName,
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
  };
}

const locationRows: Location[] = [
  location('l1', 'A-01', '一号架', 'WH-1', '一号仓'),
  location('l2', 'A-02', '一号高架', 'WH-1', '一号仓'),
  location('l3', 'B-01', '二号架', 'WH-2', '二号仓'),
  location('l4', 'Z-01', '散货', null, null),
];

function filterLocations(query?: { q?: string; warehouseCode?: string; unassigned?: boolean }): Location[] {
  let rows = locationRows;
  if (query?.unassigned) rows = rows.filter((row) => !row.warehouseCode);
  else if (query?.warehouseCode) rows = rows.filter((row) => row.warehouseCode === query.warehouseCode);
  if (query?.q) {
    const q = query.q;
    rows = rows.filter((row) => row.locationCode.includes(q) || row.name.includes(q));
  }
  return rows;
}

vi.mock('../src/api/client', () => ({
  api: {
    profileSnapshot: async () => ({
      modules: warehouseOn ? { 'module.warehouse': { enabled: true, version: '0.1.0', settings: {} } } : {},
    }),
    warehouses: async () => warehousesFixture,
    locations: async (query?: { q?: string; warehouseCode?: string; unassigned?: boolean; limit?: number; offset?: number }) => {
      const rows = filterLocations(query);
      if (query?.limit == null) return rows;
      return { total: rows.length, limit: query.limit, offset: query.offset ?? 0, hasMore: false, rows };
    },
    numbering: async (place?: string) => ({
      stored: true,
      patchOp: 'replace' as const,
      path: '/modules/core.wms/settings/numbering',
      numbering: {},
      places: [
        {
          place: place ?? 'location',
          label: place === 'warehouse' ? '仓库' : '库位',
          group: '档案',
          pattern: place === 'warehouse' ? 'WH-{seq:2}' : 'LOC-{seq:4}',
          configured: null,
          invalid: null,
          reset: 'never',
          resetLabel: '一直累加',
          next: place === 'warehouse' ? 'WH-01' : 'LOC-0001',
        },
      ],
    }),
    createLocation: vi.fn(),
    updateLocation: vi.fn(),
    createWarehouse: vi.fn(),
    updateWarehouse: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    code = 'ERR';
  },
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>{ui}</AntApp>
    </ConfigProvider>
  </QueryClientProvider>
);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  warehouseOn = true;
});

async function renderPage() {
  render(wrap(<LocationsPage />));
}

describe('库位管理父子结构', () => {
  it('多仓打开时左侧是仓库，右侧只显示选中仓库的库位', async () => {
    const user = userEvent.setup();
    await renderPage();

    const nav = await screen.findByRole('navigation', { name: '仓库' });
    const wh1 = within(nav).getByRole('button', { name: /一号仓/ });
    expect(wh1).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('button', { name: /二号仓/ })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /未分仓/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '仓库编码' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '库位编码' })).toBeInTheDocument();

    expect(await screen.findByText('A-01')).toBeInTheDocument();
    expect(screen.getByText('A-02')).toBeInTheDocument();
    expect(screen.queryByText('B-01')).not.toBeInTheDocument();
    expect(screen.queryByText('Z-01')).not.toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: /二号仓/ }));
    expect(await screen.findByText('B-01')).toBeInTheDocument();
    expect(screen.queryByText('A-01')).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /二号仓/ })).toHaveAttribute('aria-current', 'true');

    await user.click(within(nav).getByRole('button', { name: /未分仓/ }));
    expect(await screen.findByText('Z-01')).toBeInTheDocument();
    expect(screen.queryByText('B-01')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '改名' })).not.toBeInTheDocument();
  });

  it('在当前仓库里搜索，不会把别的仓库的库位搜出来', async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(await screen.findByText('A-01')).toBeInTheDocument();

    const search = screen.getByPlaceholderText('搜索编码或名称');
    await user.type(search, '高架{Enter}');
    await waitFor(() => expect(screen.queryByText('A-01')).not.toBeInTheDocument());
    expect(screen.getByText('A-02')).toBeInTheDocument();
    expect(screen.queryByText('B-01')).not.toBeInTheDocument();
  });

  it('新建库位默认挂在当前选中的仓库下面', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('A-01');
    await user.click(screen.getByRole('button', { name: /新建库位/ }));
    expect(await screen.findByText('一号仓（WH-1）')).toBeInTheDocument();
  });

  it('多仓关闭时仍是一张库位表，已划仓的库位也留在表里', async () => {
    warehouseOn = false;
    await renderPage();
    expect(await screen.findByText('A-01')).toBeInTheDocument();
    expect(screen.getByText('B-01')).toBeInTheDocument();
    expect(screen.getByText('Z-01')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '仓库' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建仓库/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '仓库' })).not.toBeInTheDocument();
  });
});
