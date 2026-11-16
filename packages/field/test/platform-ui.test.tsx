import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { noteFieldLink } from '../src/platform.js';
import { FieldSessionProvider } from '../src/session.js';

const secret = 's3cret-pass';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  noteFieldLink('lan');
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('平台登录', () => {
  it('平台健康检查之后登录，令牌不进连接记录', async () => {
    const calls: { url: string; method: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization') });
        if (url.endsWith('/api/auth/login')) {
          return json({
            token: 'tok-1',
            user: { id: 'u1', email: 'a@b.c', displayName: '甲' },
            workspace: { id: 'wh-plat', name: '平台仓', role: 'clerk' },
            memberships: [{ workspaceId: 'wh-plat', name: '平台仓', role: 'clerk' }],
          });
        }
        if (url.endsWith('/api/health')) return json({ ok: true, db: true });
        if (url.endsWith('/api/connection')) {
          return json({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms', persisted: true });
        }
        if (url.endsWith('/api/profile/snapshot')) {
          return json({
            workspaceId: 'wh-plat',
            modules: { 'module.putaway': { enabled: true, manifest: { name: '上架作业' } } },
          });
        }
        if (url.endsWith('/api/auth/me')) {
          return json({
            user: { id: 'u1', email: 'a@b.c', displayName: '甲' },
            workspace: { id: 'wh-plat', name: '平台仓', role: 'clerk' },
            memberships: [],
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
    await user.type(screen.getByLabelText('服务器地址'), 'http://10.0.0.8:3000');
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByRole('heading', { name: '登录平台' })).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/api/profile/snapshot'))).toBe(false);

    fireEvent.change(screen.getByLabelText('平台邮箱'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('平台密码'), { target: { value: secret } });
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('wh-plat')).toBeInTheDocument();
    expect(screen.getByText('49.235.83.195/onewms')).toBeInTheDocument();
    expect(screen.getByText('平台账号已经登录。选这台手机的用法。')).toBeInTheDocument();
    const snapshot = calls.find((call) => call.url.endsWith('/api/profile/snapshot'));
    expect(snapshot?.authorization).toBe('Bearer tok-1');
    expect(window.localStorage.getItem('onewms.field.v1') ?? '').not.toContain(secret);
    expect(window.localStorage.getItem('onewms.field.platformToken.v1')).toBe('tok-1');
  });
});
