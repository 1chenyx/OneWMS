import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import {
  envPeers,
  mergePeerUrls,
  normalizePeerUrl,
  PEERS_FILE,
  readPeers,
} from '../src/sync/peer-store.js';

/**
 * 扫码组网（peers 持久化 + 添加校验 + 合并源）：
 *  - normalizePeerUrl / mergePeerUrls 纯函数分支；
 *  - POST /api/sync/peers：握手通过才落盘，工作区不一致 422、连不上 502，都不留脏记录；
 *  - 重复/异形 URL 幂等（尾斜杠、大写 host 归一到同一条）；
 *  - DELETE 三态、GET 清单结构、lan-address 端口未知时 url=null；
 *  - POST /api/sync/run 无 body 时用「清单 ∪ env」合并源（运行中加的节点即刻参与）。
 * 双 AppContext + vi.stubGlobal('fetch') 按 host 分发，零网络跑通双节点。
 */

const ctxs: AppContext[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const c of ctxs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'onewms-peers-'));
  dirs.push(d);
  return d;
}

function setup(options?: { workspaceId?: string; persist?: boolean; peersPath?: string | null }) {
  const workspaceId = options?.workspaceId ?? 'ws-peers';
  const dir = options?.persist === false ? null : (options?.peersPath ?? join(newDir(), PEERS_FILE));
  const ctx = createAppContext({ dbPath: ':memory:', workspaceId, peersPath: dir });
  ctxs.push(ctx);
  return { ctx, app: createApp(ctx), peersPath: dir };
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body?: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body ?? {}), headers: json });

/** 按 host 把 fetch 分发到对应 app（未登记的 host 视为连不上） */
function stubHosts(routes: Record<string, ReturnType<typeof createApp>>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const app = routes[u.hostname];
    if (!app) return Promise.reject(new Error(`connect ECONNREFUSED ${u.host}`));
    return app.request(u.pathname + u.search, init);
  });
}

describe('normalizePeerUrl：归一与拒绝', () => {
  it('去尾斜杠 / host 小写 / 保留端口', () => {
    expect(normalizePeerUrl('HTTP://192.168.1.20:3000/')).toEqual({ ok: true, url: 'http://192.168.1.20:3000' });
    expect(normalizePeerUrl('  http://Node.Local:3000/a/b?x=1  ')).toEqual({ ok: true, url: 'http://node.local:3000' });
    expect(normalizePeerUrl('https://wms.example.com')).toEqual({ ok: true, url: 'https://wms.example.com' });
  });

  it('空值 / 非 URL / 非 http(s) 都给中文 message', () => {
    expect(normalizePeerUrl('').ok).toBe(false);
    expect(normalizePeerUrl(undefined).ok).toBe(false);
    const bad = normalizePeerUrl('192.168.1.20:3000');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('不合法');
    const ftp = normalizePeerUrl('ftp://a:21');
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.message).toContain('http');
  });
});

describe('mergePeerUrls / envPeers：合并去重', () => {
  it('跨源去重（归一后比较），非法值跳过而不是抛', () => {
    expect(
      mergePeerUrls(['http://a:3000/', 'http://a:3000'], ['http://b:3000', 'not-a-url', '']),
    ).toEqual(['http://a:3000', 'http://b:3000']);
    expect(mergePeerUrls(undefined, undefined)).toEqual([]);
  });

  it('envPeers：逗号/中文逗号/换行混排都能拆', () => {
    expect(envPeers({ ONE_SYNC_PEERS: ' http://a:3000 ，http://b:3000\nhttp://c:3000,, ' })).toEqual([
      'http://a:3000',
      'http://b:3000',
      'http://c:3000',
    ]);
    expect(envPeers({})).toEqual([]);
  });
});

