import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformLogin, probeServer } from '../src/api.js';
import {
  isPlatformHealth,
  noteFieldLink,
  platformNodeFromConnection,
  platformNodeId,
  readFieldToken,
  writeFieldToken,
} from '../src/platform.js';
import { fieldRequestTarget } from '../src/url.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  noteFieldLink('lan');
  window.localStorage.clear();
});

describe('平台连接', () => {
  it('开发页 5174 把平台地址转到同源转发', () => {
    expect(fieldRequestTarget('http://49.235.83.195/onewms', '/api/health', true, '5174')).toEqual({
      url: '/__field/api/health',
      relay: true,
    });
    expect(fieldRequestTarget('http://127.0.0.1:3000', '/api/health', true, '5174')).toEqual({
      url: '/api/health',
      relay: false,
    });
    expect(fieldRequestTarget('http://49.235.83.195/onewms', '/api/health', true, '')).toEqual({
      url: 'http://49.235.83.195/onewms/api/health',
      relay: false,
    });
  });

  it('平台健康检查没有节点号，节点名用平台根地址', () => {
    expect(isPlatformHealth({ ok: true, db: true })).toBe(true);
    expect(isPlatformHealth({ ok: true, nodeId: 'n', workspaceId: 'wh' })).toBe(false);
    expect(platformNodeId('http://49.235.83.195/onewms')).toBe('49.235.83.195/onewms');
    expect(platformNodeFromConnection({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms' }, 'http://127.0.0.1:3000')).toBe(
      '49.235.83.195/onewms',
    );
  });

  it('没有令牌时停在登录，不拉配置', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ ok: true, db: true });
    });
    await expect(probeServer('http://10.0.0.8:3000', fetchImpl)).rejects.toMatchObject({
      code: 'FIELD_PLATFORM_AUTH',
      message: '这是平台，先登录账号',
    });
    expect(urls).toEqual(['http://10.0.0.8:3000/api/health']);
  });

  it('登录后快照和后续请求带 Bearer，密码不落盘', async () => {
    const secret = 's3cret-pass';
    const seen: { url: string; authorization: string | null; body: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        return json({
          token: 'tok-1',
          user: { id: 'u1', email: 'a@b.c', displayName: '甲' },
          workspace: { id: 'wh-plat', name: '平台仓', role: 'clerk' },
          memberships: [{ workspaceId: 'wh-plat', name: '平台仓', role: 'clerk' }],
        });
      }
      if (url.endsWith('/api/health')) return json({ ok: true, db: true });
      if (url.endsWith('/api/connection')) return json({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms' });
      if (url.endsWith('/api/profile/snapshot')) return json({ workspaceId: 'wh-plat', modules: {} });
      if (url.endsWith('/api/auth/me')) {
        return json({
          user: { id: 'u1', email: 'a@b.c', displayName: '甲' },
          workspace: { id: 'wh-plat', name: '平台仓', role: 'clerk' },
          memberships: [],
        });
      }
      throw new Error(url);
    });

    const logged = await platformLogin('http://10.0.0.8:3000', 'a@b.c', secret, fetchImpl);
    expect(logged.workspaceId).toBe('wh-plat');
    expect(readFieldToken()).toBe('tok-1');
    const result = await probeServer('http://10.0.0.8:3000', fetchImpl);
    expect(result.health).toEqual({ ok: true, nodeId: '49.235.83.195/onewms', workspaceId: 'wh-plat' });
    expect(result.snapshot.workspaceId).toBe('wh-plat');

    const loginCall = seen.find((call) => call.url.endsWith('/api/auth/login'));
    expect(loginCall?.authorization).toBeNull();
    expect(loginCall?.body).toContain(secret);
    const snapshotCall = seen.find((call) => call.url.endsWith('/api/profile/snapshot'));
    expect(snapshotCall?.authorization).toBe('Bearer tok-1');
    expect(window.localStorage.getItem('onewms.field.v1') ?? '').not.toContain(secret);
    expect(window.localStorage.getItem('onewms.field.platformToken.v1')).toBe('tok-1');
    expect(JSON.stringify(window.localStorage)).not.toContain(secret);
    writeFieldToken(null);
  });
});
