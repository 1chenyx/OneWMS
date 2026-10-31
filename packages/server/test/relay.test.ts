import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, createAppContext, createRelayApp, type AppContext } from '../src/index.js';
import { sealEnvelope, buildEnvelope, type SealedEvent } from '@one/core';

/**
 * 云中继测试（DESIGN §8.5 传输安全 / §8.8 中继，里程碑 7）：
 *  - 中继 app 直测：hello / events 分页 / push 幂等与冲突 / 目录 / 参数校验；
 *  - 三方零网络集成（A、B 双节点 + 中继）：密钥人工交换 → A push → B pull 收敛，
 *    并断言「中继只见密文」——中继存储里没有明文业务字符串。
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

/** 把全局 fetch 转发到中继 app.request（pathname + search，丢弃主机名） */
function stubFetchToRelay(relayApp: ReturnType<typeof createRelayApp>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return relayApp.request(u.pathname + u.search, init);
  });
}

/** 手工构造一条密文事件（中继直测用——不经节点） */
function mkSealed(workspaceId: string, actor: string, seq: number, eventId: string, key = 'a'.repeat(64)): SealedEvent {
  return sealEnvelope(
    buildEnvelope({ workspaceId, actor, seq, lamport: seq, type: 'wms.sku.created', payload: { name: `SKU-${seq}` } }),
    key,
  );
}

