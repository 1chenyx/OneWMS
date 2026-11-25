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
  {
    // 带包装换算：1 箱 = 24 瓶、1 包 = 6 瓶（开单可按包装录入，服务端折基本单位）
    id: 's-3',
    skuCode: 'C-3',
    barcode: null,
    reorderPoint: 0,
    unit: '瓶',
    packages: [
      { unit: '箱', ratio: 24 },
      { unit: '包', ratio: 6 },
    ],
    name: '可乐',
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
    data: [
      { skuId: 's-1', skuCode: 'A-1', name: '螺丝', quantity: 30, held: 5, available: 25, reorderPoint: 0, unit: '个' },
      { skuId: 's-3', skuCode: 'C-3', name: '可乐', quantity: 30, held: 0, available: 30, reorderPoint: 0, unit: '瓶' },
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
      {
        skuCode: 'C-3',
        name: '可乐',
        unit: '瓶',
        locationCode: 'DEFAULT',
        batchNo: 'DEFAULT',
        batchExpiryDate: null,
        quantity: 30,
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
  localStorage.clear(); // 录入单位记忆（owms:line-unit-memory）不能跨用例串
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
    const qty = screen.getByLabelText('数量');
    fireEvent.change(qty, { target: { value: '13' } });
    await waitFor(() => expect((qty as HTMLInputElement).value).toBe('13'));
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

  it('按包装录入：分段按钮切单位显换算预览（= 48 瓶），保存 payload 带 unit', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    expect(await screen.findByText('可乐')).toBeInTheDocument();

    // 默认基本单位：没有换算预览，分段按钮里基本单位选中
    expect(screen.queryByText(/= \d+ 瓶/)).not.toBeInTheDocument();

    // 切成箱（1 箱 = 24 瓶）：数量还是 1，预览显 = 24 瓶。
    await user.click(screen.getByText('箱(24)'));
    expect(await screen.findByText('= 24 瓶')).toBeInTheDocument();

    // 数量改成 2：预览跟着变
    const qty = screen.getByLabelText('数量');
    fireEvent.change(qty, { target: { value: '2' } });
    await waitFor(() => expect((qty as HTMLInputElement).value).toBe('2'));
    expect(await screen.findByText('= 48 瓶')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      direction: 'in',
      lines: [{ skuCode: 'C-3', quantity: 2, unit: '箱' }], // quantity 是箱数，换算在服务端
    });
  });

  it('数量框直接输「2箱」：单位跟着带出，预览与 payload 同切分段按钮', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    expect(await screen.findByText('可乐')).toBeInTheDocument();

    const qty = screen.getByLabelText('数量');
    await user.clear(qty); // 扫入时数量框已有「1」，type 是追加语义，先清
    await user.type(qty, '2箱');
    expect(await screen.findByText('= 48 瓶')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      direction: 'in',
      lines: [{ skuCode: 'C-3', quantity: 2, unit: '箱' }],
    });
  });

  it('记住上次单位：切过箱保存后，再扫同一货直接按箱；没有包装的货照旧按基本单位', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    expect(await screen.findByText('可乐')).toBeInTheDocument();
    await user.click(screen.getByText('箱(24)')); // 记住 in:C-3 = 箱
    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    // 保存成功自动回列表：再开一单，扫同一货直接带上次的单位
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    // 再扫：直接带上次的单位（1 箱 → = 24 瓶）
    expect(await screen.findByText('= 24 瓶')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock).toHaveBeenLastCalledWith({
      direction: 'in',
      lines: [{ skuCode: 'C-3', quantity: 1, unit: '箱' }],
    });

    // 没有包装的货（A-1）：记忆里没有它的条目，照旧按基本单位
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), '6901234567892{Enter}');
    expect(await screen.findByText('螺丝')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(3));
    expect(createMock).toHaveBeenLastCalledWith({
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
  });

  it('默认按基本单位录入：payload 不带 unit 字段', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    const qty = await screen.findByLabelText('数量');
    fireEvent.change(qty, { target: { value: '5' } });
    await waitFor(() => expect((qty as HTMLInputElement).value).toBe('5'));

    await user.click(screen.getByRole('button', { name: '保存单据' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      direction: 'in',
      lines: [{ skuCode: 'C-3', quantity: 5 }], // 不带 unit = 基本单位（与存量单据形态一致）
    });
  });

  it('出库按包装录入：预检按换算后的基本单位算，2 箱（48）> 30 拒且不提交', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="out" />));
    await user.click(screen.getByRole('button', { name: /新建单据/ }));
    await user.type(screen.getByPlaceholderText(/扫条码或编码/), 'C-3{Enter}');
    expect(await screen.findByText('可乐')).toBeInTheDocument();

    await user.click(screen.getByText('箱(24)'));
    const qty = screen.getByLabelText('数量');
    fireEvent.change(qty, { target: { value: '2' } });
    await waitFor(() => expect((qty as HTMLInputElement).value).toBe('2'));
    expect(await screen.findByText('= 48 瓶')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存单据' }));
    expect(await screen.findByText(/不够出 48/)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });
});