describe('POST /api/sync/peers：握手通过才落盘', () => {
  it('添加成功：清单落盘 + 记录对端 nodeId + 当场同步一轮', async () => {
    const a = setup({ workspaceId: 'ws-pair' });
    const b = setup({ workspaceId: 'ws-pair' });
    stubHosts({ 'b.test': b.app });
    // B 上先建一条 SKU，A 添加后应立刻看到（「配对完就有数据」是 0 基础用户的信心来源）
    await post(b.app, '/api/skus', { skuCode: 'B-1', name: 'B 的货' });

    const res = await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000/' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      peer: { url: string; nodeId: string; addedAt: string };
      round: { status: string; accepted: number; replayed: boolean };
      peers: unknown[];
    };
    expect(body.peer.url).toBe('http://b.test:3000'); // 尾斜杠归一
    expect(body.peer.nodeId).toBe(b.ctx.core.nodeId);
    expect(body.round.status).toBe('synced');
    expect(body.round.accepted).toBeGreaterThan(0);
    expect(body.round.replayed).toBe(true);
    expect(body.peers).toHaveLength(1);

    // 落盘真相面：文件里就是归一后的 URL
    const onDisk = readPeers(a.peersPath);
    expect(onDisk.map((p) => p.url)).toEqual(['http://b.test:3000']);
    expect(JSON.parse(readFileSync(a.peersPath!, 'utf-8')).version).toBe(1);

    // 数据确实过来了
    const skus = (await (await a.app.request('/api/skus')).json()) as { skuCode: string }[];
    expect(skus.map((s) => s.skuCode)).toContain('B-1');
  });

  it('工作区不一致 → 422 SYNC_PEER_MISMATCH，文案含双方工作区，且不落盘', async () => {
    const a = setup({ workspaceId: 'ws-one' });
    const b = setup({ workspaceId: 'ws-other' });
    stubHosts({ 'b.test': b.app });

    const res = await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('SYNC_PEER_MISMATCH');
    expect(body.message).toContain('ws-one');
    expect(body.message).toContain('ws-other');
    expect(readPeers(a.peersPath)).toEqual([]);
  });

  it('连不上 → 502 SYNC_PEER_UNREACHABLE（中文提示），不落盘', async () => {
    const a = setup();
    stubHosts({}); // 没有任何 host 登记 → fetch reject

    const res = await post(a.app, '/api/sync/peers', { url: 'http://dead.test:3000' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('SYNC_PEER_UNREACHABLE');
    expect(body.message).toContain('连不上对端');
    expect(readPeers(a.peersPath)).toEqual([]);
  });

  it('对端不是 OneWMS（应答无 workspaceId）→ 502，不落盘', async () => {
    const a = setup();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ hello: 'world' }), { status: 200 })));

    const res = await post(a.app, '/api/sync/peers', { url: 'http://other.test:80' });
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'SYNC_PEER_UNREACHABLE' });
    expect(readPeers(a.peersPath)).toEqual([]);
  });

  it('地址不合法 → 400 SYNC_PEER_BAD_URL', async () => {
    const a = setup();
    const res = await post(a.app, '/api/sync/peers', { url: 'b.test:3000' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'SYNC_PEER_BAD_URL' });
  });

  it('重复添加幂等：异形 URL 归一成一条，不重复入账', async () => {
    const a = setup({ workspaceId: 'ws-dup' });
    const b = setup({ workspaceId: 'ws-dup' });
    stubHosts({ 'b.test': b.app });

    for (const url of ['http://b.test:3000', 'http://b.test:3000/', 'http://B.TEST:3000']) {
      expect((await post(a.app, '/api/sync/peers', { url })).status).toBe(200);
    }
    const list = (await (await a.app.request('/api/sync/peers')).json()) as { peers: { url: string }[] };
    expect(list.peers).toHaveLength(1);
    expect(list.peers[0]!.url).toBe('http://b.test:3000');
  });
});

