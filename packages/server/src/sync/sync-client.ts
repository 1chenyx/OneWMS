import { computePullPlan, type EventEnvelope, type PullRange, type SyncHandshake } from '@one/core';
import type { OneCore } from '@one/core';
import type { WmsWorkspace } from '@one/wms';

/**
 * 同步客户端（宿主层传输编排，DESIGN §8.5 五步协议的 HTTP 落地）。
 * 一个回合 = 握手 → 校验同步组/自拉防护 → 计算计划 → 逐区间分页拉取 →
 * 幂等摄入 → accepted>0 时 replayAll 全量重建「内核+领域」两层投影。
 * 双向同步 = 两个方向的回合（A 拉 B、B 拉 A），谁触发都收敛。
 */

/** 单 peer 回合结果（POST /api/sync/run 响应的单元；error 形态由路由层填充） */
export interface SyncRoundResult {
  peer: string;
  status: 'synced' | 'no-op' | 'skipped-self' | 'error';
  /** 网络传输的事件数 */
  pulled: number;
  /** 摄入接受数（新事件） */
  accepted: number;
  /** 摄入跳过数（eventId 查重） */
  skipped: number;
  /** 是否触发了全量重放 */
  replayed: boolean;
  plan: PullRange[];
  theirProfileVersion: number;
  myProfileVersion: number;
  /** error 状态时的错误说明（由路由层 catch 填充；其余状态无此字段） */
  message?: string;
}

/** fetch 的最小形状（测试注入 app.request，零网络模拟双节点） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function runSyncRound(params: {
  peerBaseUrl: string;
  workspaceId: string;
  core: OneCore;
  ws: WmsWorkspace;
  fetchImpl?: FetchLike;
}): Promise<SyncRoundResult> {
  const { peerBaseUrl, workspaceId, core, ws } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const peer = peerBaseUrl.replace(/\/+$/, '');

  // ① 握手（失败/非 2xx 直接抛，由调用方决定单败策略）
  const helloRes = await fetchImpl(`${peer}/api/sync/hello`);
  if (!helloRes.ok) throw new Error(`握手失败：HTTP ${helloRes.status}`);
  const hello = (await helloRes.json()) as SyncHandshake;

  // ② 同步组校验（同 workspaceId 才交换）与自拉防护
  if (hello.workspaceId !== workspaceId) {
    throw new Error(`同步组不一致：本地 ${workspaceId}，对端 ${hello.workspaceId}`);
  }
  const mine = core.sync.handshake(workspaceId);
  const result: SyncRoundResult = {
    peer,
    status: 'no-op',
    pulled: 0,
    accepted: 0,
    skipped: 0,
    replayed: false,
    plan: [],
    theirProfileVersion: hello.profileVersion,
    myProfileVersion: mine.profileVersion,
  };
  if (hello.nodeId === core.nodeId) {
    result.status = 'skipped-self';
    return result;
  }

  // ③ 计划：水位差 → 差额区间；水位持平但通道指纹不同 → 该 actor 全量区间
  //（computePullPlan 内建分歧检测，幂等摄入对重复事件全跳过）
  result.plan = computePullPlan(mine.watermarks, hello.watermarks);

  // ④ 逐区间分页拉取 + 幂等摄入（服务端默认 500/页）
  for (const range of result.plan) {
    let fromSeq = range.fromSeq;
    for (;;) {
      const res = await fetchImpl(
        `${peer}/api/sync/events/${encodeURIComponent(range.actor)}?fromSeq=${fromSeq}`,
      );
      if (!res.ok) throw new Error(`拉取失败（${range.actor}）：HTTP ${res.status}`);
      const page = (await res.json()) as {
        events: EventEnvelope[];
        nextFromSeq: number;
        hasMore: boolean;
      };
      if (page.events.length === 0) break;
      result.pulled += page.events.length;
      const { accepted, skipped } = core.sync.applyRemote(workspaceId, page.events);
      result.accepted += accepted;
      result.skipped += skipped;
      fromSeq = page.nextFromSeq;
      if (!page.hasMore) break;
    }
  }

  // ⑤ 摄入了新事件 → 全量重建两层投影（账本增量、投影全量的最保守实现）
  if (result.accepted > 0) {
    ws.replayAll();
    result.replayed = true;
    result.status = 'synced';
  }
  return result;
}
