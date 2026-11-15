import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import type { Order, WaveDetail, WaveSummary } from '../src/api/client';
import WavePage from '../src/pages/WavePage';

/**
 * 波次页把已创建的出库单收成一波，按库位加总，再整波生成拣货单。
 */

const createMock = vi.fn();
const pickMock = vi.fn();
const cancelMock = vi.fn();

let waveOn = true;
let pickingOn = true;

function order(orderNo: string, state: string, locationCode = 'A-01'): Order {
  return {
    id: orderNo,
    orderNo,
    direction: 'out',
    state,
    partnerName: '华北客户',
    partnerCode: 'CUS-1',
    note: null,
    createdAt: '2026-11-15T08:00:00.000Z',
    updatedAt: '2026-11-15T09:00:00.000Z',
    lines: [{ skuCode: 'A-1', name: '螺丝', quantity: orderNo === 'OUT-2' ? 6 : 4, locationCode }],
  };
}

const orders: Order[] = [
  order('OUT-1', 'created'),
  order('OUT-2', 'created', 'A-01'),
  order('OUT-TAKEN', 'created'),
  order('OUT-SHIP', 'shipped'),
];

const waves: WaveSummary[] = [
  {
    id: 'w-old',
    waveNo: 'WV-OLD',
    state: 'open',
    note: null,
    pickingNo: null,
    orderNos: ['OUT-TAKEN'],
    createdAt: '2026-11-15T08:00:00.000Z',
    updatedAt: '2026-11-15T08:30:00.000Z',
  },
];

const detail: WaveDetail = {
  id: 'w-old',
  waveNo: 'WV-OLD',
  state: 'open',
  note: null,
  pickingNo: null,
  createdAt: '2026-11-15T08:00:00.000Z',
  updatedAt: '2026-11-15T08:30:00.000Z',
  orders: [{ orderId: 'OUT-TAKEN', orderNo: 'OUT-TAKEN', state: 'waved', partnerName: '华北客户' }],
  walk: [
    {
      locationCode: 'A-01',
      skuCode: 'A-1',
      skuName: '螺丝',
      unit: null,
      batchNo: 'DEFAULT',
      quantity: 4,
      orders: [{ orderNo: 'OUT-TAKEN', quantity: 4 }],
    },
  ],
};

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({
    isLoading: false,
    data: {
      modules: {
        'module.wave': { enabled: waveOn },
        'module.picking': { enabled: pickingOn },
      },
    },
  }),
  useOrders: () => ({ isLoading: false, data: orders }),
  useWaves: () => ({ isLoading: false, data: waves }),
  useWave: (waveNo: string | null) => ({
    isLoading: false,
    data: waveNo === 'WV-OLD' ? detail : undefined,
  }),
  useCreateWave: () => ({ mutateAsync: createMock, isPending: false }),
  usePickWave: () => ({ mutateAsync: pickMock, isPending: false }),
  useCancelWave: () => ({ mutateAsync: cancelMock, isPending: false }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  createMock.mockReset();
  pickMock.mockReset();
  cancelMock.mockReset();
  waveOn = true;
  pickingOn = true;
});

function PageMark() {
  const { page } = useAppNav();
  return <div data-testid="page">{page}</div>;
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>
            <PageMark />
            <WavePage />
          </AppNavProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('波次页', () => {
  it('待组波只留已创建且还没进波次的单，勾上后组成一波', async () => {
    createMock.mockResolvedValue({ waveNo: 'WV-NEW', orderNos: ['OUT-1', 'OUT-2'] });
    const user = userEvent.setup();
    renderPage();
    const waiting = screen.getByText('待组波').closest('.ant-card') as HTMLElement;
    expect(within(waiting).getByText('OUT-1')).toBeInTheDocument();
    expect(within(waiting).getByText('OUT-2')).toBeInTheDocument();
    expect(within(waiting).queryByText('OUT-TAKEN')).not.toBeInTheDocument();
    expect(within(waiting).queryByText('OUT-SHIP')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '组成波次' })).toBeDisabled();

    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[1]!);
    await user.click(boxes[2]!);
    await user.click(screen.getByRole('button', { name: '组成波次（2）' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({ orderNos: ['OUT-1', 'OUT-2'] }),
    );
    expect(await screen.findByText(/已组成波次 WV-NEW/)).toBeInTheDocument();
  });

  it('点开波次看到按库位的合计，确认后按这波拣货并去拣货单', async () => {
    pickMock.mockResolvedValue({ pickingNo: 'PK-1', waveNo: 'WV-OLD' });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('WV-OLD'));
    expect(await screen.findByText('A-1 螺丝')).toBeInTheDocument();
    expect(screen.getByText('未指定批次')).toBeInTheDocument();
    expect(screen.getByText('OUT-TAKEN 4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按这波拣货' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(pickMock).toHaveBeenCalledWith('WV-OLD'));
    expect(await screen.findByText(/已生成拣货单 PK-1/)).toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('pickings');
  });

  it('取消还没拣的波次', async () => {
    cancelMock.mockResolvedValue({ waveNo: 'WV-OLD', state: 'canceled' });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('WV-OLD'));
    await user.click(await screen.findByRole('button', { name: '取消波次' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('WV-OLD'));
    expect(await screen.findByText('已取消波次 WV-OLD')).toBeInTheDocument();
  });

  it('波次关掉后不能再组，已经组好的仍可拣', async () => {
    waveOn = false;
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText(/波次已关闭/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '组成波次' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeDisabled();
    }
    await user.click(screen.getByText('WV-OLD'));
    expect(await screen.findByRole('button', { name: '按这波拣货' })).toBeInTheDocument();
  });

  it('拣货关掉时，波次清单还在，但不生成拣货单', async () => {
    pickingOn = false;
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('WV-OLD'));
    expect(await screen.findByText(/拣货关着/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按这波拣货' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消波次' })).toBeInTheDocument();
  });
});
