import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { Mock } from 'vitest';
import OrdersPage from '../src/pages/OrdersPage';
import PickingsPage from '../src/pages/PickingsPage';
import { AppNavProvider } from '../src/app-nav';

/**
 * 单据打印（A1）测试：mock 数据层 hooks + 桩掉 window.print。
 * 行上「详情」只打开详情。右上角「打印预览」再打开预览，不拉起系统打印。预览里点「打印」才挂打印根。
 * 勾选当前页后，「打印所选」一次打出多页，不打开详情。
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
  {
    id: 'pk-2',
    pickingNo: 'PK-20261107-2',
    state: 'closed',
    note: null,
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:00.000Z',
    lines: [
      {
        id: 'pl-3',
        orderId: 'o-2',
        orderNo: 'OUT-20261107-9',
        skuId: 's-3',
        skuCode: 'C-3',
        skuName: '垫片',
        unit: '件',
        qtyToPick: 4,
        suggestedLocationCode: 'C-01',
        suggestedBatchNo: 'B-9',
        pickedQty: 4,
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
  useNextNumber: () => ({ isLoading: false, data: undefined }),
  usePartners: () => ({ isLoading: false, data: [] }),
  useSkus: () => ({ isLoading: false, data: [] }),
  usePutawayOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

function printCssText(): string {
  return [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
}

describe('单据打印（A1）', () => {
  it('OrdersPage：详情里点打印预览才看纸样，预览里点打印才挂打印根并拉起 window.print', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    expect(screen.queryByRole('button', { name: '预览单据' })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '详情' })[0]); // 第一行 = 入库单

    expect(document.getElementById('order-print-area')).toBeNull();
    const detail = screen.getByRole('dialog', { name: /详情/ });
    expect(within(detail).getByText(/华东供应商/)).toBeInTheDocument();
    expect(within(detail).getByText(/周度补货/)).toBeInTheDocument();
    expect(within(detail).getByText('2027-01-01')).toBeInTheDocument();
    expect(within(detail).getByText('10 箱')).toBeInTheDocument();
    expect(within(detail).queryByText(/签收人签字/)).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '打印预览' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(printSpy).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole('button', { name: '打印预览' }));
    const preview = screen.getByText('预览 入库单 IN-20261107-1').closest('[role="dialog"]') as HTMLElement;
    expect(within(preview).getByText('入库单 IN-20261107-1')).toBeInTheDocument();
    expect(within(preview).getByText(/签收人签字/)).toBeInTheDocument();
    expect(printSpy).not.toHaveBeenCalled();

    await user.click(within(preview).getByRole('button', { name: '打印' }));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const area = document.getElementById('order-print-area');
    expect(area).not.toBeNull();
    expect(area!.closest('.ant-card')).toBeNull();
    expect(area).toHaveStyle({ visibility: 'hidden' });
    expect(area!.textContent).toContain('入库单 IN-20261107-1');
    expect(area!.textContent).toContain('2027-01-01');
    expect(area!.textContent).toContain('10 箱');
    expect(area!.textContent).toContain('签收人签字');
    expect(printCssText()).toContain('#order-print-area .print-sheet { break-after: page; page-break-after: always; }');
  });

  it('OrdersPage：出库单详情无效期列，预览后再打印，数量跟随单位', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="out" />));

    await user.click(screen.getAllByRole('button', { name: '详情' })[0]);

    const detail = screen.getByRole('dialog', { name: /详情/ });
    expect(within(detail).queryByText('效期')).not.toBeInTheDocument();
    expect(within(detail).getByText('2.5 kg')).toBeInTheDocument();
    expect(printSpy).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole('button', { name: '打印预览' }));
    const preview = screen.getByText('预览 出库单 OUT-20261107-1').closest('[role="dialog"]') as HTMLElement;
    expect(within(preview).getByText('出库单 OUT-20261107-1')).toBeInTheDocument();
    expect(within(preview).queryByText('效期')).not.toBeInTheDocument();
    expect(within(preview).getByText('2.5 kg')).toBeInTheDocument();

    await user.click(within(preview).getByRole('button', { name: '打印' }));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(document.getElementById('order-print-area')!.textContent).toContain('2.5 kg');
  });

  it('OrdersPage：勾选当前页可以一次打印，不打开详情', async () => {
    const user = userEvent.setup();
    render(wrap(<OrdersPage direction="in" />));

    await user.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览所选' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打印所选（1）' }));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const printed = document.getElementById('order-print-area');
    expect(printed).not.toBeNull();
    expect(printed!.querySelectorAll('.print-sheet')).toHaveLength(1);
    expect(printed!.textContent).toContain('IN-20261107-1');
    expect(printed!.textContent).not.toContain('OUT-20261107-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('PickingsPage：拣货单预览在弹窗里，行按建议库位排序，点打印才拉起 window.print', async () => {
    const user = userEvent.setup();
    render(wrap(<PickingsPage />));

    await user.click(screen.getAllByRole('button', { name: '预览拣货单' })[0]);

    expect(document.getElementById('picking-print-area')).toBeNull();
    expect(printSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('拣货单 PK-20261107-1')).toBeInTheDocument();
    expect(within(dialog).getByText(/关联出库单：OUT-20261107-1/)).toBeInTheDocument();
    const rows = dialog.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('A-1');
    expect(rows[0].textContent).toContain('□');
    expect(rows[1].textContent).toContain('B-2');
    expect(within(dialog).getByText('3')).toBeInTheDocument();
    expect(within(dialog).getByText('2.5 kg')).toBeInTheDocument();
    expect(within(dialog).getByText(/拣货人签字/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '打印' }));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const area = document.getElementById('picking-print-area');
    expect(area).not.toBeNull();
    expect(area!.closest('.ant-card')).toBeNull();
    const printedRows = area!.querySelectorAll('tbody tr');
    expect(printedRows[0].textContent).toContain('A-1');
    expect(printedRows[1].textContent).toContain('B-2');
  });

  it('PickingsPage：勾选后一次打印多张拣货单', async () => {
    const user = userEvent.setup();
    render(wrap(<PickingsPage />));

    await user.click(screen.getAllByRole('checkbox')[0]);
    await user.click(screen.getByRole('button', { name: '打印所选（2）' }));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const area = document.getElementById('picking-print-area');
    expect(area!.querySelectorAll('.print-sheet')).toHaveLength(2);
    expect(area!.textContent).toContain('PK-20261107-1');
    expect(area!.textContent).toContain('PK-20261107-2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
