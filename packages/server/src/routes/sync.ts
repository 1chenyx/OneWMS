import { networkInterfaces } from 'node:os';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { runSyncRound, type SyncRoundResult } from '../sync/sync-client.js';
import { envPeers, mergePeerUrls, normalizePeerUrl } from '../sync/peer-store.js';

/**
 * 同步端点（拉模型，协议见 ARCHITECTURE.md「同步回合」）：
 *  - GET    /hello          握手：nodeId / workspaceId / profileVersion / 水位 / 计数；
 *  - GET    /events/:actor  按 actor 区间供事件（fromSeq 闭起点，默认 500/页）；
 *  - POST   /run            手动触发一轮拉取（body.peers ?? 清单 ∪ env）；
 *  - GET    /peers          已配对节点清单；
 *  - POST   /peers          添加节点（握手校验 → 落盘 → 立刻同步一轮）；
 *  - DELETE /peers?url=     移除节点；
 *  - GET    /lan-address    本端局域网地址（供对端扫码/誊录）。
 * 本文件只做参数解析与委托；账本操作在 core.sync，传输编排在 sync-client。
 *
 * 不加 CORS：跨节点通信一律走 server↔server（浏览器只跟本端同源说话），
 * 既避开版本偏斜，也不把 LAN 探测面暴露给任意网页。
 */

/** 供事件分页的硬上限（防恶意/误配的大页请求） */
const MAX_PAGE_LIMIT = 1000;

/** 添加节点时握手/同步的超时（局域网内 5s 足够，不该让页面转圈到天荒地老） */
const PEER_PROBE_TIMEOUT_MS = 5_000;

export function syncRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/hello', (c) => c.json(ctx.core.sync.handshake(ctx.workspaceId)))
    .get('/events/:actor', (c) => {
      const fromSeq = Number(c.req.query('fromSeq'));
      if (!Number.isInteger(fromSeq) || fromSeq < 0) {
        return c.json({ code: 'SYNC_BAD_REQUEST', message: 'fromSeq 必须是非负整数' }, 400);
      }
      const limitRaw = c.req.query('limit');
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)) {
        return c.json(
          { code: 'SYNC_BAD_REQUEST', message: `limit 必须是 1..${MAX_PAGE_LIMIT} 的整数` },
          400,
        );
      }
      return c.json(ctx.core.sync.eventsFor(ctx.workspaceId, c.req.param('actor'), fromSeq, limit));
    })
    .post('/run', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { peers?: unknown };
      // 请求体显式给的 → 只用它；否则合并「已配对清单 ∪ env」——运行中页面加的节点即刻参与
      const peers =
        body.peers === undefined
          ? mergePeerUrls(ctx.peers.list().map((p) => p.url), envPeers())
          : (Array.isArray(body.peers) ? body.peers : String(body.peers).split(/[,，\n]/))
              .map((s) => String(s).trim())
              .filter(Boolean)
              // 合法的归一（同节点两种写法不跑两轮）；非法的原样留着 → error 结果里看得见
              .map((s) => {
                const normalized = normalizePeerUrl(s);
                return normalized.ok ? normalized.url : s;
              });
      if (peers.length === 0) {
        return c.json(
          { code: 'SYNC_NO_PEERS', message: '还没有配对任何同步节点（在「添加节点」里填对端地址）' },
          400,
        );
      }
      return c.json({ results: await runPeers(ctx, peers) });
    })
    .get('/peers', (c) =>
      c.json({ persisted: ctx.peers.path !== null, path: ctx.peers.path, peers: ctx.peers.list() }),
    )
    .post('/peers', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
      const normalized = normalizePeerUrl(body.url);
      if (!normalized.ok) {
        return c.json({ code: 'SYNC_PEER_BAD_URL', message: normalized.message }, 400);
      }
      const url = normalized.url;

      // ① 先握手验明正身：不可达 / 不是 OneWMS / 工作区不一致都在落盘前拦掉
      let hello: { nodeId: string; workspaceId: string };
      try {
        const res = await fetchWithTimeout(`${url}/api/sync/hello`, PEER_PROBE_TIMEOUT_MS);
        if (!res.ok) {
          return c.json(
            { code: 'SYNC_PEER_UNREACHABLE', message: `对端没有应答（HTTP ${res.status}），确认对方 OneWMS 已启动、地址端口没错` },
            502,
          );
        }
        hello = (await res.json()) as { nodeId: string; workspaceId: string };
      } catch (err) {
        return c.json(
          {
            code: 'SYNC_PEER_UNREACHABLE',
            message: `连不上对端：${err instanceof Error ? err.message : String(err)}（要在同一局域网，且对方 OneWMS 已启动）`,
          },
          502,
        );
      }
      if (typeof hello?.workspaceId !== 'string') {
        return c.json(
          { code: 'SYNC_PEER_UNREACHABLE', message: '对端应答不是 OneWMS 的握手格式，确认地址填的是 OneWMS 服务' },
          502,
        );
      }
      if (hello.workspaceId !== ctx.workspaceId) {
        return c.json(
          {
            code: 'SYNC_PEER_MISMATCH',
            message: `两个节点不属于同一个仓库（本地工作区 ${ctx.workspaceId}，对端 ${hello.workspaceId}）。要同步必须用同一个工作区 ID 启动`,
          },
          422,
        );
      }

      // ② 落盘（同 URL 幂等更新）+ 立刻同步一轮，让用户当场看到数据过来
      ctx.peers.upsert(url, hello.nodeId);
      const [round] = await runPeers(ctx, [url]);
      return c.json({ peer: ctx.peers.list().find((p) => p.url === url), round, peers: ctx.peers.list() });
    })
    .delete('/peers', (c) => {
      const normalized = normalizePeerUrl(c.req.query('url'));
      if (!normalized.ok) {
        return c.json({ code: 'SYNC_PEER_BAD_URL', message: normalized.message }, 400);
      }
      const removed = ctx.peers.remove(normalized.url);
      return c.json({ removed, peers: ctx.peers.list() });
    })
    .get('/lan-address', (c) => {
      const ip = lanIPv4();
      const port = ctx.listeningPort;
      return c.json({
        nodeId: ctx.core.nodeId,
        workspaceId: ctx.workspaceId,
        ip,
        port,
        // 端口未知（未起端口的宿主）→ null，前端只展示 IP
        url: ip === null || port === null ? null : `http://${ip}:${port}`,
      });
    });
}

/** 逐 peer 跑一轮，单败不炸整轮（error 结果带中文 message，其余 peer 照常） */
async function runPeers(ctx: AppContext, peers: string[]): Promise<SyncRoundResult[]> {
  const results: SyncRoundResult[] = [];
  for (const peer of peers) {
    try {
      results.push(
        await runSyncRound({
          peerBaseUrl: peer,
          workspaceId: ctx.workspaceId,
          core: ctx.core,
          ws: ctx.ws,
          memory: ctx.memory,
        }),
      );
    } catch (err) {
      results.push({
        peer,
        status: 'error',
        pulled: 0,
        accepted: 0,
        skipped: 0,
        replayed: false,
        plan: [],
        theirProfileVersion: 0,
        myProfileVersion: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** 带超时的 fetch（Node 18+ 原生 AbortSignal.timeout） */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

/** 首个非内环 IPv4（多网卡机器上就是「局域网里别人能找到我的那个地址」） */
export function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

