import type { EventEnvelope } from '../oplog/envelope.js';
import type { OplogStore } from '../oplog/oplog-store.js';

/**
 * 账本的工作区绑定视图（EventsView）。
 *
 * 存在理由：服务层方法第一参数恒为 workspaceId（§13.5 口子 2），
 * View 在构造期绑定后，调用方不再传——纪律由类型系统代管。
 * 只做参数绑定与委托，不含任何业务逻辑。
 */
export class EventsView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly oplog: OplogStore,
  ) {}

  /** 追加本地事件；actor 默认为本节点 */
  append(type: string, payload: unknown, actor = this.nodeId): EventEnvelope {
    return this.oplog.append({ workspaceId: this.workspaceId, actor, type, payload });
  }

  /** 摄入远端事件（幂等，同步/迁移入口） */
  ingest(envelopes: EventEnvelope[]): { accepted: number; skipped: number } {
    return this.oplog.ingest(envelopes);
  }

  /** 按全序 (lamport, actor) 遍历；handler 返回 false 提前终止 */
  forEach(
    handler: (envelope: EventEnvelope) => boolean | void,
    opts?: { fromLamport?: number; limit?: number },
  ): void {
    this.oplog.forEachEvent(this.workspaceId, handler, opts);
  }

  /** 按 actor 分通道拉取（同步交换用） */
  byActor(actor: string, fromSeq: number, limit = 500): EventEnvelope[] {
    return this.oplog.getEventsByActor(this.workspaceId, actor, fromSeq, limit);
  }

  /** 各 actor 水位（握手数据源） */
  watermarks(): Record<string, { seq: number; lamport: number }> {
    return this.oplog.watermarks(this.workspaceId);
  }

  /** 事件计数（checksum 兜底校验输入） */
  count(): number {
    return this.oplog.count(this.workspaceId);
  }
}
