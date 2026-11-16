import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { createFakeBroadcast } from '../src/scan/broadcast.js';
import { FieldSessionProvider } from '../src/session.js';

const health = { ok: true, nodeId: 'node-9', workspaceId: 'wh-main' };
const snapshot = { workspaceId: 'wh-main', modules: {} };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('扫码设置', () => {
  it('可以关楔入、填斑马预置，广播测试只显示字符串', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/api/health')) return json(health);
        if (url.endsWith('/api/profile/snapshot')) return json(snapshot);
        throw new Error(`意外请求 ${url}`);
      }),
    );
    const plugin = createFakeBroadcast();
    const user = userEvent.setup();
    render(
      <FieldSessionProvider>
        <App broadcastPlugin={plugin} />
      </FieldSessionProvider>,
    );
    await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
    await user.click(screen.getByRole('button', { name: '连接' }));
    await user.click(await screen.findByRole('button', { name: '现场作业' }));
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '扫码' }));

    expect(screen.getByRole('button', { name: '相机还没装' })).toBeDisabled();
    expect(screen.getByText('填 DataWedge 的 Intent action')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '键盘楔入 开' }));
    expect(screen.getByRole('button', { name: '键盘楔入 关' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: '斑马' }));
    expect(screen.getByLabelText('广播 extra')).toHaveValue('com.symbol.datawedge.data_string');
    expect(screen.getByLabelText('广播 action')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: '广播测试' }));
    expect(await screen.findByText('等一次扫码')).toBeInTheDocument();
    await waitFor(() => {
      plugin.emit('LOC-1');
      expect(screen.getByText('LOC-1')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('最近扫码')).toHaveValue('broadcast LOC-1');

    const saved = window.localStorage.getItem('onewms.field.v1') ?? '';
    expect(saved).toContain('"wedge":false');
    expect(saved).not.toMatch(/password/i);
    expect(urls.every((url) => url.endsWith('/api/health') || url.endsWith('/api/profile/snapshot'))).toBe(true);
  });
});
