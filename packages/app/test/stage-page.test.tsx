import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { AppNavProvider } from '../src/app-nav';
import { ApiError } from '../src/api/client';
import type { Order } from '../src/api/client';
import { LoadPage, PackPage, QcPage, ReviewPage } from '../src/pages/StagePage';

/**
 * 质检、复核、打包、装车共用一张待办清单。
 * 只列出真正流到这一步的单，确认走单据转移。
 */

const transitionMock = vi.fn();

let modules: Record<string, { enabled: boolean }> = {
  'module.qc': { enabled: true },
  'module.wave': { enabled: true },
  'module.picking': { enabled: true },
  'module.review': { enabled: true },
  'module.pack': { enabled: true },
  'module.load': { enabled: true },
};

function order(
  partial: Pick<Order, 'id' | 'orderNo' | 'direction' | 'state'> & { qty?: number },
): Order {
  const { qty, ...rest } = partial;
  return {
    partnerName: rest.direction === 'in' ? '华东供应商' : '华北客户',
    partnerCode: rest.direction === 'in' ? 'SUP-1' : 'CUS-1',
    note: null,
    createdAt: '2026-11-15T08:00:00.000Z',
    updatedAt: '2026-11-15T09:00:00.000Z',
    lines: [{ skuCode: 'A-1', name: '螺丝', quantity: qty ?? 4 }],
    ...rest,
  };
}

const orders: Order[] = [
  order({ id: 'in-new', orderNo: 'IN-NEW', direction: 'in', state: 'created' }),
  order({ id: 'in-rcv', orderNo: 'IN-RCV', direction: 'in', state: 'received', qty: 10 }),
  order({ id: 'in-qc', orderNo: 'IN-QC', direction: 'in', state: 'inspected' }),
  order({ id: 'out-new', orderNo: 'OUT-NEW', direction: 'out', state: 'created' }),
  order({ id: 'out-wave', orderNo: 'OUT-WAVE', direction: 'out', state: 'waved' }),
  order({ id: 'out-pick', orderNo: 'OUT-PICK', direction: 'out', state: 'picked' }),
  order({ id: 'out-rev', orderNo: 'OUT-REV', direction: 'out', state: 'reviewed' }),
  order({ id: 'out-pack', orderNo: 'OUT-PACK', direction: 'out', state: 'packed' }),
  order({ id: 'out-load', orderNo: 'OUT-LOAD', direction: 'out', state: 'loaded' }),
];

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, data: { modules } }),
  useOrders: () => ({ isLoading: false, data: orders }),
  useTransitionOrder: () => ({ mutateAsync: transitionMock, isPending: false, variables: undefined }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  transitionMock.mockReset();
  modules = {
    'module.qc': { enabled: true },
    'module.wave': { enabled: true },
    'module.picking': { enabled: true },
    'module.review': { enabled: true },
    'module.pack': { enabled: true },
    'module.load': { enabled: true },
  };
});

function renderPage(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>{ui}</AppNavProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('质检页', () => {
  it('只列出已收货的入库单，确认后走到已质检', async () => {
    transitionMock.mockResolvedValue({ orderNo: 'IN-RCV', to: 'inspected' });
    const user = userEvent.setup();
    renderPage(<QcPage />);
    expect(screen.getByText('IN-RCV')).toBeInTheDocument();
    expect(screen.queryByText('IN-NEW')).not.toBeInTheDocument();
    expect(screen.queryByText('IN-QC')).not.toBeInTheDocument();
    expect(screen.getByText('华东供应商')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('按单号过滤'), 'missing');
    expect(screen.queryByText('IN-RCV')).not.toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('按单号过滤'));

    await user.click(screen.getByRole('button', { name: '质检' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'IN-RCV', to: 'inspected' }));
    expect(await screen.findByText('IN-RCV 已质检')).toBeInTheDocument();
  });

  it('质检关掉后不再给确认按钮', () => {
    modules = { ...modules, 'module.qc': { enabled: false } };
    renderPage(<QcPage />);
    expect(screen.getByText(/质检已关闭/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '质检' })).not.toBeInTheDocument();
    expect(screen.getByText('IN-RCV')).toBeInTheDocument();
  });

  it('确认失败时把原因留在页面上', async () => {
    transitionMock.mockRejectedValue(new ApiError('WMS_QC', '这张单还不能质检', 400));
    const user = userEvent.setup();
    renderPage(<QcPage />);
    await user.click(screen.getByRole('button', { name: '质检' }));
    expect(await screen.findByText('这张单还不能质检')).toBeInTheDocument();
  });
});

describe('复核、打包、装车', () => {
  it('拣货开着时复核只等已拣货，确认后走到已复核', async () => {
    transitionMock.mockResolvedValue({ orderNo: 'OUT-PICK', to: 'reviewed' });
    const user = userEvent.setup();
    renderPage(<ReviewPage />);
    expect(screen.getByText('OUT-PICK')).toBeInTheDocument();
    expect(screen.queryByText('OUT-WAVE')).not.toBeInTheDocument();
    expect(screen.queryByText('OUT-REV')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复核' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'OUT-PICK', to: 'reviewed' }));
  });

  it('拣货关掉、波次开着时，复核等已组波的单', () => {
    modules = { ...modules, 'module.picking': { enabled: false } };
    renderPage(<ReviewPage />);
    expect(screen.getByText('OUT-WAVE')).toBeInTheDocument();
    expect(screen.queryByText('OUT-PICK')).not.toBeInTheDocument();
    expect(screen.queryByText('OUT-NEW')).not.toBeInTheDocument();
  });

  it('打包等已复核，装车等已打包', async () => {
    transitionMock.mockResolvedValue({});
    const user = userEvent.setup();
    const { unmount } = renderPage(<PackPage />);
    expect(screen.getByText('OUT-REV')).toBeInTheDocument();
    expect(screen.queryByText('OUT-PICK')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打包' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'OUT-REV', to: 'packed' }));
    unmount();

    renderPage(<LoadPage />);
    expect(screen.getByText('OUT-PACK')).toBeInTheDocument();
    expect(screen.queryByText('OUT-REV')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '装车' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith({ orderNo: 'OUT-PACK', to: 'loaded' }));
  });

  it('装车关掉后清单还在，但没有装车按钮', () => {
    modules = { ...modules, 'module.load': { enabled: false } };
    renderPage(<LoadPage />);
    expect(screen.getByText(/装车已关闭/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '装车' })).not.toBeInTheDocument();
    expect(screen.getByText('OUT-PACK')).toBeInTheDocument();
  });
});
