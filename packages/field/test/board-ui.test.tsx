import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { FieldSessionProvider } from '../src/session.js';

const health = { ok: true, nodeId: 'node-9', workspaceId: 'wh-main' };
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const orders = [
  { direction: 'in', state: 'created', count: 2 },
  { direction: 'in', state: 'announced', count: 1 },
  { direction: 'in', state: 'received', count: 4 },
  { direction: 'in', state: 'inspected', count: 1 },
  { direction: 'out', state: 'created', count: 7 },
];

function lowRow(skuCode: string) {
  return { skuCode, name: skuCode, unit: '个', total: 0, available: 0, reorderPoint: 1, shortage: 1 };
}

const preview = ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8'].map(lowRow);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function snapshot(putaway: boolean) {
  return {
    workspaceId: 'wh-main',
    modules: {
      'core.wms': { enabled: true },
      'module.qc': { enabled: false },
      'module.putaway': { enabled: putaway },
      'module.warehouse': { enabled: false },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function enterManage(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
  await user.click(screen.getByRole('button', { name: '连接' }));
  await user.click(await screen.findByRole('button', { name: '看仓库' }));
}

describe('管理看板', () => {
  it('全库数字来自看板接口，低库存下钻用 full=1，不拉单据也不提交', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        if (init?.method && init.method !== 'GET') throw new Error(`意外 ${init.method}`);
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot(true));
        if (url.includes('/api/dashboard/orders')) return json(orders);
        if (url.includes('/api/dashboard/workload')) return json({ pickingOpen: 2 });
        if (url.includes('/api/dashboard/stock?full=1')) {
          return json({ lowStockCount: 9, lowStock: [...preview, lowRow('S-9')] });
        }
        if (url.includes('/api/dashboard/stock')) return json({ lowStockCount: 9, lowStock: preview });
        if (url.includes('/api/dashboard/urgent')) {
          return json([
            { skuCode: 'A-1', name: '螺丝', batchNo: 'B-1', batchExpiryDate: '2026-11-01', daysLeft: -1, level: 'expired', quantity: 1, unit: '个' },
          ]);
        }
        if (url.includes('/api/dashboard/alerts')) {
          return json({
            expiredCount: 1,
            criticalCount: 0,
            warningCount: 2,
            holdCount: 3,
            negativeCount: 1,
            negativeBuckets: [{ skuCode: 'N-1', locationCode: 'A-01', batchNo: 'DEFAULT', quantity: -2 }],
          });
        }
        if (url.includes('/api/dashboard/flow-trend')) {
          return json([
            { day: yesterday, inbound: 99, outbound: 88 },
            { day: today, inbound: 3, outbound: 1 },
          ]);
        }
        if (url.endsWith('/api/order-conflicts')) {
          return json([{ eventId: 'e1', orderNo: 'IN-3', fromState: 'created', toState: 'received', actualState: 'canceled' }]);
        }
        if (url.includes('/api/dashboard/activity')) {
          return json([
            { eventId: 'a1', skuCode: 'A-1', name: '螺丝', locationCode: 'A-01', delta: 2, reason: 'putaway:IN-1' },
          ]);
        }
        if (url.includes('/api/pickings?state=created')) {
          return json([{ pickingNo: 'PK-1', state: 'created', note: '上午', lines: [{}, {}] }]);
        }
        if (url.includes('/api/inventory/expiry')) {
          return json({
            today,
            rows: [
              { skuCode: 'A-1', name: '螺丝', batchNo: 'B-1', batchExpiryDate: '2026-11-01', daysLeft: -1, level: 'expired', quantity: 1, unit: '个' },
              { skuCode: 'A-2', name: '垫片', batchNo: 'SAFE', batchExpiryDate: '2027-01-01', daysLeft: 40, level: 'safe', quantity: 9, unit: '个' },
            ],
          });
        }
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterManage(user);

    expect(within(await screen.findByRole('region', { name: '全库待收' })).getByText('3')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '全库待上架' })).getByText('5')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '全库待拣' })).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '全库低库存' })).getByText('9')).toBeInTheDocument();
    expect(screen.queryByText('S-9')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全库待收' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看待收' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看待上架' })).toBeInTheDocument();
    const todayRegion = screen.getByRole('region', { name: '全库今日收发' });
    expect(within(todayRegion).getByText('3')).toBeInTheDocument();
    expect(within(todayRegion).getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
    expect(screen.getByText(/按服务器日期/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看全部低库存' }));
    expect(await screen.findByRole('heading', { name: '全库低库存' })).toBeInTheDocument();
    expect(screen.getAllByText('S-9').length).toBeGreaterThan(0);
    expect(screen.getByText('按补货点，不是库存查找')).toBeInTheDocument();
    expect(urls.some((url) => url.includes('/api/dashboard/stock?full=1'))).toBe(true);
    expect(urls.some((url) => url.includes('lowOnly') || url.includes('/api/orders'))).toBe(false);

    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '最近库存变动' }));
    expect(await screen.findByRole('heading', { name: '最近库存变动' })).toBeInTheDocument();
    expect(screen.getByText(/putaway:IN-1/)).toBeInTheDocument();
    expect(screen.queryByText('今日完成张数')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '查看异常' }));
    expect(await screen.findByText('IN-3 created → received，实际 canceled')).toBeInTheDocument();
    expect(screen.getByText(/N-1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接受' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '查看待拣' }));
    expect(await screen.findByText('PK-1')).toBeInTheDocument();
    expect(screen.getByText(/2 行/)).toBeInTheDocument();
    expect(urls.some((url) => url.includes('/api/pickings?state=created'))).toBe(true);
    expect(urls.every((url) => !url.includes('/invoke'))).toBe(true);
  });

  it('上架模块关掉就没有待上架磁贴', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
        const url = String(input);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot(false));
        if (url.includes('/api/dashboard/orders')) return json(orders);
        if (url.includes('/api/dashboard/workload')) return json({ pickingOpen: 0 });
        if (url.includes('/api/dashboard/stock')) return json({ lowStockCount: 0, lowStock: [] });
        if (url.includes('/api/dashboard/urgent')) return json([]);
        if (url.includes('/api/dashboard/alerts')) {
          return json({ expiredCount: 0, criticalCount: 0, warningCount: 0, holdCount: 0, negativeCount: 0, negativeBuckets: [] });
        }
        if (url.includes('/api/dashboard/flow-trend')) return json([{ day: today, inbound: 0, outbound: 0 }]);
        if (url.endsWith('/api/order-conflicts')) return json([]);
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterManage(user);
    expect(await screen.findByRole('region', { name: '全库待收' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看待收' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '全库待上架' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看待上架' })).not.toBeInTheDocument();
  });

  it('库存查找按货品合计，库位行只标实物', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        if (init?.method && init.method !== 'GET') throw new Error(`意外 ${init.method}`);
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot(true));
        if (url.includes('/api/dashboard/orders')) return json([]);
        if (url.includes('/api/dashboard/workload')) return json({ pickingOpen: 0 });
        if (url.includes('/api/dashboard/stock')) return json({ lowStockCount: 0, lowStock: [] });
        if (url.includes('/api/dashboard/urgent')) return json([]);
        if (url.includes('/api/dashboard/alerts')) {
          return json({ expiredCount: 0, criticalCount: 0, warningCount: 0, holdCount: 0, negativeCount: 0, negativeBuckets: [] });
        }
        if (url.includes('/api/dashboard/flow-trend')) return json([{ day: today, inbound: 0, outbound: 0 }]);
        if (url.endsWith('/api/order-conflicts')) return json([]);
        if (url.includes('/api/skus?barcode=')) return json([]);
        if (url.includes('/api/skus?skuCode=')) {
          return json([{ skuCode: 'A-1', name: '螺丝', barcode: null, status: 'active', serialTracked: false }]);
        }
        if (url.includes('/api/inventory?')) {
          return json({
            total: 1,
            limit: 5,
            offset: 0,
            hasMore: false,
            hasReserved: false,
            rows: [{ skuCode: 'A-1', name: '螺丝', quantity: 4, held: 1, reserved: 2, available: 1, reorderPoint: 0, unit: '个' }],
          });
        }
        if (url.includes('/api/inventory/slices')) {
          return json({
            rows: [
              {
                skuCode: 'A-1',
                name: '螺丝',
                quantity: 4,
                locationCode: 'A-01',
                details: [{ locationCode: 'A-01', batchNo: 'DEFAULT', quantity: 4 }],
              },
            ],
          });
        }
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterManage(user);
    await screen.findByRole('region', { name: '全库待收' });
    const before = urls.length;
    await user.click(screen.getByRole('button', { name: '库存' }));
    expect(screen.getByRole('heading', { name: '库存' })).toBeInTheDocument();
    expect(urls.slice(before).some((url) => url.includes('/api/inventory'))).toBe(false);
    expect(screen.queryByRole('button', { name: '看本仓' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('货品或库位'), { target: { value: 'A-1' } });
    await user.click(screen.getByRole('button', { name: '查找' }));
    expect(await screen.findByText('可用')).toBeInTheDocument();
    expect(screen.getByText('占用')).toBeInTheDocument();
    const summary = urls.find((url) => url.includes('/api/inventory?'));
    expect(summary).toBeTruthy();
    expect(new URL(summary!).searchParams.get('skuCode')).toBe('A-1');
    expect(new URL(summary!).searchParams.get('limit')).toBe('5');
    expect(summary).not.toContain('lowOnly');

    await user.click(screen.getByRole('button', { name: '看库位' }));
    expect(await screen.findByText(/实物 4/)).toBeInTheDocument();
    expect(screen.queryByText('可用')).not.toBeInTheDocument();
    const slices = urls.find((url) => url.includes('/api/inventory/slices'));
    expect(slices).toBeTruthy();
    expect(new URL(slices!).searchParams.get('view')).toBe('location');
    expect(new URL(slices!).searchParams.get('q')).toBe('A-1');
    expect(slices).not.toContain('lowOnly');
  });

  it('待收和待上架下钻是全库只读列表，翻页后仍不提交', async () => {
    const urls: string[] = [];
    const line = {
      skuCode: 'A-1',
      name: '螺丝',
      quantity: 4,
      unit: '个',
      locationCode: 'R-01',
      warehouseCode: null as string | null,
      batchNo: 'B-1',
      batchExpiryDate: null,
      serialTracked: false,
    };
    const receiveOrder = {
      orderNo: 'IN-1',
      state: 'created',
      partnerName: '甲供应商',
      partnerCode: 'SUP-1',
      expectedAt: null,
      returnOfOrderNo: 'OUT-9',
      lines: [line],
    };
    const newer = {
      ...receiveOrder,
      orderNo: 'IN-8',
      returnOfOrderNo: null,
      lines: [{ ...line, warehouseCode: 'WH-1', locationCode: 'A-01' }],
    };
    const putawayOrder = {
      orderNo: 'IN-2',
      state: 'received',
      partnerName: '乙仓供',
      partnerCode: 'SUP-2',
      expectedAt: null,
      returnOfOrderNo: null,
      lines: [{ ...line, skuCode: 'A-2', locationCode: 'P-01', batchNo: 'DEFAULT' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        if (init?.method && init.method !== 'GET') throw new Error(`意外 ${init.method}`);
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) {
          return json({
            ...snapshot(true),
            modules: {
              ...snapshot(true).modules,
              'module.warehouse': { enabled: true },
            },
            workflows: {
              inbound: {
                states: [
                  { id: 'created', label: '已创建' },
                  { id: 'received', label: '已收货' },
                ],
              },
            },
          });
        }
        if (url.includes('/api/orders?')) {
          const params = new URL(url).searchParams;
          if (params.get('state') === 'created,announced') {
            if (params.get('offset') === '0') {
              return json({ total: 2, limit: 50, offset: 0, hasMore: true, rows: [receiveOrder] });
            }
            return json({ total: 2, limit: 50, offset: 1, hasMore: false, rows: [newer] });
          }
          if (params.get('state') === 'received,inspected') {
            return json({ total: 1, limit: 50, offset: 0, hasMore: false, rows: [putawayOrder] });
          }
          throw new Error(`意外单据查询 ${url}`);
        }
        if (url.includes('/api/dashboard/orders')) return json(orders);
        if (url.includes('/api/dashboard/workload')) return json({ pickingOpen: 0 });
        if (url.includes('/api/dashboard/stock')) return json({ lowStockCount: 0, lowStock: [] });
        if (url.includes('/api/dashboard/urgent')) return json([]);
        if (url.includes('/api/dashboard/alerts')) {
          return json({ expiredCount: 0, criticalCount: 0, warningCount: 0, holdCount: 0, negativeCount: 0, negativeBuckets: [] });
        }
        if (url.includes('/api/dashboard/flow-trend')) return json([{ day: today, inbound: 0, outbound: 0 }]);
        if (url.endsWith('/api/order-conflicts')) return json([]);
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterManage(user);
    await screen.findByRole('region', { name: '全库待收' });
    expect(urls.some((url) => url.includes('/api/orders?'))).toBe(false);

    await user.click(screen.getByRole('button', { name: '查看待收' }));
    expect(await screen.findByRole('heading', { name: '全库待收' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'IN-1' })).toBeInTheDocument();
    expect(screen.getByText('甲供应商')).toBeInTheDocument();
    expect(screen.getByText('退货 · 原单 OUT-9')).toBeInTheDocument();
    expect(screen.getByText('未分仓')).toBeInTheDocument();
    expect(screen.getByText(/1 行 · 已创建/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始收货' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认收货' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '还有更新的单' }));
    expect(await screen.findByRole('button', { name: 'IN-8' })).toBeInTheDocument();
    expect(screen.getAllByText('未分仓')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'IN-1' }));
    expect(screen.getAllByText(/螺丝 4个 · R-01 · B-1/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '开始收货' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始上架' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByRole('button', { name: 'IN-1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '查看待上架' }));
    expect(await screen.findByRole('heading', { name: '全库待上架' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'IN-2' })).toBeInTheDocument();
    expect(screen.getByText('乙仓供')).toBeInTheDocument();
    expect(screen.getByText(/1 行 · 已收货/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始上架' })).not.toBeInTheDocument();
    expect(screen.queryByText('还有更新的单')).not.toBeInTheDocument();

    const lists = urls.filter((url) => url.includes('/api/orders?'));
    expect(lists).toHaveLength(3);
    const parsed = lists.map((url) => new URL(url).searchParams);
    expect(parsed.map((params) => params.get('state'))).toEqual(['created,announced', 'created,announced', 'received,inspected']);
    expect(parsed.map((params) => params.get('offset'))).toEqual(['0', '1', '0']);
    for (const params of parsed) {
      expect(params.get('direction')).toBe('in');
      expect(params.get('sort')).toBe('updatedAtAsc');
      expect(params.get('limit')).toBe('50');
      expect(params.has('warehouseCode')).toBe(false);
    }
    expect(urls.every((url) => !url.includes('/invoke') && !url.includes('/transition') && !url.includes('/revise') && !url.includes('/putaway'))).toBe(true);
  });
});
