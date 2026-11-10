import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { useEffect, useState } from 'react';
import type { ProfileSnapshot } from '@one/core';
import SkusPage from '../src/pages/SkusPage';
import OrdersPage from '../src/pages/OrdersPage';
import InventoryPage from '../src/pages/InventoryPage';
import ExpiryPage from '../src/pages/ExpiryPage';
import ScanInput from '../src/components/ScanInput';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import type { InitialFilter } from '../src/app-nav';

/**
 * 管理界面测试：mock 数据层 hooks。
 * 核心断言「Profile 配置驱动界面」：
 *  - SkusPage 动态列：可见字段成列、隐藏字段消失（列与输入项同源）；
 *  - OrdersPage 流转按钮：候选目标状态由 workflows 计算、状态标签由 states 提供；
 *  - InventoryPage：清单渲染 + 调整提交；
 *  - initialFilter 接参（M12 步骤4）：AI 跳转携带的过滤在页面挂载时预填。
 */

const createSkuMock = vi.fn();
const updateSkuMock = vi.fn();
const archiveSkuMock = vi.fn();
const unarchiveSkuMock = vi.fn();
const transitionMock = vi.fn();
const acceptConflictMock = vi.fn();
const dismissConflictMock = vi.fn();
const adjustMock = vi.fn();
const createHoldMock = vi.fn();
const releaseHoldMock = vi.fn();

/** 短收短发开关。默认关，避免其它流转用例出现数量框。 */
let partialEnabled = false;

/** 拣货占用开关。默认关，库存表不出现预占列。 */
let reservationEnabled = false;

/** 多仓开关。默认关，库存页不出现「按仓库」。 */
let warehouseEnabled = false;

/** 单据冲突队列。默认空，避免其它用例被警告条干扰。 */
let conflictsFixture: {
  eventId: string;
  orderNo: string;
  fromState: string;
  toState: string;
  actualState: string;
  status: string;
}[] = [];

/** snapshot fixture：spec 可见 / category 隐藏（与默认种子的可见性差异即为测试点） */
const snapshotFixture = {
  workspaceId: 'ws-test',
  version: 1,
  schema: {
    entities: {
      sku: {
        extensions: [
          { key: 'spec', label: '规格', type: 'string', visible: true, providedBy: 'core' },
          { key: 'category', label: '分类', type: 'string', visible: false, providedBy: 'core' },
        ],
      },
    },
  },
  workflows: {
    inbound: {
      states: [
        { id: 'created', label: '已创建' },
        { id: 'received', label: '已收货' },
        { id: 'done', label: '已完成' },
      ],
      transitions: [
        { from: 'created', to: 'received' },
        { from: 'received', to: 'done' },
      ],
    },
    outbound: {
      states: [
        { id: 'created', label: '已创建' },
        { id: 'picking', label: '拣货中' },
        { id: 'done', label: '已完成' },
      ],
      transitions: [
        { from: 'created', to: 'picking' },
        { from: 'picking', to: 'done' },
      ],
    },
  },
  modules: {},
  roles: {},
} as unknown as ProfileSnapshot;

const skusFixture = [
  {
    id: 's-1',
    skuCode: 'A-1',
    barcode: '6901234567892',
    reorderPoint: 50,
    unit: '个',
    name: '螺丝',
    extData: { spec: '6204-2RS', category: '标准件' },
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
  },
  {
    id: 's-2',
    skuCode: 'B-2',
    barcode: null,
    reorderPoint: 0,
    unit: null,
    name: '螺母',
    extData: {},
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
  },
];

const ordersFixture = [
  {
    id: 'o-1',
    orderNo: 'IN-20261030-1',
    direction: 'in' as const,
    state: 'created',
    note: null,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    lines: [{ skuCode: 'A-1', name: '螺丝', quantity: 100 }],
  },
];

/** 库存 fixture（M19 冻结三件套 + M20 安全库存：A-1 低库存（可用 25 < 50），B-2 充足；A3 单位） */
const inventoryFixture = [
  { skuId: 's-1', skuCode: 'A-1', name: '螺丝', quantity: 30, held: 5, available: 25, reorderPoint: 50, unit: '个' },
  { skuId: 's-2', skuCode: 'B-2', name: '螺母', quantity: 8, held: 0, available: 8, reorderPoint: 5, unit: null },
];

