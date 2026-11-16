import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { FieldSessionProvider } from '../src/session.js';

/**
 * 连上之后能看见工作区。上架卡片出现，点开之前不拉单据。模块编号不铺在界面上。
 * 管理看板只拉全库读接口。
 */

const health = { ok: true, nodeId: 'node-9', workspaceId: 'wh-main' };
const snapshot = {
  workspaceId: 'wh-main',
  modules: {
    'module.qc': { enabled: false },
    'module.putaway': { enabled: true, manifest: { name: '上架作业' } },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderApp() {
  return render(
    <FieldSessionProvider>
      <App />
    </FieldSessionProvider>,
  );
}

describe('连接', () => {
  it('成功后进入现场，只请求健康检查和配置快照', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') throw new Error(`意外 ${init.method}`);
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot);
        if (url.includes('/api/dashboard/orders')) return json([]);
        if (url.includes('/api/dashboard/workload')) return json({ pickingOpen: 0 });
        if (url.includes('/api/dashboard/stock')) return json({ lowStockCount: 0, lowStock: [] });
        if (url.includes('/api/dashboard/urgent')) return json([]);
        if (url.includes('/api/dashboard/alerts')) {
          return json({ expiredCount: 0, criticalCount: 0, warningCount: 0, holdCount: 0, negativeCount: 0, negativeBuckets: [] });
        }
        if (url.includes('/api/dashboard/flow-trend')) {
          return json([{ day: new Date().toISOString().slice(0, 10), inbound: 0, outbound: 0 }]);
        }
        if (url.endsWith('/api/order-conflicts')) return json([]);
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
    await user.click(screen.getByRole('button', { name: '连接' }));

    expect(await screen.findByText('wh-main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '这台手机用来' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /现场作业/ }));
    expect(screen.getByRole('heading', { name: '任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /待上架/ })).toBeInTheDocument();
    expect(screen.queryByText('没有待办')).not.toBeInTheDocument();
    expect(screen.queryByText('待收货')).not.toBeInTheDocument();

    const beforeManage = urls.length;
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByText('module.qc')).not.toBeInTheDocument();
    expect(screen.queryByText('上架作业')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(screen.getByText('wh-main')).toBeInTheDocument();
    expect(screen.getByText('node-9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '这台手机' }));
    await user.click(screen.getByRole('button', { name: '管理' }));
    expect(await screen.findByRole('heading', { name: '看板' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '全库待收' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '全库待上架' })).toBeInTheDocument();
    expect(screen.queryByText('看板上还没有数字')).not.toBeInTheDocument();
    expect(urls.slice(0, beforeManage).every((url) => url.endsWith('/api/health') || url.endsWith('/api/profile/snapshot'))).toBe(true);
    const later = urls.slice(beforeManage);
    expect(later.some((url) => url.includes('/api/dashboard/orders'))).toBe(true);
    expect(later.some((url) => url.includes('/api/orders') || url.includes('lowOnly') || url.includes('full=1'))).toBe(false);
  });

  it('连不上时可以重试，也可以改地址', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.9:3000');
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('没连上，看地址再试');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '改地址' }));
    expect(screen.getByLabelText('服务器地址')).toHaveValue('http://10.0.0.9:3000');
  });
});
