import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import SkusPage from '../src/pages/SkusPage';
import OrdersPage from '../src/pages/OrdersPage';
import InventoryPage from '../src/pages/InventoryPage';

/**
 * 管理界面测试：mock 数据层 hooks。
 * 核心断言「Profile 配置驱动界面」：
 *  - SkusPage 动态列：可见字段成列、隐藏字段消失（列与输入项同源）；
 *  - OrdersPage 流转按钮：候选目标状态由 workflows 计算、状态标签由 states 提供；
 *  - InventoryPage：清单渲染 + 调整提交。
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

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshotFixture }),
  useSkus: () => ({ isLoading: false, data: skusFixture }),
  useCreateSku: () => ({ mutateAsync: createSkuMock, isPending: false }),
  useOrders: () => ({ isLoading: false, data: ordersFixture }),
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: transitionMock, isPending: false, variables: undefined }),
  useInventory: () => ({ isLoading: false, data: inventoryFixture }),
  useAdjustInventory: () => ({ mutateAsync: adjustMock, isPending: false }),
}));

// 禁用两字按钮自动插空格 + AntApp 提供 message 上下文
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

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
});