/** 活动冻结 fixture（M19，与 inventoryFixture 的 held=5 对应） */
const holdsFixture = [
  { id: 'h-1', skuId: 's-1', skuCode: 'A-1', name: '螺丝', quantity: 5, reason: '质检隔离', createdAt: '2026-11-05T08:00:00.000Z' },
];

/** 效期看板 fixture：五层各一行（后端算好 level/daysLeft/buckets，前端只排版） */
const expiryFixture = {
  today: '2026-11-01',
  rows: [
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'B-OLD', batchExpiryDate: '2026-10-29', daysLeft: -3, level: 'expired', quantity: 8, buckets: [{ locationCode: 'DEFAULT', quantity: 5 }, { locationCode: 'LOC-01', quantity: 3 }] },
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'B-NOW', batchExpiryDate: '2026-11-01', daysLeft: 0, level: 'critical', quantity: 4, buckets: [{ locationCode: 'DEFAULT', quantity: 4 }] },
    { skuId: 's-2', skuCode: 'B-2', name: '螺母', batchNo: 'B-MID', batchExpiryDate: '2026-11-20', daysLeft: 19, level: 'warning', quantity: 20, buckets: [{ locationCode: 'LOC-01', quantity: 20 }] },
    { skuId: 's-2', skuCode: 'B-2', name: '螺母', batchNo: 'B-LATE', batchExpiryDate: '2027-05-01', daysLeft: 181, level: 'safe', quantity: 30, buckets: [{ locationCode: 'LOC-01', quantity: 30 }] },
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'DEFAULT', batchExpiryDate: null, daysLeft: null, level: 'unknown', quantity: 2, buckets: [{ locationCode: 'DEFAULT', quantity: 2 }] },
  ],
};

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({
    isLoading: false,
    data: {
      ...snapshotFixture,
      modules: {
        ...(partialEnabled ? { 'module.partial': { enabled: true, version: '0.1.0', settings: {} } } : {}),
        ...(reservationEnabled
          ? { 'module.reservation': { enabled: true, version: '0.1.0', settings: {} } }
          : {}),
        ...(warehouseEnabled ? { 'module.warehouse': { enabled: true, version: '0.1.0', settings: {} } } : {}),
      },
    },
  }),
  useSkus: () => ({ isLoading: false, data: skusFixture }),
  usePartners: () => ({ isLoading: false, data: [] }),
  useCreateSku: () => ({ mutateAsync: createSkuMock, isPending: false }),
  useNextNumber: () => ({ isLoading: false, data: undefined }),
  useUpdateSku: () => ({ mutateAsync: updateSkuMock, isPending: false }),
  useArchiveSku: () => ({ mutateAsync: archiveSkuMock, isPending: false }),
  useUnarchiveSku: () => ({ mutateAsync: unarchiveSkuMock, isPending: false }),
  useOrders: () => ({ isLoading: false, data: ordersFixture }),
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: transitionMock, isPending: false, variables: undefined }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOrderConflicts: () => ({ isLoading: false, data: conflictsFixture }),
  useAcceptConflict: () => ({ mutate: acceptConflictMock, mutateAsync: vi.fn(), isPending: false }),
  useDismissConflict: () => ({ mutate: dismissConflictMock, mutateAsync: vi.fn(), isPending: false }),
  useLocations: () => ({ isLoading: false, data: [] }),
  useInventory: () => ({
    isLoading: false,
    data: reservationEnabled
      ? inventoryFixture.map((row, index) => (index === 0 ? { ...row, reserved: 6 } : row))
      : inventoryFixture,
  }),
  useInventorySlices: (query: { view?: string } | null) => ({
    isLoading: false,
    isError: false,
    error: null,
    data: query
      ? query.view === 'warehouse'
        ? {
            total: 1,
            limit: 50,
            offset: 0,
            hasMore: false,
            view: 'warehouse',
            rows: [
              {
                key: 'wh@s-1',
                skuCode: 'A-1',
                name: '螺丝',
                unit: '个',
                quantity: 4,
                warehouseCode: 'WH-1',
                warehouseName: '一号仓',
                details: [
                  { locationCode: 'A-01', locationName: '一号架', batchNo: 'B1', batchExpiryDate: '2027-06-01', quantity: 4 },
                ],
              },
            ],
          }
        : {
            total: 1,
            limit: 50,
            offset: 0,
            hasMore: false,
            view: query.view,
            rows: [
              {
                key: 's-1@A-01',
                skuCode: 'A-1',
                name: '螺丝',
                unit: '个',
                quantity: 12,
                locationCode: 'A-01',
                locationName: '一号架',
                batchNo: 'B1',
                batchExpiryDate: '2027-01-01',
                details: [
                  { locationCode: 'A-01', locationName: '一号架', batchNo: 'B1', batchExpiryDate: '2027-01-01', quantity: 12 },
                ],
              },
            ],
          }
      : undefined,
  }),
  useWarehouses: () => ({
    isLoading: false,
    data: [{ id: 'w-1', warehouseCode: 'WH-1', name: '一号仓', locationCount: 1, createdAt: '', updatedAt: '' }],
  }),
  useAdjustInventory: () => ({ mutateAsync: adjustMock, isPending: false }),
  useHolds: (skuCode?: string) => ({
    isLoading: false,
    data: skuCode ? holdsFixture.filter((h) => h.skuCode === skuCode) : holdsFixture,
  }),
  useCreateHold: () => ({ mutateAsync: createHoldMock, isPending: false }),
  useReleaseHold: () => ({ mutateAsync: releaseHoldMock, isPending: false }),
  useExpiryBoard: () => ({ isLoading: false, data: expiryFixture }),
}));

