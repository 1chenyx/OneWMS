/**
 * 同步协议纯函数层（DESIGN.md §8.5 五步协议的 v1 落地，里程碑 5）。
 *
 * 协议是拉模型回合：握手（交换水位）→ 计算拉取计划 → 按区间分页拉取 →
 * 幂等摄入。本文件只含类型与「双方水位差 → 拉取区间清单」的纯函数——
 * 网络传输在宿主层（@one/server 的 sync-client），账本操作在服务层（SyncService）。
 */

/** 单 actor 的账本水位：该 actor 已见的最高 seq / lamport + 通道内容指纹 */
export interface ActorWatermark {
  seq: number;
  lamport: number;
  /** 该通道 eventId 集合的 sha256（握手组装）——水位持平时的内容分歧检测位 */
  checksum?: string;
}

/** 握手交换的水位表：actor → 水位（GET /api/sync/hello 的载荷字段） */
export type Watermarks = Record<string, ActorWatermark>;

/** 握手载荷（hello 消息，DESIGN §8.5 步骤 ①） */
export interface SyncHandshake {
  /** 对端节点身份（自拉防护：nodeId 相同则跳过） */
  nodeId: string;
  /** 工作区边界（同步组 = 同 workspaceId，不一致拒绝交换） */
  workspaceId: string;
  /** config 版本链当前值（握手比较位，§8.5 ②） */
  profileVersion: number;
  watermarks: Watermarks;
  /** 事件总数（checksum 兜底校验的输入之一，§8.5 ⑤） */
  eventCount: number;
}

/** 一个拉取区间：对端有而我没有的事件（客户端视角，闭区间 [fromSeq, toSeq]） */
export interface PullRange {
  actor: string;
  fromSeq: number;
  toSeq: number;
}

/**
 * 计算拉取计划（客户端视角）：
 *  - 对端 actor 水位高于本地 → 差额区间 [本地水位+1, 对端水位]；
 *  - 水位持平但通道指纹不同（多节点各自以相同 actor 落账的分裂）→ 全量区间
 *    [1, 对端水位]，幂等摄入自然去重（重复事件全跳过）。
 * 确定性：区间按 actor 字典序输出（同一水位输入恒得同一计划）。
 */
export function computePullPlan(mine: Watermarks, theirs: Watermarks): PullRange[] {
  const plan: PullRange[] = [];
  for (const actor of Object.keys(theirs).sort()) {
    const their = theirs[actor]!;
    const my = mine[actor];
    const mySeq = my?.seq ?? 0;
    if (their.seq > mySeq) {
      plan.push({ actor, fromSeq: mySeq + 1, toSeq: their.seq });
    } else if (their.seq === mySeq && my?.checksum !== undefined && their.checksum !== undefined && my.checksum !== their.checksum) {
      plan.push({ actor, fromSeq: 1, toSeq: their.seq });
    }
  }
  return plan;
}
