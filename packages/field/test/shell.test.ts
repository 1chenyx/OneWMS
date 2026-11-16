import { describe, expect, it, vi } from 'vitest';
import { moduleRows } from '../src/api.js';
import { FieldApiError } from '../src/errors.js';
import { isFieldWritePath, OnlineCommandPort } from '../src/command.js';
import { loadFieldStore, saveFieldStore, type FieldStore, type KeyValueStore } from '../src/prefs.js';
import { FIELD_SCREENS, screenOpen } from '../src/screens.js';
import { normalizeBaseUrl, requestUrl, usesDevProxy } from '../src/url.js';
import { nextDelayMs } from '../src/watch.js';

/**
 * 壳的纯逻辑。写端口只许健康检查、收货修订、收货转移和上架。屏幕开待收货、待上架和管理看板。
 */

function memoryStore(initial = ''): KeyValueStore & { raw: string } {
  const box = { raw: initial };
  return {
    get raw() {
      return box.raw;
    },
    set raw(value: string) {
      box.raw = value;
    },
    getItem: () => (box.raw ? box.raw : null),
    setItem: (_key, value) => {
      box.raw = value;
    },
  };
}

describe('地址', () => {
  it('补上 http，去掉尾斜杠和多写的 /api', () => {
    expect(normalizeBaseUrl('192.168.1.20:3000/')).toBe('http://192.168.1.20:3000');
    expect(normalizeBaseUrl('http://192.168.1.20:3000/api/')).toBe('http://192.168.1.20:3000');
  });

  it('拒绝空地址、非 http、带查询', () => {
    expect(() => normalizeBaseUrl('  ')).toThrow(FieldApiError);
    expect(() => normalizeBaseUrl('ftp://192.168.1.20')).toThrow(FieldApiError);
    expect(() => normalizeBaseUrl('http://192.168.1.20:3000?x=1')).toThrow(FieldApiError);
  });

  it('开发预览连本机 3000 才走同源代理', () => {
    expect(usesDevProxy('http://127.0.0.1:3000', true)).toBe(true);
    expect(usesDevProxy('http://10.0.0.8:3000', true)).toBe(false);
    expect(requestUrl('http://127.0.0.1:3000', '/api/health', true)).toBe('/api/health');
    expect(requestUrl('http://10.0.0.8:3000', '/api/health', true)).toBe('http://10.0.0.8:3000/api/health');
    expect(requestUrl('http://127.0.0.1:3000', '/api/health', false)).toBe('http://127.0.0.1:3000/api/health');
  });
});

describe('写端口', () => {
  it('只放行健康检查、收货和上架', () => {
    expect(isFieldWritePath('/api/health')).toBe(true);
    expect(isFieldWritePath('/api/orders/IN-1/transition')).toBe(true);
    expect(isFieldWritePath('/api/orders/IN-1/revise')).toBe(true);
    expect(isFieldWritePath('/api/orders/IN-1/putaway')).toBe(true);
    expect(isFieldWritePath('/api/orders/IN-1/putaway?x=1')).toBe(false);
    expect(isFieldWritePath('/api/orders/IN-1/transition?x=1')).toBe(false);
    expect(isFieldWritePath('/api/tools/wms.order.transition/invoke')).toBe(false);
    expect(isFieldWritePath('/api/orders')).toBe(false);
  });

  it('查询串和工具总线不发出请求', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response('{}', { status: 200 }),
    );
    const port = new OnlineCommandPort('http://10.0.0.8:3000', fetchMock);
    await port.submit({ clientId: 'c1', method: 'POST', path: '/api/orders/IN-1/transition', body: { to: 'received' } });
    await port.submit({ clientId: 'c1', method: 'POST', path: '/api/orders/IN-1/revise', body: { lines: [] } });
    await port.submit({ clientId: 'c1', method: 'POST', path: '/api/orders/IN-1/putaway', body: {} });
    const paths = [
      '/api/orders/IN-1/putaway?x=1',
      '/api/orders/IN-1/transition?x=1',
      '/api/profile/snapshot',
      '/api/tools/wms.order.transition/invoke',
      '/api/orders',
    ];
    for (const path of paths) {
      await expect(
        port.submit({ clientId: 'c1', method: 'POST', path, body: { to: 'received' } }),
      ).rejects.toMatchObject({ code: 'FIELD_PATH_FORBIDDEN' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('健康检查打到拼好的地址，并读回错误码', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ ok: true, nodeId: 'n', workspaceId: 'ws' }), { status: 200 }),
    );
    const port = new OnlineCommandPort('http://10.0.0.8:3000', fetchMock);
    await port.submit({ clientId: 'c1', method: 'POST', path: '/api/health', body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://10.0.0.8:3000/api/health');
    expect(init?.method).toBe('POST');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'WMS_INVALID_TRANSITION', message: '电脑上已经改过这张单' }), { status: 400 }),
    );
    await expect(port.submit({ clientId: 'c1', method: 'POST', path: '/api/health', body: {} })).rejects.toMatchObject({
      code: 'WMS_INVALID_TRANSITION',
      message: '电脑上已经改过这张单',
      status: 400,
    });
  });
});

describe('偏好与屏幕', () => {
  it('坏掉的本地记录回到空', () => {
    const storage = memoryStore('{');
    expect(loadFieldStore(storage).connection).toBeNull();
    expect(loadFieldStore(storage).modeChosen).toBe(false);
  });

  it('记住地址、模式，不记住账号', () => {
    const storage = memoryStore();
    const store: FieldStore = {
      connection: { baseUrl: 'http://10.0.0.8:3000', workspaceId: 'wh-main', lastOkAt: '2026-11-16T00:00:00.000Z' },
      prefs: {
        mode: 'manage',
        sound: false,
        vibrate: true,
        warehouseCode: null,
        scan: { wedge: true, broadcast: true, camera: false, broadcastAction: '', broadcastExtra: '' },
      },
      modeChosen: true,
    };
    saveFieldStore(storage, store);
    expect(loadFieldStore(storage)).toEqual(store);
    expect(storage.raw).not.toContain('password');
  });

  it('打开待收货、待上架、管理看板和单据下钻', () => {
    expect(Object.entries(FIELD_SCREENS).filter(([, open]) => open).map(([id]) => id)).toEqual([
      'receive',
      'putaway',
      'manageBoard',
      'manageOrders',
    ]);
    expect(screenOpen('receive')).toBe(true);
    expect(screenOpen('putaway')).toBe(true);
    expect(screenOpen('manageBoard')).toBe(true);
    expect(screenOpen('manageOrders')).toBe(true);
    expect(screenOpen('qc')).toBe(false);
  });

  it('缺 enabled 当关，名字用快照里的 manifest', () => {
    const rows = moduleRows({
      'module.putaway': { enabled: true, manifest: { name: '上架作业' } },
      'module.qc': { enabled: false },
      'module.asn': {},
    });
    expect(rows.map((row) => [row.id, row.name, row.on])).toEqual([
      ['module.asn', 'module.asn', false],
      ['module.putaway', '上架作业', true],
      ['module.qc', 'module.qc', false],
    ]);
  });
});

describe('重连间隔', () => {
  it('成功 15 秒，失败从 1 秒翻倍到 30 秒', () => {
    expect(nextDelayMs(0)).toBe(15_000);
    expect(nextDelayMs(1)).toBe(1_000);
    expect(nextDelayMs(2)).toBe(2_000);
    expect(nextDelayMs(3)).toBe(4_000);
    expect(nextDelayMs(6)).toBe(30_000);
    expect(nextDelayMs(10)).toBe(30_000);
  });
});