// 禁用两字按钮自动插空格 + AntApp 提供 message 上下文 + AppNavProvider 供页面消费导航
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>
        <AppNavProvider>{ui}</AppNavProvider>
      </AntApp>
    </ConfigProvider>
  </QueryClientProvider>
);

/** 模拟 AI 后置动作跳转：navigate 后再挂载目标页（与 App.tsx 切页时序一致） */
function NavigateThenMount({
  page,
  filter,
  children,
}: {
  page: 'inventory' | 'inbound' | 'expiry';
  filter?: InitialFilter;
  children: React.ReactNode;
}) {
  const nav = useAppNav();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    nav.navigate(page, filter);
    setShown(true);
  }, [nav, page, filter]);
  return shown ? children : null;
}

// portal 残留清场（popconfirm / message / modal）
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  conflictsFixture = [];
  partialEnabled = false;
  reservationEnabled = false;
  warehouseEnabled = false;
});

describe('SkusPage：动态列（Profile 消费闭环）', () => {
  beforeEach(() => {
    createSkuMock.mockReset();
    updateSkuMock.mockReset();
  });

  it('可见字段成列、隐藏字段消失、extData 值进列；条码列：有码显码、无码显 -；单位列（A3）', () => {
    render(wrap(<SkusPage />));
    expect(screen.getByText('规格')).toBeInTheDocument(); // 动态列表头
    expect(screen.queryByText('分类')).not.toBeInTheDocument(); // visible:false → 列不渲染
    expect(screen.getByText('6204-2RS')).toBeInTheDocument(); // extData 值
    expect(screen.getByText('A-1')).toBeInTheDocument(); // 固定列
    expect(screen.getByText('条码')).toBeInTheDocument(); // 固定列（M18）
    expect(screen.getByText('安全库存')).toBeInTheDocument(); // 固定列（M20）
    expect(screen.getByText('单位')).toBeInTheDocument(); // 固定列（A3）
    const rowA = screen.getByText('A-1').closest('tr')!; // 有码行
    expect(within(rowA).getByText('6901234567892')).toBeInTheDocument();
    expect(within(rowA).getByText('50')).toBeInTheDocument(); // 安全库存（M20）
    expect(within(rowA).getByText('个')).toBeInTheDocument(); // 单位（A3）
    const rowB = screen.getByText('B-2').closest('tr')!; // 无码行（扩展列同为 -，条码/单位列也补 -）
    expect(within(rowB).queryByText('6901234567892')).not.toBeInTheDocument();
    expect(within(rowB).getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });

  it('新建表单只出现可见扩展字段，提交收集 extData 与条码（A3：含单位输入）', async () => {
    createSkuMock.mockResolvedValueOnce({ skuId: 's-2', skuCode: 'A-2', name: '轴承' });
    const user = userEvent.setup();
    render(wrap(<SkusPage />));

    await user.click(screen.getByRole('button', { name: /新建 SKU/ }));
    await user.type(screen.getByLabelText('SKU 编码'), 'A-2');
    await user.type(screen.getByLabelText('名称'), '轴承');
    await user.type(screen.getByLabelText(/单位/), 'kg');
    await user.type(screen.getByLabelText('规格'), '6204');
    await user.type(screen.getByLabelText(/条码/), ' 6901234567892 ');
    await user.type(screen.getByLabelText(/安全库存/), '60');
    expect(screen.queryByLabelText('分类')).not.toBeInTheDocument(); // 隐藏字段无输入项

    await user.click(screen.getByRole('button', { name: '创建' })); // 新建态 okText
    await waitFor(() =>
      expect(createSkuMock).toHaveBeenCalledWith({
        skuCode: 'A-2',
        name: '轴承',
        unit: 'kg', // A3：单位随档案提交（空白不提交 = 不设置）
        barcode: '6901234567892', // trim 后提交；空白条码不提交该字段
        reorderPoint: 60, // M20：>0 才提交（留空/0 不提交 = 不预警）
        extData: { spec: '6204' },
      }),
    );
  });
});

describe('ScanInput：扫码枪输入（M18）', () => {
  it('回车触发 onScan（trim 后），空值不触发，扫后清空可续扫', async () => {
    const onScan = vi.fn();
    const user = userEvent.setup();
    render(wrap(<ScanInput onScan={onScan} />));
    const input = screen.getByPlaceholderText(/扫码枪输入/);

    // 空回车不触发
    await user.type(input, '{enter}');
    expect(onScan).not.toHaveBeenCalled();

    // 扫码枪输入（两端空白 trim）+ 回车触发
    await user.type(input, ' 6901234567892 {enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('6901234567892');

    // 扫后清空 → 第二枪续扫
    expect(input).toHaveValue('');
    await user.type(input, '6901{enter}');
    expect(onScan).toHaveBeenCalledTimes(2);
    expect(onScan).toHaveBeenLastCalledWith('6901');
  });
});

describe('OrdersPage：workflows 驱动流转', () => {
  beforeEach(() => {
    transitionMock.mockReset();
    acceptConflictMock.mockReset();
    dismissConflictMock.mockReset();
  });

  it('状态标签来自 workflows.states；流转菜单只含合法后继', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    expect(screen.getByText('已创建')).toBeInTheDocument(); // label 来自 Profile
    await user.click(screen.getByRole('button', { name: /流转/ })); // 打开 Dropdown 菜单
    expect(await screen.findByRole('menuitem', { name: '已收货' })).toBeInTheDocument(); // created → received
    expect(screen.queryByRole('menuitem', { name: '拣货中' })).not.toBeInTheDocument(); // 入库单无此路径
  });

  it('明细在详情里：点详情看到 SKU、名称和数量', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));
    expect(screen.queryByText('螺丝')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '详情' }));
    const detail = await screen.findByRole('dialog', { name: /详情/ });
    expect(within(detail).getByText('A-1')).toBeInTheDocument();
    expect(within(detail).getByText('螺丝')).toBeInTheDocument();
    expect(within(detail).getByText('100')).toBeInTheDocument();
  });

  it('流转：菜单选目标态 → 确认弹窗 → 调用 transition', async () => {
    transitionMock.mockResolvedValueOnce({ orderNo: 'IN-20261030-1', from: 'created', to: 'received' });
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    await user.click(screen.getByRole('button', { name: /流转/ }));
    await user.click(await screen.findByRole('menuitem', { name: '已收货' }));
    await user.click(await screen.findByRole('button', { name: 'OK' })); // modal.confirm（默认 locale）
    await waitFor(() =>
      expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'IN-20261030-1', to: 'received' }),
    );
  });

  it('状态冲突：列出待裁决，接受与驳回走对应 mutation', async () => {
    conflictsFixture = [
      {
        eventId: 'evt-1',
        orderNo: 'IN-20261030-1',
        fromState: 'created',
        toState: 'canceled',
        actualState: 'received',
        status: 'open',
      },
    ];
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    expect(screen.getByText('有单据状态冲突待裁决')).toBeInTheDocument();
    expect(screen.getByText(/停在 received，另一条事件要改成 canceled/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '接受' }));
    expect(acceptConflictMock).toHaveBeenCalledWith('evt-1', expect.any(Object));

    await user.click(screen.getByRole('button', { name: '驳回' }));
    expect(dismissConflictMock).toHaveBeenCalledWith('evt-1', expect.any(Object));
  });

  it('短收：模块开启时确认框可改实收，少收才把 lines 交给转移', async () => {
    partialEnabled = true;
    transitionMock.mockResolvedValueOnce({ orderNo: 'IN-20261030-1', from: 'created', to: 'received' });
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    await user.click(screen.getByRole('button', { name: /流转/ }));
    await user.click(await screen.findByRole('menuitem', { name: '已收货' }));
    const qty = await screen.findByRole('spinbutton', { name: 'A-1 实收数量' });
    await user.clear(qty);
    await user.type(qty, '40');
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(transitionMock).toHaveBeenCalledWith({
        orderNo: 'IN-20261030-1',
        to: 'received',
        lines: [{ skuCode: 'A-1', locationCode: undefined, batchNo: undefined, quantity: 40 }],
      }),
    );
  });
});