describe('中继 app 直测（服务方角色）', () => {
  it('hello：空工作区返回零水位；nodeId 带 relay- 前缀；缺 workspaceId → 400', async () => {
    const relay = createRelayApp({ relayNodeId: 'relay-test' });
    const hello = (await (await relay.request('/relay/hello?workspaceId=ws-1')).json()) as {
      nodeId: string;
      workspaceId: string;
      profileVersion: number;
      eventCount: number;
      watermarks: Record<string, unknown>;
    };
    expect(hello).toEqual({ nodeId: 'relay-test', workspaceId: 'ws-1', profileVersion: 0, eventCount: 0, watermarks: {} });
    expect((await relay.request('/relay/hello')).status).toBe(400);
  });

  it('push 幂等：同批重推 → skipped；同 (actor,seq) 异 eventId → conflicted；水位随 push 可见', async () => {
    const relay = createRelayApp();
    const s1 = mkSealed('ws-1', 'user@n1', 1, 'e-1');
    const s2 = mkSealed('ws-1', 'user@n1', 2, 'e-2');
    const r1 = (await (await post(relay, '/relay/push', {
      workspaceId: 'ws-1', nodeId: 'n1', profileVersion: 5, sealedEvents: [s1, s2],
    })).json()) as { accepted: number; skipped: number; conflicted: number };
    expect(r1).toEqual({ accepted: 2, skipped: 0, conflicted: 0 });

    const r2 = (await (await post(relay, '/relay/push', {
      workspaceId: 'ws-1', nodeId: 'n1', profileVersion: 5, sealedEvents: [s1, s2],
    })).json()) as { accepted: number; skipped: number; conflicted: number };
    expect(r2).toEqual({ accepted: 0, skipped: 2, conflicted: 0 });

    const s2ghost = mkSealed('ws-1', 'user@n1', 2, 'e-other');
    const r3 = (await (await post(relay, '/relay/push', {
      workspaceId: 'ws-1', nodeId: 'n1', profileVersion: 5, sealedEvents: [s2ghost],
    })).json()) as { accepted: number; skipped: number; conflicted: number };
    expect(r3.conflicted).toBe(1);

    const hello = (await (await relay.request('/relay/hello?workspaceId=ws-1')).json()) as {
      profileVersion: number;
      eventCount: number;
      watermarks: Record<string, { seq: number; checksum?: string }>;
    };
    expect(hello.profileVersion).toBe(5);
    expect(hello.eventCount).toBe(2);
    expect(hello.watermarks['user@n1']!.seq).toBe(2);
    expect(hello.watermarks['user@n1']!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('events：分页游标 + fromSeq/limit 校验 + 跨工作区密文拒收', async () => {
    const relay = createRelayApp();
    const sealed = [1, 2, 3].map((i) => mkSealed('ws-1', 'user@n1', i, `e-${i}`));
    await post(relay, '/relay/push', { workspaceId: 'ws-1', nodeId: 'n1', profileVersion: 1, sealedEvents: sealed });

    const p1 = (await (await relay.request('/relay/events/user@n1?workspaceId=ws-1&fromSeq=0&limit=2')).json()) as {
      events: SealedEvent[];
      nextFromSeq: number;
      hasMore: boolean;
    };
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.nextFromSeq).toBe(3);
    expect(p1.hasMore).toBe(true);
    const p2 = (await (await relay.request(`/relay/events/user@n1?workspaceId=ws-1&fromSeq=${p1.nextFromSeq}&limit=2`)).json()) as {
      events: SealedEvent[];
      hasMore: boolean;
    };
    expect(p2.events.map((e) => e.seq)).toEqual([3]);
    expect(p2.hasMore).toBe(false);

    expect((await relay.request('/relay/events/user@n1?fromSeq=0')).status).toBe(400);
    expect((await relay.request('/relay/events/user@n1?workspaceId=ws-1&fromSeq=-1')).status).toBe(400);
    expect((await relay.request('/relay/events/user@n1?workspaceId=ws-1&fromSeq=0&limit=9999')).status).toBe(400);

    // 跨工作区密文：信封明文字段自带边界，整批拒收
    const cross = mkSealed('ws-other', 'user@n1', 1, 'e-x');
    const res = await post(relay, '/relay/push', { workspaceId: 'ws-1', nodeId: 'n1', sealedEvents: [cross] });
    expect(res.status).toBe(400);
  });

  it('push 参数校验：缺 workspaceId/nodeId、空数组、超批 → 400；directory 随 push 刷新', async () => {
    const relay = createRelayApp();
    expect((await post(relay, '/relay/push', { nodeId: 'n1', sealedEvents: [mkSealed('ws-1', 'a', 1, 'e')] })).status).toBe(400);
    expect((await post(relay, '/relay/push', { workspaceId: 'ws-1', sealedEvents: [mkSealed('ws-1', 'a', 1, 'e')] })).status).toBe(400);
    expect((await post(relay, '/relay/push', { workspaceId: 'ws-1', nodeId: 'n1', sealedEvents: [] })).status).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i) => mkSealed('ws-1', 'a', i + 1, `e-${i}`));
    expect((await post(relay, '/relay/push', { workspaceId: 'ws-1', nodeId: 'n1', sealedEvents: many })).status).toBe(400);

    await post(relay, '/relay/push', { workspaceId: 'ws-1', nodeId: 'node-aa', profileVersion: 1, sealedEvents: [mkSealed('ws-1', 'a', 1, 'e-1')] });
    const dir = (await (await relay.request('/relay/directory?workspaceId=ws-1')).json()) as {
      nodes: { nodeId: string; lastSeen: string }[];
    };
    expect(dir.nodes.map((n) => n.nodeId)).toEqual(['node-aa']);
    expect(Number.isNaN(Date.parse(dir.nodes[0]!.lastSeen))).toBe(false);
  });
});

