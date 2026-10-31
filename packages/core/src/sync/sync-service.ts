import { EventError } from '../errors.js';
import type { EventEnvelope } from '../oplog/envelope.js';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { ProfileService } from '../profile/profile-service.js';
import type { SyncHandshake, Watermarks } from './sync-protocol.js';

/**
 * 节点间同步编排（进程级服务，方法带 workspaceId，里程碑 5）。
 *
 * 职责边界（ARCHITECTURE.md「同步回合」）：
 *  - 账本交换是增量的：水位握手 + 按 actor 区间供事件 + 幂等摄入；
 *  - 投影更新是全量的：摄入后由宿主调门面 replay——本服务不碰投影；
 *  - 不做网络 IO：传输在宿主层（@one/server 的 sync-client）；
 *  - 不裁决业务冲突：账本层无冲突（append-only + 全序，DESIGN §8.3）。
 *
 * 依赖登记：→ oplog-store（账本交换通道）、→ profile-service（仅 getVersion 握手位）。
 */
export class SyncService {
  /** 默认分页大小（对齐 OplogStore.getEventsByActor 的缺省值） */
  static readonly PAGE_SIZE = 500;

  constructor(
    readonly nodeId: string,
    private readonly oplog: OplogStore,
    private readonly profile: ProfileService,
  ) {}

  /** 握手载荷：nodeId / 版本 / 水位（含通道指纹）/ 计数（GET /api/sync/hello 的数据源） */
  handshake(workspaceId: string): SyncHandshake {
    const marks = this.oplog.watermarks(workspaceId);
    const checksums = this.oplog.actorChecksums(workspaceId);
    const watermarks: Watermarks = {};
    for (const [actor, mark] of Object.entries(marks)) {
      watermarks[actor] = { ...mark, checksum: checksums[actor] };
    }
    return {
      nodeId: this.nodeId,
      workspaceId,
      profileVersion: this.profile.getVersion(workspaceId),
      watermarks,
      eventCount: this.oplog.count(workspaceId),
    };
  }

  /** 按 actor 区间供事件 + 分页游标（GET /api/sync/events/:actor 的数据源） */
  eventsFor(
    workspaceId: string,
    actor: string,
    fromSeq: number,
    limit: number = SyncService.PAGE_SIZE,
  ): { actor: string; events: EventEnvelope[]; nextFromSeq: number; hasMore: boolean } {
    // 协议约定 fromSeq 是闭区间起点（首条要拉的 seq，来自水位+1）；
    // 底层 SQL 是排他下界（seq > x），此处做一次语义转换
    const events = this.oplog.getEventsByActor(workspaceId, actor, fromSeq - 1, limit);
    const last = events.at(-1);
    return {
      actor,
      events,
      // 下一页的闭区间起点（续传直接作下一页 fromSeq，不重不漏）
      nextFromSeq: last ? last.seq + 1 : fromSeq,
      hasMore: events.length === limit,
    };
  }

  /**
   * 幂等摄入远端事件（eventId 查重 + 计数器 MAX 推进，OplogStore.ingest 的承诺）。
   * 先校验信封 workspaceId 与目标一致——跨工作区事件是协议违约，整体失败不落账。
   */
  applyRemote(
    workspaceId: string,
    envelopes: EventEnvelope[],
  ): { accepted: number; skipped: number } {
    for (const env of envelopes) {
      if (env.workspaceId !== workspaceId) {
        throw new EventError(`拒绝跨工作区事件：期望 ${workspaceId}，实际 ${env.workspaceId}`);
      }
    }
    return this.oplog.ingest(envelopes);
  }
}