describe('InventoryPage：清单与调整', () => {
  beforeEach(() => {
    adjustMock.mockReset();
    createHoldMock.mockReset();
    releaseHoldMock.mockReset();
  });

  it('清单渲染（含冻结三件套，M19）+ 调整提交（delta/原因）', async () => {
    adjustMock.mockResolvedValueOnce({ skuCode: 'A-1', quantity: 50 });
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    expect(screen.getByText('A-1')).toBeInTheDocument();
    expect(screen.getByText('30 个')).toBeInTheDocument(); // 余量（A3：带单位）
    expect(screen.getByText('冻结量')).toBeInTheDocument(); // M19 列
    expect(screen.queryByText('预占')).not.toBeInTheDocument();
    expect(screen.getByText('可用量')).toBeInTheDocument();
    expect(screen.getByText('25 个')).toBeInTheDocument(); // 可用 = 30 − 冻结 5（A3：带单位）
    expect(screen.getByText('安全库存')).toBeInTheDocument(); // M20 列（低库存 A-1 的可用量标红）

    // fixture 两行（A-1/B-2）各有调整/冻结按钮——按行作用域点击，避免全局撞重
    const rowA = screen.getByText('A-1').closest('tr')!;
    await user.click(within(rowA).getByRole('button', { name: '调整' }));
    await user.type(screen.getByLabelText('数量变化'), '20');
    await user.type(screen.getByLabelText(/原因/), '盘点');
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(adjustMock).toHaveBeenCalledWith({ skuCode: 'A-1', delta: 20, reason: '盘点' }),
    );
  });

  it('预占：模块开启时库存表显示占用数量', () => {
    reservationEnabled = true;
    render(wrap(<InventoryPage />));
    expect(screen.getByText('预占')).toBeInTheDocument();
    expect(screen.getByText('6 个')).toBeInTheDocument();
  });

  it('冻结弹窗（M19）：活动冻结可见、追加冻结提交、Popconfirm 释放', async () => {
    createHoldMock.mockResolvedValueOnce({ holdId: 'h-2', skuCode: 'A-1', quantity: 3, total: 30, held: 8, available: 22 });
    releaseHoldMock.mockResolvedValueOnce({ holdId: 'h-1', skuCode: 'A-1', quantity: 5, total: 30, held: 0, available: 30 });
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    // 按钮名含图标 aria-label（lock 冻结）→ 正则锚定结尾匹配
    await user.click(within(screen.getByText('A-1').closest('tr')!).getByRole('button', { name: /冻结$/ }));
    // 弹窗打开：摘要行 + 活动冻结行
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/余量 30，冻结 5，可用 25/)).toBeInTheDocument();
    // 原因与分隔符同节点 → 子串匹配；表单 label 文案也含该词 → 取全部
    expect(within(dialog).getAllByText(/质检隔离/).length).toBeGreaterThanOrEqual(1);

    // 追加冻结提交（okText 冻结——autoInsertSpace 已关，无空格）
    await user.type(within(dialog).getByLabelText('追加冻结数量'), '3');
    await user.type(within(dialog).getByLabelText(/原因（可选/), '客订');
    await user.click(within(dialog).getByRole('button', { name: '冻结' }));
    await waitFor(() =>
      expect(createHoldMock).toHaveBeenCalledWith({ skuCode: 'A-1', quantity: 3, reason: '客订' }),
    );

    // 释放活动冻结（Popconfirm 确认）
    await user.click(within(dialog).getByRole('button', { name: '释放' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(releaseHoldMock).toHaveBeenCalledWith('h-1'));
  });

  it('只看低库存（M20）：勾选过滤掉充足 SKU，只留可用量低于阈值的行', async () => {
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    // 两行都在
    expect(screen.getByText('A-1')).toBeInTheDocument(); // 低库存（可用 25 < 50）
    expect(screen.getByText('B-2')).toBeInTheDocument(); // 充足（可用 8 ≥ 5）

    await user.click(screen.getByRole('checkbox', { name: /只看低库存/ }));
    expect(screen.getByText('A-1')).toBeInTheDocument();
    expect(screen.queryByText('B-2')).not.toBeInTheDocument();
  });

  it('过滤框：关键字命中（编码/名称、不区分大小写），无命中显示空表', async () => {
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    const input = screen.getByPlaceholderText('按编码/名称过滤');
    await user.type(input, 'a-1'); // 小写编码命中 A-1
    expect(screen.getByText('A-1')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '不存在的货');
    expect(await screen.findByText('还没有库存流水（录入期初或调整后出现）')).toBeInTheDocument();
  });

  it('AI 跳转携带的 skuCode 预填过滤框（M12 步骤4，挂载时一次性消费）', () => {
    render(
      wrap(
        <NavigateThenMount page="inventory" filter={{ skuCode: 'A-1' }}>
          <InventoryPage />
        </NavigateThenMount>,
      ),
    );
    expect((screen.getByPlaceholderText('按编码/名称过滤') as HTMLInputElement).value).toBe('A-1');
    expect(screen.getByText('A-1')).toBeInTheDocument(); // 过滤后仍可见
  });

  it('按库位只显示实物余量，展开能看到批次；多仓关掉时没有按仓库', async () => {
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    expect(screen.getByText('可用量')).toBeInTheDocument();
    expect(screen.queryByText('按仓库')).not.toBeInTheDocument();

    await user.click(screen.getByText('按库位'));
    expect(screen.queryByText('可用量')).not.toBeInTheDocument();
    expect(screen.queryByText('只看低库存')).not.toBeInTheDocument();
    expect(screen.getByText('A-01')).toBeInTheDocument();
    expect(screen.getByText('12 个')).toBeInTheDocument();
    expect(within(screen.getByText('A-1').closest('tr')!).queryByRole('button', { name: '调整' })).not.toBeInTheDocument();

    await user.click(document.querySelector('.ant-table-row-expand-icon')!);
    expect(screen.getByText('B1')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01')).toBeInTheDocument();
  });

  it('按 SKU 时筛了库位，也改成实物余量', async () => {
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    await user.click(screen.getByRole('combobox', { name: '库位' }));
    await user.click(await screen.findByText('DEFAULT · 默认库位'));
    expect(screen.queryByText('可用量')).not.toBeInTheDocument();
    expect(screen.getByText('12 个')).toBeInTheDocument();
  });

  it('多仓打开时可以按仓库看合计', async () => {
    warehouseEnabled = true;
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    await user.click(screen.getByText('按仓库'));
    expect(screen.getByText('WH-1 · 一号仓')).toBeInTheDocument();
    expect(screen.getByText('4 个')).toBeInTheDocument();
    expect(screen.queryByText('可用量')).not.toBeInTheDocument();
  });
});

