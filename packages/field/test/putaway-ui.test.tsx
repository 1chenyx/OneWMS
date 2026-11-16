import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { FieldSessionProvider } from '../src/session.js';

const health = { ok: true, nodeId: 'node-9', workspaceId: 'wh-main' };

const order = {
  orderNo: 'IN-9',
  state: 'received',
  partnerName: '乙仓供',
  partnerCode: 'SUP-9',
  expectedAt: null,
  returnOfOrderNo: null,
  lines: [
    {
      skuCode: 'A-1',
      name: '螺丝',
      quantity: 2,
      unit: '个',
      locationCode: 'A-01',
      warehouseCode: null,
      batchNo: 'DEFAULT',
      batchExpiryDate: null,
      serialTracked: false,
    },
  ],
};

const snapshot = {
  workspaceId: 'wh-main',
  modules: {
    'core.wms': { enabled: true },
    'module.warehouse': { enabled: false },
    'module.qc': { enabled: false },
    'module.putaway': { enabled: true },
  },
  workflows: { inbound: { states: [{ id: 'received', label: '已收货' }, { id: 'putaway', label: '已上架' }] } },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function location(code: string) {
  return {
    locationCode: code,
    name: code,
    warehouseCode: null,
    warehouseName: null,
    zoneCode: null,
    zoneName: null,
    zoneKind: null,
    zoneKindLabel: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function enterPutaway(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
  await user.click(screen.getByRole('button', { name: '连接' }));
  await user.click(await screen.findByRole('button', { name: '现场作业' }));
  await user.click(screen.getByRole('button', { name: '待上架' }));
  const card = await screen.findByRole('button', { name: 'IN-9' });
  expect(card).toHaveTextContent(/乙仓供/);
  expect(card).toHaveTextContent(/1 行/);
  await user.click(card);
}

describe('待上架', () => {
  it('整行放入目标库位，不写数量，警告原文留在完成步', async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot);
        if (url.includes('/api/orders?')) {
          return json({ total: 1, limit: 50, offset: 0, hasMore: false, rows: [order] });
        }
        if (url.includes('/api/locations?code=A-01')) return json([location('A-01')]);
        if (url.includes('/api/locations?code=B-01')) return json([location('B-01')]);
        if (url.includes('/api/skus?barcode=')) return json([]);
        if (url.includes('/api/skus?skuCode=')) {
          return json([{ skuCode: 'A-1', name: '螺丝', barcode: null, status: 'active', serialTracked: false }]);
        }
        if (init?.method === 'POST' && url.endsWith('/api/orders/IN-9/putaway')) {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return json({ orderNo: 'IN-9', from: 'received', to: 'putaway', warning: '库位 A-02 快满了' });
        }
        throw new Error(`意外请求 ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterPutaway(user);
    expect(screen.getByText(/A-01/)).toBeInTheDocument();
    expect(screen.getByText(/DEFAULT/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始上架' }));
    await waitFor(() => expect(screen.getByLabelText('库位')).toHaveValue('A-01'));
    await user.click(screen.getByRole('button', { name: '确认库位' }));
    const sku = await screen.findByLabelText('货品');
    fireEvent.change(sku, { target: { value: 'A-1' } });
    await user.click(screen.getByRole('button', { name: '确认货品' }));
    const target = await screen.findByLabelText('目标库位');
    fireEvent.change(target, { target: { value: 'B-01' } });
    await user.click(screen.getByRole('button', { name: '此行放入' }));
    expect(await screen.findByText(/A-01 → B-01/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认上架' }));

    expect(await screen.findByRole('heading', { name: '已上架' })).toBeInTheDocument();
    expect(screen.getByText('库存已挪到目标库位。电脑上还要再点一次完成。')).toBeInTheDocument();
    expect(screen.getByText('库位 A-02 快满了')).toHaveClass('field-warn');
    expect(posts).toEqual([
      {
        url: 'http://10.0.0.8:3000/api/orders/IN-9/putaway',
        body: {
          targets: [{ skuCode: 'A-1', fromLocationCode: 'A-01', batchNo: 'DEFAULT', toLocationCode: 'B-01' }],
        },
      },
    ]);
    expect(posts[0]?.body).not.toHaveProperty('quantity');
    expect(window.localStorage.getItem('onewms.field.putawayDraft.v1') ?? '').toBe('');
  });

  it('只确认时提交空对象，货留在收货库位', async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot);
        if (url.includes('/api/orders?')) {
          const parsed = new URL(url);
          expect(parsed.searchParams.get('state')).toBe('received,inspected');
          expect(parsed.searchParams.get('sort')).toBe('updatedAtAsc');
          expect(parsed.searchParams.get('warehouseCode')).toBeNull();
          return json({ total: 1, limit: 50, offset: 0, hasMore: false, rows: [order] });
        }
        if (init?.method === 'POST' && url.endsWith('/api/orders/IN-9/putaway')) {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return json({ orderNo: 'IN-9', from: 'received', to: 'putaway' });
        }
        throw new Error(`意外请求 ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App />
      </FieldSessionProvider>,
    );
    await enterPutaway(user);
    await user.click(screen.getByRole('button', { name: '只确认、先不挪货' }));
    expect(screen.getByText('货留在收货库位，单据变为已上架')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认上架' }));

    expect(await screen.findByRole('heading', { name: '已上架' })).toBeInTheDocument();
    expect(screen.getByText('货留在收货库位。电脑上还要再点一次完成。')).toBeInTheDocument();
    expect(screen.queryByText('库位 A-02 快满了')).not.toBeInTheDocument();
    expect(posts).toEqual([{ url: 'http://10.0.0.8:3000/api/orders/IN-9/putaway', body: {} }]);
  });
});
