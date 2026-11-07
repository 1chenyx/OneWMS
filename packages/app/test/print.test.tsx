import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { Mock } from 'vitest';
import OrdersPage from '../src/pages/OrdersPage';
import PickingsPage from '../src/pages/PickingsPage';
import { AppNavProvider } from '../src/app-nav';

/**
 * 单据打印（A1）测试：mock 数据层 hooks + 桩掉 window.print。
 * 断言三件事：点按钮 → 打印区挂载（内容齐全：单头/明细/效期/签字栏）→
 * 拉起系统打印对话框（window.print 被调）。
 * 拣货单另断言行按建议库位排序（纸质作业按库位走，少跑冤枉路）。
 */

/** snapshot fixture：workflows 只给状态标签，transitions 留空（流转列渲染 —，与打印无关） */
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
} as never;

const ordersFixture = [
  {
    id: 'o-1',
    orderNo: 'IN-20261107-1',
    direction: 'in' as const,
    state: 'created',
    partnerCode: 'P-1',
    partnerName: '华东供应商',
    note: '周度补货',
    createdAt: '2026-11-07T08:00:00.000Z',
    updatedAt: '2026-11-07T08:00:00.000Z',
    lines: [
      {
        skuCode: 'A-1',
        name: '螺丝',
        quantity: 10,
        unit: '箱',
        batchNo: 'B-1',
        batchExpiryDate: '2027-01-01',
        locationCode: 'LOC-01',
      },
    ],
  },
  {
    id: 'o-2',
    orderNo: 'OUT-20261107-1',
    direction: 'out' as const,
    state: 'created',
    partnerCode: null,
    partnerName: null,
    note: null,
    createdAt: '2026-11-07T09:00:00.000Z',
    updatedAt: '2026-11-07T09:00:00.000Z',
    lines: [{ skuCode: 'B-2', name: '螺母', quantity: 2.5, unit: 'kg', batchNo: 'DEFAULT' }],
  },
];

/** 行顺序故意乱序（B-02 在前）：打印时应按建议库位重排为 A-01 在前 */
const pickingsFixture = [
  {
    id: 'pk-1',
    pickingNo: 'PK-20261107-1',
    state: 'created',
    note: null,
    createdAt: '2026-11-07T08:30:00.000Z',
    updatedAt: '2026-11-07T08:30:00.000Z',
    lines: [
      {
        id: 'pl-1',
        orderId: 'o-2',
        orderNo: 'OUT-20261107-1',
        skuId: 's-2',
        skuCode: 'B-2',
        skuName: '螺母',
        unit: 'kg',
        qtyToPick: 2.5,
        suggestedLocationCode: 'B-02',
        suggestedBatchNo: 'DEFAULT',
        pickedQty: 0,
        pickedLocationCode: null,
        pickedBatchNo: null,
      },
      {
        id: 'pl-2',
        orderId: 'o-2',
        orderNo: 'OUT-20261107-1',
        skuId: 's-1',
        skuCode: 'A-1',
        skuName: '螺丝',
        unit: null,
        qtyToPick: 3,
        suggestedLocationCode: 'A-01',
        suggestedBatchNo: 'B-1',
        pickedQty: 1,
        pickedLocationCode: null,
        pickedBatchNo: null,
      },
    ],
  },
];

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: snapshotFixture }),
  useOrders: () => ({ isLoading: false, data: ordersFixture }),
  useOrderConflicts: () => ({ isLoading: false, data: [] }),
  useAcceptConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissConflict: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionOrder: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartners: () => ({ isLoading: false, data: [] }),
  useSkus: () => ({ isLoading: false, data: [] }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLocations: () => ({ isLoading: false, data: [] }),
  usePickings: () => ({ isLoading: false, data: pickingsFixture }),
  useCreatePicking: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePickPickingLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useClosePicking: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelPicking: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

let printSpy: Mock;

beforeEach(() => {
  printSpy = vi.fn();
  vi.stubGlobal('print', printSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.body.innerHTML = '';
});

describe('单据打印（A1）', () => {
  it('OrdersPage：入库单打印——单头/明细（效期列）/数量带单位/签收栏齐全，拉起 window.print', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage />));

    await user.click(screen.getAllByRole('button', { name: '打印单据' })[0]); // 第一行 = 入库单

    const area = document.getElementById('order-print-area');
    expect(area).not.toBeNull();
    expect(screen.getByText('入库单 IN-20261107-1')).toBeInTheDocument();
    expect(screen.getByText('华东供应商')).toBeInTheDocument(); // 往来单位
    expect(screen.getByText('周度补货')).toBeInTheDocument(); // 备注
    expect(screen.getByText('2027-01-01')).toBeInTheDocument(); // 入库单效期列
    expect(screen.getByText('10 箱')).toBeInTheDocument(); // 数量带单位（A3 联动）
    expect(screen.getByText(/签收人签字/)).toBeInTheDocument();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
  });

  it('OrdersPage：出库单打印——无效期列，数量跟随单位', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage />));

    await user.click(screen.getAllByRole('button', { name: '打印单据' })[1]); // 第二行 = 出库单

    expect(screen.getByText('出库单 OUT-20261107-1')).toBeInTheDocument();
    expect(screen.queryByText('效期')).not.toBeInTheDocument(); // 出库单不印效期
    expect(screen.getByText('2.5 kg')).toBeInTheDocument();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
  });

  it('PickingsPage：拣货单打印——行按建议库位排序，勾选框/应拣已拣（带单位）/签字栏齐全', async () => {
    const user = userEvent.setup();
    render(wrap(<PickingsPage />));

    await user.click(screen.getByRole('button', { name: /打印/ }));

    const area = document.getElementById('picking-print-area');
    expect(area).not.toBeNull();
    expect(screen.getByText('拣货单 PK-20261107-1')).toBeInTheDocument();
    expect(screen.getByText(/关联出库单：OUT-20261107-1/)).toBeInTheDocument();
    // 明细行按建议库位升序：A-01（fixture 里排第二）应成为第一行
    const rows = area!.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('A-1');
    expect(rows[0].textContent).toContain('□'); // 勾选框
    expect(rows[1].textContent).toContain('B-2');
    expect(screen.getByText('3')).toBeInTheDocument(); // A-1 应拣（无单位 = 裸数字）
    expect(screen.getByText('2.5 kg')).toBeInTheDocument(); // B-2 应拣（带单位）
    expect(screen.getByText(/拣货人签字/)).toBeInTheDocument();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
  });
});