describe('OrdersPage：initialFilter 接参（M12 步骤4）', () => {
  it('AI 跳转携带的 orderNo 预填过滤框，清单按单号收敛', () => {
    render(
      wrap(
        <NavigateThenMount page="inbound" filter={{ orderNo: 'IN-2026' }}>
          <OrdersPage direction="in" />
        </NavigateThenMount>,
      ),
    );
    expect((screen.getByPlaceholderText('按单号过滤') as HTMLInputElement).value).toBe('IN-2026');
    expect(screen.getByText('IN-20261030-1')).toBeInTheDocument(); // 前缀包含命中
  });
});

describe('ExpiryPage：效期看板（M14 临期分层预警）', () => {
  it('五层统计卡计数 + 表格直出（天数文案 / 库位合并 / 截至日期）', () => {
    render(wrap(<ExpiryPage />));

    // 统计卡：五层标题齐备；计数 = 各层行数。标题与表格 Tag 同文案
    // （如「已过期」）→ 多命中中过滤出 statistic 容器再断言
    for (const title of ['已过期', '紧急', '预警', '安全', '未登记效期']) {
      const stat = screen
        .getAllByText(title)
        .map((el) => el.closest<HTMLElement>('.ant-statistic'))
        .find((s) => s !== null);
      expect(stat).toBeTruthy();
      expect(within(stat!).getByText('1')).toBeInTheDocument();
    }

    // 表格：剩余天数分形渲染（负数「已过期 N 天」/ 0「今天到期」/ null 弱化 —）
    expect(screen.getByText('已过期 3 天')).toBeInTheDocument();
    expect(screen.getByText('今天到期')).toBeInTheDocument();
    expect(screen.getByText('19 天')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    // 库位列收敛为计数（明细在行展开，M15）+ today 进标题
    expect(screen.getByText('2 库位')).toBeInTheDocument();
    expect(screen.getByText(/截至 2026-11-01/)).toBeInTheDocument();
    // 分层 Tag 与统计卡标题同文案 → 各出现 2 次（1 卡 + 1 Tag）
    expect(screen.getAllByText('已过期')).toHaveLength(2);
    expect(screen.getAllByText('未登记效期')).toHaveLength(2);
  });

  it('层过滤：选「已过期」→ 只剩该层行', async () => {
    const user = userEvent.setup();
    render(wrap(<ExpiryPage />));

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByTitle('已过期'));
    expect(screen.getByText('B-OLD')).toBeInTheDocument();
    expect(screen.queryByText('B-NOW')).not.toBeInTheDocument();
    expect(screen.queryByText('B-LATE')).not.toBeInTheDocument();
  });

  it('关键词过滤：批次号命中（不区分大小写），无命中显示空表', async () => {
    const user = userEvent.setup();
    render(wrap(<ExpiryPage />));

    await user.type(screen.getByPlaceholderText('按编码/名称/批次过滤'), 'b-old');
    expect(screen.getByText('B-OLD')).toBeInTheDocument();
    expect(screen.queryByText('B-NOW')).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('按编码/名称/批次过滤'));
    await user.type(screen.getByPlaceholderText('按编码/名称/批次过滤'), '幽灵批次');
    expect(await screen.findByText('还没有批次库存（入库声明批次后出现）')).toBeInTheDocument();
  });

  it('行展开：点开过期批 → 库位×余量明细（余量降序，M15）', async () => {
    const user = userEvent.setup();
    const { container } = render(wrap(<ExpiryPage />));

    // 首行（B-OLD，效期最早）的展开按钮
    const expand = container.querySelector('.ant-table-row-expand-icon');
    expect(expand).toBeTruthy();
    await user.click(expand!);

    // 展开表：LOC-01 明细 + 两库位余量（DEFAULT 5 在前、LOC-01 3 在后——降序）
    expect(await screen.findByText('LOC-01')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 展开表与主表列头并存（「库位」「余量」各 2 处）
    expect(screen.getAllByText('库位')).toHaveLength(2);
  });

  it('AI 跳转携带的 skuCode 预填关键词框（M15，挂载时一次性消费）', () => {
    render(
      wrap(
        <NavigateThenMount page="expiry" filter={{ skuCode: 'A-1' }}>
          <ExpiryPage />
        </NavigateThenMount>,
      ),
    );
    expect((screen.getByPlaceholderText('按编码/名称/批次过滤') as HTMLInputElement).value).toBe('A-1');
    expect(screen.getByText('B-OLD')).toBeInTheDocument(); // A-1 的批次仍可见
    expect(screen.queryByText('B-MID')).not.toBeInTheDocument(); // B-2 的批次被过滤
  });
});
