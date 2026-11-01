import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { useEffect, useState } from 'react';
import type { ProfileSnapshot } from '@one/core';
import SkusPage from '../src/pages/SkusPage';
import OrdersPage from '../src/pages/OrdersPage';
import InventoryPage from '../src/pages/InventoryPage';
import ExpiryPage from '../src/pages/ExpiryPage';
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
const transitionMock = vi.fn();
const adjustMock = vi.fn();

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
    name: '螺丝',
    extData: { spec: '6204-2RS', category: '标准件' },
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

const inventoryFixture = [{ skuId: 's-1', skuCode: 'A-1', name: '螺丝', quantity: 30 }];

/** 效期看板 fixture：五层各一行（后端算好 level/daysLeft，前端只排版） */
const expiryFixture = {
  today: '2026-11-01',
  rows: [
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'B-OLD', batchExpiryDate: '2026-10-29', daysLeft: -3, level: 'expired', quantity: 8, locations: ['DEFAULT', 'LOC-01'] },
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'B-NOW', batchExpiryDate: '2026-11-01', daysLeft: 0, level: 'critical', quantity: 4, locations: ['DEFAULT'] },
    { skuId: 's-2', skuCode: 'B-2', name: '螺母', batchNo: 'B-MID', batchExpiryDate: '2026-11-20', daysLeft: 19, level: 'warning', quantity: 20, locations: ['LOC-01'] },
    { skuId: 's-2', skuCode: 'B-2', name: '螺母', batchNo: 'B-LATE', batchExpiryDate: '2027-05-01', daysLeft: 181, level: 'safe', quantity: 30, locations: ['LOC-01'] },
    { skuId: 's-1', skuCode: 'A-1', name: '螺丝', batchNo: 'DEFAULT', batchExpiryDate: null, daysLeft: null, level: 'unknown', quantity: 2, locations: ['DEFAULT'] },
  ],
};

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshotFixture }),
  useSkus: () => ({ isLoading: false, data: skusFixture }),
  useCreateSku: () => ({ mutateAsync: createSkuMock, isPending: false }),
  useOrders: () => ({ isLoading: false, data: ordersFixture }),
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: transitionMock, isPending: false, variables: undefined }),
  useInventory: () => ({ isLoading: false, data: inventoryFixture }),
  useAdjustInventory: () => ({ mutateAsync: adjustMock, isPending: false }),
  useExpiryBoard: () => ({ isLoading: false, data: expiryFixture }),
}));

// 禁用两字按钮自动插空格 + AntApp 提供 message 上下文 + AppNavProvider 供页面消费导航
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>
      <AppNavProvider>{ui}</AppNavProvider>
    </AntApp>
  </ConfigProvider>
);

/** 模拟 AI 后置动作跳转：navigate 后再挂载目标页（与 App.tsx 切页时序一致） */
function NavigateThenMount({
  page,
  filter,
  children,
}: {
  page: 'inventory' | 'orders';
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
});

describe('SkusPage：动态列（Profile 消费闭环）', () => {
  beforeEach(() => createSkuMock.mockReset());

  it('可见字段成列、隐藏字段消失、extData 值进列', () => {
    render(wrap(<SkusPage />));
    expect(screen.getByText('规格')).toBeInTheDocument(); // 动态列表头
    expect(screen.queryByText('分类')).not.toBeInTheDocument(); // visible:false → 列不渲染
    expect(screen.getByText('6204-2RS')).toBeInTheDocument(); // extData 值
    expect(screen.getByText('A-1')).toBeInTheDocument(); // 固定列
  });

  it('新建表单只出现可见扩展字段，提交收集 extData', async () => {
    createSkuMock.mockResolvedValueOnce({ skuId: 's-2', skuCode: 'A-2', name: '轴承' });
    const user = userEvent.setup();
    render(wrap(<SkusPage />));

    await user.click(screen.getByRole('button', { name: /新建 SKU/ }));
    await user.type(screen.getByLabelText('SKU 编码'), 'A-2');
    await user.type(screen.getByLabelText('名称'), '轴承');
    await user.type(screen.getByLabelText('规格'), '6204');
    expect(screen.queryByLabelText('分类')).not.toBeInTheDocument(); // 隐藏字段无输入项

    await user.click(screen.getByRole('button', { name: 'OK' })); // Modal 确认（默认 locale）
    await waitFor(() =>
      expect(createSkuMock).toHaveBeenCalledWith({
        skuCode: 'A-2',
        name: '轴承',
        extData: { spec: '6204' },
      }),
    );
  });
});

describe('OrdersPage：workflows 驱动流转', () => {
  beforeEach(() => transitionMock.mockReset());

  it('状态标签来自 workflows.states；候选按钮只含合法后继', () => {
    render(wrap(<OrdersPage />));
    expect(screen.getByText('已创建')).toBeInTheDocument(); // label 来自 Profile
    expect(screen.getByRole('button', { name: '已收货' })).toBeInTheDocument(); // created → received
    expect(screen.queryByRole('button', { name: '拣货中' })).not.toBeInTheDocument(); // 入库单无此路径
    expect(screen.getByText('A-1×100')).toBeInTheDocument(); // 明细摘要
  });

  it('点击流转 → popconfirm 确认 → 调用 transition', async () => {
    transitionMock.mockResolvedValueOnce({ orderNo: 'IN-20261030-1', from: 'created', to: 'received' });
    const user = userEvent.setup();
    render(wrap(<OrdersPage />));

    await user.click(screen.getByRole('button', { name: '已收货' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'IN-20261030-1', to: 'received' }),
    );
  });
});

describe('InventoryPage：清单与调整', () => {
  beforeEach(() => adjustMock.mockReset());

  it('清单渲染 + 调整提交（delta/原因）', async () => {
    adjustMock.mockResolvedValueOnce({ skuCode: 'A-1', quantity: 50 });
    const user = userEvent.setup();
    render(wrap(<InventoryPage />));

    expect(screen.getByText('A-1')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument(); // 余量

    await user.click(screen.getByRole('button', { name: '调整' }));
    await user.type(screen.getByLabelText('数量变化'), '20');
    await user.type(screen.getByLabelText(/原因/), '盘点');
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(adjustMock).toHaveBeenCalledWith({ skuCode: 'A-1', delta: 20, reason: '盘点' }),
    );
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
});

describe('OrdersPage：initialFilter 接参（M12 步骤4）', () => {
  it('AI 跳转携带的 orderNo 预填过滤框，清单按单号收敛', () => {
    render(
      wrap(
        <NavigateThenMount page="orders" filter={{ orderNo: 'IN-2026' }}>
          <OrdersPage />
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
    // 库位清单合并展示 + today 进标题
    expect(screen.getByText('DEFAULT、LOC-01')).toBeInTheDocument();
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
});
