import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import OrdersPage from '../src/pages/OrdersPage';
import { AppNavProvider } from '../src/app-nav';

/**
 * 出库改明细要看见当前这一桶还剩多少，并能把数量改成这一桶的实物。
 * 超过实物时保存报错，不提交。
 */

const reviseMock = vi.fn();

const snapshotFixture = {
  workspaceId: 'ws-test',
  version: 1,
  schema: { entities: {} },
  workflows: {
    inbound: { states: [{ id: 'created', label: '已创建' }], transitions: [] },
    outbound: { states: [{ id: 'created', label: '已创建' }], transitions: [] },
  },
  modules: {},
  roles: {},
};

const order = {
  id: 'o-1',
  orderNo: 'OUT-1',
  direction: 'out' as const,
  state: 'created',
  partnerCode: null,
  partnerName: null,
  note: null,
  createdAt: '2026-11-07T08:00:00.000Z',
  updatedAt: '2026-11-07T08:00:00.000Z',
  lines: [
    {
      skuCode: 'A-1',
      name: '螺丝',
      quantity: 1,
      unit: '个',
      locationCode: 'A-01',
      batchNo: 'B-9',
    },
  ],
};

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshotFixture }),
  useOrders: () => ({ isLoading: false, data: [order] }),
  useOrderConflicts: () => ({ isLoading: false, data: [] }),
  useAcceptConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNextNumber: () => ({ isLoading: false, data: undefined }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviseOrder: () => ({ mutateAsync: reviseMock, isPending: false }),
  usePartners: () => ({ isLoading: false, data: [] }),
  useSkus: () => ({
    isLoading: false,
    data: [
      {
        id: 's-1',
        skuCode: 'A-1',
        barcode: null,
        reorderPoint: 0,
        unit: '个',
        name: '螺丝',
        status: 'active',
        extData: {},
        createdAt: '2026-11-07T08:00:00.000Z',
        updatedAt: '2026-11-07T08:00:00.000Z',
      },
    ],
  }),
  useLocations: () => ({
    isLoading: false,
    data: [
      {
        id: 'l-1',
        locationCode: 'A-01',
        name: '一号位',
        createdAt: '2026-11-07T08:00:00.000Z',
        updatedAt: '2026-11-07T08:00:00.000Z',
      },
    ],
  }),
  useInventoryBuckets: () => ({
    isLoading: false,
    data: [
      {
        skuCode: 'A-1',
        name: '螺丝',
        unit: '个',
        locationCode: 'A-01',
        batchNo: 'B-9',
        batchExpiryDate: '2027-03-01',
        quantity: 12,
      },
      {
        skuCode: 'A-1',
        name: '螺丝',
        unit: '个',
        locationCode: 'DEFAULT',
        batchNo: 'DEFAULT',
        batchExpiryDate: null,
        quantity: 18,
      },
    ],
  }),
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>
        <AppNavProvider>{ui}</AppNavProvider>
      </AntApp>
    </ConfigProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  reviseMock.mockReset();
  reviseMock.mockResolvedValue({ orderNo: 'OUT-1', state: 'created' });
});

afterEach(() => {
  cleanup();
});

async function editOutbound() {
  const user = userEvent.setup();
  render(wrap(<OrdersPage direction="out" />));
  await user.click(screen.getByRole('button', { name: '详情' }));
  const detail = await screen.findByRole('dialog', { name: /详情/ });
  expect(within(detail).getByText('12 个')).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: '编辑' }));
  return { user, detail: screen.getByRole('dialog', { name: /详情/ }) };
}

describe('出库改明细', () => {
  it('编辑时能看见这一桶的实物，并能把数量改成还剩的数量', async () => {
    const { user, detail } = await editOutbound();
    expect(within(detail).getByText(/A-01 · 一号位 · B-9 · 这一桶还有 12 个/)).toBeInTheDocument();
    expect(within(detail).getByText('18 个')).toBeInTheDocument();

    await user.click(within(detail).getByRole('button', { name: '按这一桶改数量' }));
    await user.click(within(detail).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(reviseMock).toHaveBeenCalledTimes(1));
    expect(reviseMock).toHaveBeenCalledWith({
      orderNo: 'OUT-1',
      body: {
        note: null,
        partnerCode: null,
        lines: [{ skuCode: 'A-1', quantity: 12, locationCode: 'A-01', batchNo: 'B-9' }],
      },
    });
  });

  it('换到另一桶后按那一桶的实物改数量', async () => {
    const { user, detail } = await editOutbound();
    const defaultRow = within(detail).getByText('默认库位').closest('tr');
    expect(defaultRow).not.toBeNull();
    await user.click(within(defaultRow as HTMLElement).getByRole('button', { name: '用这桶' }));
    expect(within(detail).getByText(/默认库位 · 默认批次 · 这一桶还有 18 个/)).toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: '按这一桶改数量' }));
    await user.click(within(detail).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(reviseMock).toHaveBeenCalledTimes(1));
    expect(reviseMock).toHaveBeenCalledWith({
      orderNo: 'OUT-1',
      body: {
        note: null,
        partnerCode: null,
        lines: [{ skuCode: 'A-1', quantity: 18 }],
      },
    });
  });

  it('数量超过这一桶时保存报错，不提交', async () => {
    const { user, detail } = await editOutbound();
    fireEvent.change(within(detail).getByRole('spinbutton'), { target: { value: '13' } });
    expect(within(detail).getAllByText('不够这一行').length).toBeGreaterThan(0);
    await user.click(within(detail).getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/这一桶只有 12，不够出 13/)).toBeInTheDocument();
    expect(reviseMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /详情/ })).toBeInTheDocument();
  });
});