describe('GET / DELETE /api/sync/peers：清单面', () => {
  it('GET 返回 persisted/path/peers；落盘宿主 persisted=true', async () => {
    const a = setup();
    const empty = (await (await a.app.request('/api/sync/peers')).json()) as {
      persisted: boolean;
      path: string;
      peers: unknown[];
    };
    expect(empty.persisted).toBe(true);
    expect(empty.path).toBe(a.peersPath);
    expect(empty.peers).toEqual([]);
  });

  it(':memory: 宿主（无落盘位）persisted=false，配对仍可用（仅进程内）', async () => {
    const a = setup({ persist: false });
    const b = setup({ persist: false });
    stubHosts({ 'b.test': b.app });
    expect((await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000' })).status).toBe(200);
    const list = (await (await a.app.request('/api/sync/peers')).json()) as { persisted: boolean; peers: unknown[] };
    expect(list.persisted).toBe(false);
    expect(list.peers).toHaveLength(1);
  });

  it('DELETE：删掉返回 removed=true，再删 removed=false；地址不合法 400', async () => {
    const a = setup({ workspaceId: 'ws-del' });
    const b = setup({ workspaceId: 'ws-del' });
    stubHosts({ 'b.test': b.app });
    await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000' });

    const del = (await a.app.request('/api/sync/peers?url=http%3A%2F%2Fb.test%3A3000%2F', { method: 'DELETE' })) as Response;
    expect(del.status).toBe(200);
    const first = (await del.json()) as { removed: boolean; peers: unknown[] };
    expect(first.removed).toBe(true);
    expect(first.peers).toEqual([]);
    expect(readPeers(a.peersPath)).toEqual([]); // 文件同步清掉

    const again = (await a.app.request('/api/sync/peers?url=http://b.test:3000', { method: 'DELETE' })) as Response;
    expect(((await again.json()) as { removed: boolean }).removed).toBe(false);

    const bad = await a.app.request('/api/sync/peers?url=nope', { method: 'DELETE' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/sync/lan-address：本机可被访问的地址', () => {
  it('端口未知（未起端口的宿主）→ url=null，但 nodeId/workspaceId 仍在', async () => {
    const a = setup({ workspaceId: 'ws-lan' });
    const res = await a.app.request('/api/sync/lan-address');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodeId: string; workspaceId: string; ip: string | null; port: number | null; url: string | null };
    expect(body.nodeId).toBe(a.ctx.core.nodeId);
    expect(body.workspaceId).toBe('ws-lan');
    expect(body.port).toBeNull();
    expect(body.url).toBeNull();
  });

  it('记下监听端口后 → 拼出 http://ip:port', async () => {
    const a = setup();
    a.ctx.listeningPort = 3001;
    const body = (await (await a.app.request('/api/sync/lan-address')).json()) as { ip: string | null; url: string | null };
    if (body.ip === null) return; // CI 无网卡时跳过断言（url 必然也是 null）
    expect(body.url).toBe(`http://${body.ip}:3001`);
  });
});

describe('POST /api/sync/run：缺省用「清单 ∪ env」合并源', () => {
  it('无 body 时同步已配对节点（env 里的也一起）', async () => {
    const a = setup({ workspaceId: 'ws-run' });
    const b = setup({ workspaceId: 'ws-run' });
    stubHosts({ 'b.test': b.app, 'env.test': b.app });
    await post(b.app, '/api/skus', { skuCode: 'R-1', name: 'env 侧的货' });
    await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000' });
    vi.stubEnv('ONE_SYNC_PEERS', 'http://env.test:3000');

    const res = await a.app.request('/api/sync/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { peer: string; status: string }[] };
    expect(results.map((r) => r.peer).sort()).toEqual(['http://b.test:3000', 'http://env.test:3000']);
    expect(results.every((r) => r.status !== 'error')).toBe(true);
  });

  it('一个节点都没配对 → 400 SYNC_NO_PEERS（中文提示去添加）', async () => {
    const a = setup();
    vi.stubEnv('ONE_SYNC_PEERS', '');
    const res = await a.app.request('/api/sync/run', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('SYNC_NO_PEERS');
    expect(body.message).toContain('添加节点');
  });

  it('body 显式给 peers 时只用它（不掺清单）', async () => {
    const a = setup({ workspaceId: 'ws-explicit' });
    const b = setup({ workspaceId: 'ws-explicit' });
    stubHosts({ 'b.test': b.app });
    await post(a.app, '/api/sync/peers', { url: 'http://b.test:3000' });

    const res = await post(a.app, '/api/sync/run', { peers: ['http://b.test:3000/'] });
    const { results } = (await res.json()) as { results: { peer: string }[] };
    expect(results).toHaveLength(1);
    expect(results[0]!.peer).toBe('http://b.test:3000');
  });
});
