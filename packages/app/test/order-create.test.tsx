import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import OrdersPage from '../src/pages/OrdersPage';
import { AppNavProvider } from '../src/app-nav';

/**
 * 新建出入库单是整页，不是弹窗。扫码写入明细。出库规则只提示，不在这张单上选。
 */

const createMock = vi.fn();
const numbering = vi.hoisted(() => ({
  data: undefined as { place: string; value: string; pattern: string } | undefined,
}));

const snapshotFixture = {
  workspaceId: 'ws-test',
  version: 1,
  schema: { entities: {} },
  workflows: {
    inbound: { states: [{ id: 'created', label: '已创建' }], transitions: [] },
    outbound: { states: [{ id: 'created', label: '已创建' }], transitions: [] },
  },
  modules: {
    'module.asn': { enabled: true, version: '0.1.0', settings: {} },
    'module.reservation': { enabled: true, version: '0.1.0', settings: {} },
    'core.wms': {
      enabled: true,
      version: '0.1.0',
      settings: { defaultAllocation: 'strict', blockExpiredOutbound: true },
    },
  },
  roles: {},
};

const skusFixture = [
  {
    id: 's-1',
    skuCode: 'A-1',
    barcode: '6901234567892',
    reorderPoint: 0,
    unit: '个',
    name: '螺丝',
    status: 'active',
    extData: {},
    createdAt: '2026-11-07T08:00:00.000Z',
    updatedAt: '2026-11-07T08:00:00.000Z',
  },
];

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshotFixture }),
  useOrders: () => ({ isLoading: false, data: [] }),
  useOrderConflicts: () => ({ isLoading: false, data: [] }),
  useAcceptConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useCreateOrder: () => ({ mutateAsync: createMock, isPending: false }),
  useNextNumber: () => ({ isLoading: false, data: numbering.data }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartners: () => ({
    isLoading: false,
    data: [
      {
        id: 'p-1',
        partnerCode: 'S-1',
        kind: 'supplier',
        name: '华东供应商',
        contact: '周工',
        phone: '13800000000',
        address: '上海',
        note: null,
        extData: {},
        createdAt: '2026-11-07T08:00:00.000Z',
        updatedAt: '2026-11-07T08:00:00.000Z',
      },
    ],
  }),
  useSkus: () => ({ isLoading: false, data: skusFixture }),
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
  useInventory: () => ({
    isLoading: false,
    data: [{ skuId: 's-1', skuCode: 'A-1', name: '螺丝', quantity: 30, held: 5, available: 25, reorderPoint: 0, unit: '个' }],
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
  numbering.data = undefined;
  createMock.mockReset();
  createMock.mockResolvedValue({ orderId: 'o-new', orderNo: 'IN-1', state: 'created' });
});

afterEach(() => {
  cleanup();
});

describe('新建出入库单', () => {
  it('整页开单，能写预报和预计到货日，空明细不能保存', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    await user.click(screen.getByRole('button', { name: /新建单据/ }));

    expect(screen.getByRole('heading', { name: '新建入库单' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '入库单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /到货预报/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '批次' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '效期' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /到货预报/ }));
    expect(screen.getByLabelText('预计到货日')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存单据' }));
    expect((await screen.findAllByText('至少留一行商品')).length).toBeGreaterThan(0);
    expect(createMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(screen.getByRole('heading', { name: '入库单' })).toBeInTheDocument();
  });

  it('出库选商品就能看到每一桶，保存时不带怎么扣', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="out" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));

    expect(screen.getByRole('heading', { name: '新建出库单' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /先进先出/ })).not.toBeInTheDocument();
    expect(screen.queryByText('指定过的批次')).not.toBeInTheDocument();
    expect(screen.queryByText('指定过的库位')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), '6901234567892{Enter}');
    expect(await screen.findByText('螺丝')).toBeInTheDocument();
    expect(screen.getAllByText(/可用 25 个/).length).toBeGreaterThan(0);
    expect(screen.getByText('A-01')).toBeInTheDocument();
    expect(screen.getByText('B-9')).toBeInTheDocument();
    expect(screen.getByText('2027-03-01')).toBeInTheDocument();

    const bucketRow = screen.getByText('A-01').closest('tr');
    expect(bucketRow).not.toBeNull();
    await user.click(within(bucketRow as HTMLElement).getByRole('button', { name: '用这桶' }));
    await user.click(screen.getByRole('button', { name: '保存单据' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'A-01', batchNo: 'B-9' }],
    });
  });

  it('所选桶不够这一行时保存报错，不提交', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="out" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), '6901234567892{Enter}');
    const bucketRow = (await screen.findByText('A-01')).closest('tr');
    expect(bucketRow).not.toBeNull();
    await user.click(within(bucketRow as HTMLElement).getByRole('button', { name: '用这桶' }));
    const qty = screen.getByRole('spinbutton');
    fireEvent.change(qty, { target: { value: '13' } });
    await waitFor(() => expect(Number((qty as HTMLInputElement).value)).toBe(13));
    await user.click(screen.getByRole('button', { name: '保存单据' }));

    expect(await screen.findByText(/这一桶只有 12，不够出 13/)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '新建出库单' })).toBeInTheDocument();
  });

  it('单号预先填好，改过再保存就用改过的', async () => {
    numbering.data = { place: 'order.out', value: 'OUT-20261110-0001', pattern: 'OUT-{yyyyMMdd}-{seq:4}' };
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="out" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));

    const field = await screen.findByRole('textbox', { name: '单号' });
    expect(field).toHaveValue('OUT-20261110-0001');
    await user.clear(field);
    await user.type(field, 'OUT-9');
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), '6901234567892{Enter}');
    const bucketRow = (await screen.findByText('A-01')).closest('tr');
    expect(bucketRow).not.toBeNull();
    await user.click(within(bucketRow as HTMLElement).getByRole('button', { name: '用这桶' }));
    await user.click(screen.getByRole('button', { name: '保存单据' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      direction: 'out',
      orderNo: 'OUT-9',
      lines: [{ skuCode: 'A-1', quantity: 1, locationCode: 'A-01', batchNo: 'B-9' }],
    });
  });
});
