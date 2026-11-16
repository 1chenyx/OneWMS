import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import { CONNECTION_FILE, normalizePlatformBaseUrl } from '../src/connection/connection-store.js';

/**
 * 连接方式：局域网留在本机；平台把 /api 转到根地址，但 /api/connection 始终留在本机。
 */

const ctxs: AppContext[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const c of ctxs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(persist = false) {
  const dir = persist ? mkdtempSync(join(tmpdir(), 'onewms-connection-')) : null;
  if (dir) dirs.push(dir);
  const ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-connection',
    connectionPath: dir ? join(dir, CONNECTION_FILE) : null,
  });
  ctxs.push(ctx);
  return { ctx, app: createApp(ctx), file: dir ? join(dir, CONNECTION_FILE) : null };
}

const json = { 'content-type': 'application/json' };

describe('平台根地址', () => {
  it('去掉尾斜杠和多写的 /api', () => {
    expect(normalizePlatformBaseUrl('http://49.235.83.195/onewms/')).toEqual({
      ok: true,
      url: 'http://49.235.83.195/onewms',
    });
    expect(normalizePlatformBaseUrl('http://49.235.83.195/onewms/api')).toEqual({
      ok: true,
      url: 'http://49.235.83.195/onewms',
    });
  });

  it('拒绝空地址、非 http、带查询', () => {
    expect(normalizePlatformBaseUrl('')).toMatchObject({ ok: false });
    expect(normalizePlatformBaseUrl('ftp://example.com/onewms')).toMatchObject({ ok: false });
    expect(normalizePlatformBaseUrl('http://example.com/onewms?x=1')).toMatchObject({ ok: false });
  });
});

describe('GET/PUT /api/connection', () => {
  it('默认局域网，健康检查仍是本机', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { app, ctx } = setup();
    const view = await (await app.request('/api/connection')).json();
    expect(view).toMatchObject({ mode: 'lan', platformBaseUrl: '', persisted: false });
    const health = await (await app.request('/api/health')).json();
    expect(health).toEqual({ ok: true, nodeId: ctx.core.nodeId, workspaceId: ctx.workspaceId });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('改为平台后业务接口被转发，连接接口仍在本机', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://49.235.83.195/onewms/api/health');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
      return new Response(JSON.stringify({ ok: true, db: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app } = setup(true);
    const saved = await (
      await app.request('/api/connection', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms/api/' }),
      })
    ).json();
    expect(saved).toMatchObject({
      mode: 'platform',
      platformBaseUrl: 'http://49.235.83.195/onewms',
      persisted: true,
    });

    const health = await app.request('/api/health', { headers: { authorization: 'Bearer tok' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, db: true });

    const stillLocal = await (await app.request('/api/connection')).json();
    expect(stillLocal.mode).toBe('platform');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('改回局域网后健康检查回到本机，文件记住平台地址', async () => {
    const { app, ctx, file } = setup(true);
    await app.request('/api/connection', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms' }),
    });
    await app.request('/api/connection', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ mode: 'lan' }),
    });
    const health = await (await app.request('/api/health')).json();
    expect(health.nodeId).toBe(ctx.core.nodeId);
    const saved = JSON.parse(readFileSync(file!, 'utf8')) as { mode: string; platformBaseUrl: string };
    expect(saved.mode).toBe('lan');
    expect(saved.platformBaseUrl).toBe('http://49.235.83.195/onewms');
  });

  it('平台连不上 → 502，不把本机健康检查冒充过去', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const { app } = setup();
    await app.request('/api/connection', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ mode: 'platform', platformBaseUrl: 'http://49.235.83.195/onewms' }),
    });
    const res = await app.request('/api/health');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'PLATFORM_UNREACHABLE' });
  });

  it('坏地址不切换', async () => {
    const { app } = setup();
    const res = await app.request('/api/connection', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ mode: 'platform', platformBaseUrl: 'not a url' }),
    });
    expect(res.status).toBe(400);
    const view = await (await app.request('/api/connection')).json();
    expect(view.mode).toBe('lan');
  });
});
