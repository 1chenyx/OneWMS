import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { FieldSessionProvider } from '../src/session.js';

const health = { ok: true, nodeId: 'node-9', workspaceId: 'wh-main' };

const order = {
  orderNo: 'IN-1',
  state: 'created',
  partnerName: '甲供应商',
  partnerCode: 'SUP-1',
  expectedAt: null,
  returnOfOrderNo: null,
  lines: [
    {
      skuCode: 'A-1',
      name: '螺丝',
      quantity: 4,
      unit: '个',
      locationCode: 'DEFAULT',
      warehouseCode: null,
      batchNo: 'DEFAULT',
      batchExpiryDate: null,
      serialTracked: false,
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function enterFloor(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
  await user.click(screen.getByRole('button', { name: '连接' }));
  await user.click(await screen.findByRole('button', { name: '现场作业' }));
}

describe('待收货', () => {
  it('整单核对后只提交 received，完成步给出上架入口但不提交上架', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) {
          return json({
            workspaceId: 'wh-main',
            modules: {
              'core.wms': { enabled: true },
              'module.warehouse': { enabled: false },
              'module.partial': { enabled: false },
              'module.serial': { enabled: false },
              'module.qc': { enabled: false },
              'module.putaway': { enabled: true },
            },
            workflows: { inbound: { states: [{ id: 'created', label: '已创建' }, { id: 'received', label: '已收货' }] } },
          });
        }
        if (url.includes('/api/orders?')) {
          return json({ total: 1, limit: 50, offset: 0, hasMore: false, rows: [order] });
        }
        if (url.includes('/api/locations?code=')) {
          return json([
            {
              locationCode: 'DEFAULT',
              name: '默认',
              warehouseCode: null,
              warehouseName: null,
              zoneCode: null,
              zoneName: null,
              zoneKind: null,
              zoneKindLabel: null,
            },
          ]);
        }
        if (url.includes('/api/skus?barcode=')) return json([]);
        if (url.includes('/api/skus?skuCode=')) {
          return json([{ skuCode: 'A-1', name: '螺丝', barcode: null, status: 'active', serialTracked: false }]);
        }
        if (init?.method === 'POST' && url.includes('/api/orders/IN-1/transition')) {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return json({ orderNo: 'IN-1', state: 'received' });
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
    await enterFloor(user);
    await user.click(screen.getByRole('button', { name: '待收货' }));
    await user.click(await screen.findByRole('button', { name: 'IN-1' }));
    expect(screen.getByText('甲供应商')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始收货' }));
    expect(await screen.findByLabelText('库位')).toHaveValue('DEFAULT');
    await user.click(screen.getByRole('button', { name: '确认库位' }));
    const sku = await screen.findByLabelText('货品');
    fireEvent.change(sku, { target: { value: 'A-1' } });
    await user.click(screen.getByRole('button', { name: '确认货品' }));
    expect(await screen.findByLabelText('数量')).toHaveValue('4');
    await user.click(screen.getByRole('button', { name: '行确认' }));
    expect(await screen.findByLabelText('批次')).toHaveValue('DEFAULT');
    await user.click(screen.getByRole('button', { name: '批次没错' }));
    await user.click(screen.getByRole('button', { name: '确认收货' }));

    expect(await screen.findByRole('heading', { name: '已收货' })).toBeInTheDocument();
    expect(screen.getByText('下一跳是上架')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去上架' })).toBeInTheDocument();
    expect(screen.queryByText('建预报')).not.toBeInTheDocument();
    expect(posts).toEqual([{ url: 'http://10.0.0.8:3000/api/orders/IN-1/transition', body: { to: 'received' } }]);
    expect(urls.some((url) => url.includes('/putaway') || url.includes('/invoke') || url.includes('/revise'))).toBe(false);
    expect(window.localStorage.getItem('onewms.field.receiveDraft.v1') ?? '').toBe('');
  });

  it('多仓没选之前不拉待收单', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) {
          return json({
            workspaceId: 'wh-main',
            modules: {
              'core.wms': { enabled: true },
              'module.warehouse': { enabled: true },
            },
          });
        }
        if (url.endsWith('/api/warehouses')) return json([{ warehouseCode: 'WH-1', name: '一号仓' }]);
        if (url.includes('/api/orders?')) {
          return json({ total: 0, limit: 50, offset: 0, hasMore: false, rows: [] });
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
    await enterFloor(user);
    expect(await screen.findByText('选仓库')).toBeInTheDocument();
    expect(urls.some((url) => url.includes('/api/orders'))).toBe(false);
    await user.click(screen.getByRole('button', { name: /WH-1/ }));
    await user.click(screen.getByRole('button', { name: '待收货' }));
    expect(await screen.findByText('没有待收')).toBeInTheDocument();
    const list = urls.find((url) => url.includes('/api/orders?'));
    expect(list).toBeTruthy();
    expect(new URL(list!).searchParams.get('warehouseCode')).toBe('WH-1');
    expect(new URL(list!).searchParams.get('state')).toBe('created,announced');
  });
});
