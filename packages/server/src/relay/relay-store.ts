import { createHash } from 'node:crypto';
import type { SealedEvent, SyncHandshake } from '@one/core';

/**
 * 中继内存存储（RelayStore，里程碑 7）。
 *
 * 「中继极薄 + E2E 加密下中继无需被信任」（DESIGN §8.8）的 v1 落地：
 *  - 只存密文（SealedEvent）与明文信封元数据——**存储中永远没有明文 payload**；
 *  - 进程内存态、零持久化：重启即清，节点下轮按水位差额自动重推全量（自愈）；
 *  - actor 通道节点唯一防线的延伸：同 (actor,seq) 异 eventId → 冲突拒收。
 *
 * 测试可直接持有实例观察内容（「无明文」断言）；生产由 relay-app 独占。
 */

/** 单工作区状态：各 actor 通道（seq → 密文）+ 最新上报版本 + 在线目录 */
interface WorkspaceState {
  readonly actors: Map<string, Map<number, SealedEvent>>;
  profileVersion: number;
  readonly nodes: Map<string, number>;
}

export class RelayStore {
  readonly #workspaces = new Map<string, WorkspaceState>();

  #ws(workspaceId: string): WorkspaceState {
    let ws = this.#workspaces.get(workspaceId);
    if (!ws) {
      ws = { actors: new Map(), profileVersion: 0, nodes: new Map() };
      this.#workspaces.set(workspaceId, ws);
    }
    return ws;
  }

  /**
   * 暂存一批密文事件（幂等）：同 (actor,seq) 同 eventId → skipped；
   * 异 eventId → conflicted（actor 通道节点唯一——两节点以同 actor 落账的撞账）。
   * 顺带刷新在线目录与最新上报的 profileVersion。
   */
  push(
    workspaceId: string,
    nodeId: string,
    profileVersion: number,
    sealed: SealedEvent[],
  ): { accepted: number; skipped: number; conflicted: number } {
    const ws = this.#ws(workspaceId);
    let accepted = 0;
    let skipped = 0;
    let conflicted = 0;
    for (const s of sealed) {
      // 跨工作区密文是协议违约：信封明文字段自带边界，整体拒收
      if (s.workspaceId !== workspaceId) {
        throw new Error(`拒收跨工作区密文（期望 ${workspaceId}，实际 ${s.workspaceId}）`);
      }
      let channel = ws.actors.get(s.actor);
      if (!channel) {
        channel = new Map();
        ws.actors.set(s.actor, channel);
      }
      const existing = channel.get(s.seq);
      if (existing) {
        if (existing.eventId === s.eventId) {
          skipped++;
        } else {
          conflicted++;
        }
        continue;
      }
      channel.set(s.seq, s);
      accepted++;
    }
    // 版本取 max（中继不解释配置内容，仅透传握手比较位）
    if (profileVersion > ws.profileVersion) ws.profileVersion = profileVersion;
    ws.nodes.set(nodeId, Date.now());
    return { accepted, skipped, conflicted };
  }

  /** 握手载荷（与节点 /api/sync/hello 同形）：水位 + 通道指纹（eventId 明文可算） */
  hello(workspaceId: string, relayNodeId: string): SyncHandshake {
    const ws = this.#workspaces.get(workspaceId);
    if (!ws) {
      return { nodeId: relayNodeId, workspaceId, profileVersion: 0, watermarks: {}, eventCount: 0 };
    }
    const watermarks: SyncHandshake['watermarks'] = {};
    let eventCount = 0;
    for (const [actor, channel] of ws.actors) {
      const ids = [...channel.values()].map((s) => s.eventId).sort();
      const hash = createHash('sha256');
      for (const id of ids) hash.update(id);
      let seq = 0;
      let lamport = 0;
      for (const s of channel.values()) {
        if (s.seq > seq) seq = s.seq;
        if (s.lamport > lamport) lamport = s.lamport;
        eventCount++;
      }
      watermarks[actor] = { seq, lamport, checksum: hash.digest('hex') };
    }
    return {
      nodeId: relayNodeId,
      workspaceId,
      profileVersion: ws.profileVersion,
      watermarks,
      eventCount,
    };
  }

  /** 按 actor 区间供密文事件（分页契约与节点 sync 端点同形：fromSeq 闭起点） */
  eventsFor(
    workspaceId: string,
    actor: string,
    fromSeq: number,
    limit: number,
  ): { actor: string; events: SealedEvent[]; nextFromSeq: number; hasMore: boolean } {
    const channel = this.#workspaces.get(workspaceId)?.actors.get(actor);
    const sorted = channel
      ? [...channel.values()].sort((a, b) => a.seq - b.seq).filter((s) => s.seq >= fromSeq)
      : [];
    const events = sorted.slice(0, limit);
    const last = events.at(-1);
    return {
      actor,
      events,
      nextFromSeq: last ? last.seq + 1 : fromSeq,
      hasMore: sorted.length > events.length,
    };
  }

  /** 在线目录（push 顺带心跳刷新；管理展示用） */
  directory(workspaceId: string): { nodeId: string; lastSeen: string }[] {
    const ws = this.#workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.nodes.entries()]
      .map(([nodeId, seen]) => ({ nodeId, lastSeen: new Date(seen).toISOString() }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }
}
