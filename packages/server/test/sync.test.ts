import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * 同步端点直测（拉模型，协议见 ARCHITECTURE.md「同步回合」）：
 *  - hello 结构 / events 分页与参数校验（服务方角色）；
 *  - 双 AppContext 模拟双节点：vi.stubGlobal 把 fetch 转发到对端 app.request，
 *    零网络跑通「A 拉 B → 摄入 → replayAll → 投影可见」的全链路（客户端角色）。
 */

const ctxs: AppContext[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const c of ctxs.splice(0)) c.close();
});

function setup(workspaceId: string) {
  const ctx = createAppContext({ dbPath: ':memory:', workspaceId });
  ctxs.push(ctx);
  return { ctx, app: createApp(ctx) };
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

/** 把全局 fetch 转发到对端 app.request（pathname + search，丢弃主机名） */
function stubFetchTo(peerApp: ReturnType<typeof createApp>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return peerApp.request(u.pathname + u.search, init);
  });
}

describe('同步端点（服务方角色）', () => {
  it('GET /api/sync/hello：nodeId / workspaceId / 版本 / 水位 / 计数结构完整', async () => {
    const { ctx, app } = setup('ws-hello');
    const res = await app.request('/api/sync/hello');
    expect(res.status).toBe(200);
    const hello = (await res.json()) as {
      nodeId: string;
      workspaceId: string;
      profileVersion: number;
      watermarks: Record<string, { seq: number }>;
      eventCount: number;
    };
    expect(hello.nodeId).toBe(ctx.core.nodeId);
    expect(hello.workspaceId).toBe('ws-hello');
    expect(hello.profileVersion).toBe(1); // 构造期种子已装载默认流程
    expect(hello.eventCount).toBeGreaterThan(0);
    // 种子字段提供者通道（actor 带节点后缀；M6 起归属 core.wms manifest 安装）
    expect(Object.keys(hello.watermarks).some((k) => k.startsWith('module:core.wms@'))).toBe(true);
  });

  it('GET /api/sync/events/:actor：分页游标 + 未知 actor 空结果', async () => {
    const { ctx, app } = setup('ws-events');
    for (const code of ['A-1', 'A-2', 'A-3']) {
      await post(app, '/api/skus', { skuCode: code, name: code });
    }
    const actor = encodeURIComponent(`user:local@${ctx.core.nodeId}`);

    const p1 = (await (await app.request(`/api/sync/events/${actor}?fromSeq=0&limit=2`)).json()) as {
      events: { seq: number }[];
      nextFromSeq: number;
      hasMore: boolean;
    };
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.nextFromSeq).toBe(3);
    expect(p1.hasMore).toBe(true);

    const p2 = (await (
      await app.request(`/api/sync/events/${actor}?fromSeq=${p1.nextFromSeq}&limit=2`)
    ).json()) as { events: unknown[]; hasMore: boolean };
    expect(p2.events).toHaveLength(1);
    expect(p2.hasMore).toBe(false);

    const unknown = (await (await app.request('/api/sync/events/node-ghost?fromSeq=0')).json()) as {
      events: unknown[];
    };
    expect(unknown.events).toEqual([]);
  });

  it('GET /api/sync/events/:actor：参数非法 → 400', async () => {
    const { app } = setup('ws-bad-params');
    expect((await app.request('/api/sync/events/user%3Alocal?fromSeq=abc')).status).toBe(400);
    expect((await app.request('/api/sync/events/user%3Alocal?fromSeq=-1')).status).toBe(400);
    expect((await app.request('/api/sync/events/user%3Alocal')).status).toBe(400); // fromSeq 缺省
    expect((await app.request('/api/sync/events/user%3Alocal?fromSeq=0&limit=0')).status).toBe(400);
    expect((await app.request('/api/sync/events/user%3Alocal?fromSeq=0&limit=9999')).status).toBe(400);
    expect((await app.request('/api/sync/events/user%3Alocal?fromSeq=0')).status).toBe(200);
  });
});

describe('同步回合（客户端角色，双节点零网络）', () => {
  it('双向互拉收敛：A/B 各建 SKU → A 拉 B 见 B 数据 → B 拉 A 双向一致 → 再拉 no-op', async () => {
    const A = setup('ws-dual');
    const B = setup('ws-dual');
    await post(A.app, '/api/skus', { skuCode: 'A-1', name: '甲' });
    await post(B.app, '/api/skus', { skuCode: 'B-1', name: '乙' });

    // ① A 拉 B：摄入对端事件 + 全量重放 → A 的投影可见 B 的 SKU
    stubFetchTo(B.app);
    const runA = await post(A.app, '/api/sync/run', { peers: ['http://peer-b'] });
    expect(runA.status).toBe(200);
    const rA = ((await runA.json()) as { results: { status: string; accepted: number; replayed: boolean }[] }).results[0]!;
    expect(rA.status).toBe('synced');
    expect(rA.accepted).toBeGreaterThan(0);
    expect(rA.replayed).toBe(true);

    const listA = (await (await A.app.request('/api/skus')).json()) as { skuCode: string }[];
    expect(listA.map((s) => s.skuCode)).toEqual(expect.arrayContaining(['A-1', 'B-1']));

    // ② B 拉 A：双向一致（B 也看得见 A 的 SKU）
    stubFetchTo(A.app);
    const runB = await post(B.app, '/api/sync/run', { peers: ['http://peer-a'] });
    const rB = ((await runB.json()) as { results: { status: string }[] }).results[0]!;
    expect(rB.status).toBe('synced');
    const listB = (await (await B.app.request('/api/skus')).json()) as { skuCode: string }[];
    expect(listB.map((s) => s.skuCode)).toEqual(expect.arrayContaining(['A-1', 'B-1']));

    // ③ 计数与水位双双追平 → 再拉一轮 no-op（幂等稳态）
    stubFetchTo(B.app);
    const again = await post(A.app, '/api/sync/run', { peers: ['http://peer-b'] });
    const rAgain = ((await again.json()) as { results: { status: string; accepted: number }[] }).results[0]!;
    expect(rAgain.status).toBe('no-op');
    expect(rAgain.accepted).toBe(0);
  });

  it('同步组不一致（workspaceId 不同）→ error 结果带原因，单败不炸整轮', async () => {
    const A = setup('ws-x');
    const B = setup('ws-y');
    stubFetchTo(B.app);
    const res = await post(A.app, '/api/sync/run', { peers: ['http://peer-b', 'http://peer-b'] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { status: string; message?: string }[] };
    expect(results).toHaveLength(2); // 第二个 peer 照常执行
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.message).toMatch(/同步组不一致/);
  });

  it('自拉防护：peer 指向自己 → skipped-self', async () => {
    const A = setup('ws-self');
    stubFetchTo(A.app);
    const res = await post(A.app, '/api/sync/run', { peers: ['http://self'] });
    const r = ((await res.json()) as { results: { status: string }[] }).results[0]!;
    expect(r.status).toBe('skipped-self');
  });

  it('POST /run 无 peers（body 与 env 皆空）→ 400', async () => {
    const { app } = setup('ws-no-peers');
    const prev = process.env.ONE_SYNC_PEERS;
    delete process.env.ONE_SYNC_PEERS;
    try {
      const res = await post(app, '/api/sync/run', {});
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('SYNC_NO_PEERS');
    } finally {
      if (prev !== undefined) process.env.ONE_SYNC_PEERS = prev;
    }
  });
});