describe('三方集成（A、B 双节点 + 中继，零网络）', () => {
  it('密钥人工交换 → A push → B pull 收敛；中继只见密文', async () => {
    const { ctx: ctxA, app: appA } = setup('ws-relay');
    const { ctx: ctxB, app: appB } = setup('ws-relay');
    const relay = createRelayApp({ relayNodeId: 'relay-int' });

    // A 产生业务数据（SKU + 库存流水）
    await post(appA, '/api/skus', { skuCode: 'R-100', name: '密封轴承' });
    await post(appA, '/api/inventory/adjust', { skuCode: 'R-100', delta: 42, reason: '期初' });

    // 密钥人工交换：A 生成 → export → B import
    const gen = (await (await post(appA, '/api/keys', {})).json()) as { key: string };
    const exported = (await (await appA.request('/api/keys/export')).json()) as { key: string; fingerprint: string };
    expect(exported.key).toBe(gen.key);
    const imported = await post(appB, '/api/keys/import', { key: exported.key });
    expect(imported.status).toBe(200);

    // A 经中继回合：push 自己的账本
    stubFetchToRelay(relay);
    const roundA = (await (await post(appA, '/api/relay/run', { relay: 'http://relay' })).json()) as {
      pushed: number;
      pushAccepted: number;
      accepted: number;
    };
    expect(roundA.pushed).toBeGreaterThan(0);
    expect(roundA.pushAccepted).toBe(roundA.pushed);
    expect(roundA.accepted).toBe(0); // 中继上没有 A 缺的东西

    // 中继只见密文：拉全部密文，序列化后不含明文业务字符串
    const helloA = (await (await relay.request('/relay/hello?workspaceId=ws-relay')).json()) as {
      watermarks: Record<string, { seq: number }>;
    };
    for (const [actor, mark] of Object.entries(helloA.watermarks)) {
      const page = (await (
        await relay.request(`/relay/events/${encodeURIComponent(actor)}?workspaceId=ws-relay&fromSeq=0&limit=1000`)
      ).json()) as { events: SealedEvent[] };
      expect(page.events.length).toBe(mark.seq);
      const dump = JSON.stringify(page.events);
      expect(dump).not.toContain('密封轴承');
      expect(dump).not.toContain('期初');
      expect(dump).not.toContain('"payload"'); // payload 原字段名都不该出现（只剩 cipher/nonce）
    }

    // B 经中继回合：pull A 的账本 → 投影收敛
    const roundB = (await (await post(appB, '/api/relay/run', { relay: 'http://relay' })).json()) as {
      accepted: number;
      replayed: boolean;
    };
    expect(roundB.accepted).toBeGreaterThan(0);
    expect(roundB.replayed).toBe(true);

    const skusB = (await (await appB.request('/api/skus')).json()) as { skuCode: string; name: string }[];
    expect(skusB.some((s) => s.skuCode === 'R-100' && s.name === '密封轴承')).toBe(true);
    const invB = (await (await appB.request('/api/inventory')).json()) as {
      skuCode: string;
      quantity: number;
    }[];
    expect(invB.find((i) => i.skuCode === 'R-100')!.quantity).toBe(42);

    // 双向收敛：B push 后 A 再拉（B 的种子/自身事件回流 A）
    await post(appB, '/api/relay/run', { relay: 'http://relay' });
    const roundA2 = (await (await post(appA, '/api/relay/run', { relay: 'http://relay' })).json()) as {
      accepted: number;
    };
    expect(roundA2.accepted).toBeGreaterThan(0);

    // 在线目录：两个节点都报到过
    const dir = (await (await relay.request('/relay/directory?workspaceId=ws-relay')).json()) as {
      nodes: { nodeId: string }[];
    };
    expect(dir.nodes.map((n) => n.nodeId).sort()).toEqual([ctxA.core.nodeId, ctxB.core.nodeId].sort());
  });

  it('错钥节点：拉到别人的密文 → 解密失败 400 CRYPTO_ERROR', async () => {
    const { app: appA } = setup('ws-wrongkey');
    const { app: appC } = setup('ws-wrongkey');
    const relay = createRelayApp(); // 独立中继，不污染上一例的存储

    await post(appA, '/api/skus', { skuCode: 'K-1', name: '钥匙测试' });
    await post(appA, '/api/keys', {});
    // C 自己生成了不同的密钥（没有人工交换）
    await post(appC, '/api/keys', {});

    stubFetchToRelay(relay);
    await post(appA, '/api/relay/run', { relay: 'http://relay' });
    const res = await post(appC, '/api/relay/run', { relay: 'http://relay' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CRYPTO_ERROR');
  });

  it('无密钥 / 无中继地址 → 400 预检拦截', async () => {
    const { app } = setup('ws-nokey');
    const noKey = await post(app, '/api/relay/run', { relay: 'http://relay' });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { code: string }).code).toBe('RELAY_NO_KEY');

    await post(app, '/api/keys', {});
    const noUrl = await post(app, '/api/relay/run', {});
    expect(noUrl.status).toBe(400);
    expect(((await noUrl.json()) as { code: string }).code).toBe('RELAY_NO_URL');
  });
});
