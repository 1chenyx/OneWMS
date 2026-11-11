import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import PutawayPage from '../src/pages/PutawayPage';
import { AppNavProvider } from '../src/app-nav';

/**
 * 上架页只列出已收货的入库单，上架动作在这一页。
 */

const orders = [
  {
    id: 'o-wait',
    orderNo: 'IN-WAIT',
    direction: 'in' as const,
    state: 'received',
    note: null,
    partnerName: null,
    partnerCode: null,
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
    lines: [{ skuCode: 'A-1', name: '螺丝', quantity: 4, locationCode: 'STAGE', batchNo: 'DEFAULT' }],
  },
  {
    id: 'o-new',
    orderNo: 'IN-NEW',
    direction: 'in' as const,
    state: 'created',
    note: null,
    partnerName: null,
    partnerCode: null,
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
    lines: [{ skuCode: 'A-1', name: '螺丝', quantity: 1 }],
  },
];

let putawayEnabled = true;

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({
    isLoading: false,
    data: {
      modules: { 'module.putaway': { enabled: putawayEnabled, version: '0.1.0' } },
    },
  }),
  useOrders: () => ({ isLoading: false, data: orders }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLocations: () => ({
    isLoading: false,
    data: [{ locationCode: 'A-01', name: '一号架', capacity: 20 }],
  }),
  useInventoryBuckets: () => ({ isLoading: false, data: [] }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  putawayEnabled = true;
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>
            <PutawayPage />
          </AppNavProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('上架页', () => {
  it('只列出已收货的入库单，点上架打开归位', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText('IN-WAIT')).toBeInTheDocument();
    expect(screen.queryByText('IN-NEW')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /上架$/ }));
    expect(await screen.findByRole('heading', { name: '上架 IN-WAIT' })).toBeInTheDocument();
    expect(screen.getByText('STAGE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认上架' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /再分一个库位$/ }));
    expect(screen.getAllByLabelText('上架数量').length).toBeGreaterThan(1);
  });

  it('上架关掉后仍提示已经收货的单可以在这里做完', () => {
    putawayEnabled = false;
    renderPage();
    expect(screen.getByText(/上架已关闭/)).toBeInTheDocument();
    expect(screen.getByText('IN-WAIT')).toBeInTheDocument();
  });
});
