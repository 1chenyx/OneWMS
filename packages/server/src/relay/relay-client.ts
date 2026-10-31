import {
  computePullPlan,
  sealEnvelope,
  unsealEnvelope,
  type PullRange,
  type SealedEvent,
  type SyncHandshake,
} from '@one/core';
import type { OneCore } from '@one/core';
import type { WmsWorkspace } from '@one/wms';

/**
 * 中继回合客户端（宿主层传输编排，DESIGN §8.5/§8.8，里程碑 7）。
 *
 * 一个回合 = 握手 → push（中继缺什么我推什么：seal 后上传）→
 * pull（我缺什么从中继拉什么：unseal 后幂等摄入）→ accepted>0 时 replayAll。
 * 与节点间 sync 回合同构（同一 computePullPlan、同一 applyRemote、同一重建路径），
 * 差别只有两点：对端是中继（密文暂存）而非节点、事件传输需 seal/unseal。
 *
 * 「中继是汇聚点」：节点把账本全部事件推上去（含从第三方拉来的）——
 * 新节点只从中继即可完成全量引导（迁移闭环的在线版）。
 */

/** 一轮中继回合结果（POST /api/relay/run 响应体） */
export interface RelayRoundResult {
  relay: string;
  /** 本轮推送到中继的事件数（密文） */
  pushed: number;
  pushAccepted: number;
  pushSkipped: number;
  pushConflicted: number;
  /** 本轮从中继拉取的事件数（密文） */
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
}

/** fetch 的最小形状（测试注入 app.request，零网络模拟三方拓扑） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function runRelayRound(params: {
  relayBaseUrl: string;
  workspaceId: string;
  core: OneCore;
  ws: WmsWorkspace;
  fetchImpl?: FetchLike;
}): Promise<RelayRoundResult> {
  const { relayBaseUrl, workspaceId, core, ws } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const relay = relayBaseUrl.replace(/\/+$/, '');

  // ⓪ 工作区密钥（seal/unseal 的先决条件；路由层已预检，此处兜底直调场景）
  const key = core.keys.get(workspaceId);
  if (!key) {
    throw new Error('未配置工作区密钥（先经 POST /api/keys 生成，或 POST /api/keys/import 导入）');
  }

  // ① 握手（中继按 workspaceId 返回该通道组的水位与指纹）
  const helloRes = await fetchImpl(`${relay}/relay/hello?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!helloRes.ok) throw new Error(`中继握手失败：HTTP ${helloRes.status}`);
  const hello = (await helloRes.json()) as SyncHandshake;
  if (hello.workspaceId !== workspaceId) {
    throw new Error(`同步组不一致：本地 ${workspaceId}，中继 ${hello.workspaceId}`);
  }

  const mine = core.sync.handshake(workspaceId);
  const result: RelayRoundResult = {
    relay,
    pushed: 0,
    pushAccepted: 0,
    pushSkipped: 0,
    pushConflicted: 0,
    pulled: 0,
    accepted: 0,
    skipped: 0,
    replayed: false,
    plan: [],
    theirProfileVersion: hello.profileVersion,
    myProfileVersion: mine.profileVersion,
  };

  // ② push：computePullPlan(中继水位, 本地水位)——中继缺什么我推什么
  //   （同一纯函数的反向应用：站在中继视角算「对端(我)有而我没有」的区间）
  const pushPlan = computePullPlan(hello.watermarks, mine.watermarks);
  for (const range of pushPlan) {
    let fromSeq = range.fromSeq;
    for (;;) {
      const page = core.sync.eventsFor(workspaceId, range.actor, fromSeq);
      if (page.events.length === 0) break;
      const sealedEvents = page.events.map((env) => sealEnvelope(env, key.keyHex));
      const res = await fetchImpl(`${relay}/relay/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          nodeId: core.nodeId,
          profileVersion: mine.profileVersion,
          sealedEvents,
        }),
      });
      if (!res.ok) throw new Error(`推送失败（${range.actor}）：HTTP ${res.status}`);
      const stats = (await res.json()) as { accepted: number; skipped: number; conflicted: number };
      result.pushed += sealedEvents.length;
      result.pushAccepted += stats.accepted;
      result.pushSkipped += stats.skipped;
      result.pushConflicted += stats.conflicted;
      fromSeq = page.nextFromSeq;
      if (!page.hasMore) break;
    }
  }

  // ③ pull：computePullPlan(本地水位, 中继水位)——与节点间同步完全相同。
  //   自己刚推上去的部分本地水位已领先，计划天然不含（无回环浪费）。
  result.plan = computePullPlan(mine.watermarks, hello.watermarks);
  for (const range of result.plan) {
    let fromSeq = range.fromSeq;
    for (;;) {
      const res = await fetchImpl(
        `${relay}/relay/events/${encodeURIComponent(range.actor)}?workspaceId=${encodeURIComponent(workspaceId)}&fromSeq=${fromSeq}`,
      );
      if (!res.ok) throw new Error(`拉取失败（${range.actor}）：HTTP ${res.status}`);
      const page = (await res.json()) as {
        events: SealedEvent[];
        nextFromSeq: number;
        hasMore: boolean;
      };
      if (page.events.length === 0) break;
      result.pulled += page.events.length;
      // unseal 在摄入前：密钥不符/密文被篡改 → CryptoError 整轮失败（绝不静默给错数据）
      const envelopes = page.events.map((s) => unsealEnvelope(s, key.keyHex));
      const { accepted, skipped } = core.sync.applyRemote(workspaceId, envelopes);
      result.accepted += accepted;
      result.skipped += skipped;
      fromSeq = page.nextFromSeq;
      if (!page.hasMore) break;
    }
  }

  // ④ 摄入了新事件 → 全量重建两层投影（与 M5 同一条保守路径）
  if (result.accepted > 0) {
    ws.replayAll();
    result.replayed = true;
  }
  return result;
}
