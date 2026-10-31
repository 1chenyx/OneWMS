import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { EventError } from '../errors.js';
import type { EventEnvelope, EventRow } from './envelope.js';
import { buildEnvelope, rowToEnvelope } from './envelope.js';

/**
 * 事件账本存取（OplogStore）—— 系统唯一真相（DESIGN.md §8）。
 *
 * 三个承诺：
 *  1. append-only：本类没有任何修改/删除事件的方法（§13.4 纪律 1）；
 *  2. 幂等摄入：ingest 对已存在的 eventId 静默跳过（同步重放安全，§8.4）；
 *  3. 全序确定：遍历顺序恒为 (lamport, actor)——并发裁决的唯一依据。
 *
 * 对 payload 透明：本类不解释事件内容，事件语义由投影方（如 FieldRegistry）负责。
 */
export class OplogStore {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 追加一条本地事件。seq 与 lamport 在同一事务内分配（乐观并发下无空洞、无重复）。
   */
  append(params: {
    workspaceId: string;
    actor: string;
    type: string;
    payload: unknown;
  }): EventEnvelope {
    const appendTx = this.db.transaction(() => {
      const { workspaceId, actor, type, payload } = params;

      const counter = this.db
        .prepare<unknown[], { last_seq: number; last_lamport: number }>(
          `SELECT last_seq, last_lamport FROM oplog_counters
           WHERE workspace_id = ? AND actor = ?`,
        )
        .get(workspaceId, actor);

      const seq = (counter?.last_seq ?? 0) + 1;
      // 本地事件的 lamport 取「当前视界 + 1」；视界随 ingest 远端事件推进
      const lamport = Math.max(counter?.last_lamport ?? 0, this.#maxLamport(workspaceId)) + 1;

      const envelope = buildEnvelope({ workspaceId, actor, seq, lamport, type, payload });

      this.db
        .prepare(
          `INSERT INTO oplog (event_id, workspace_id, actor, lamport, seq, type, payload, created_at)
           VALUES (@eventId, @workspaceId, @actor, @lamport, @seq, @type, @payload, @createdAt)`,
        )
        .run({
          eventId: envelope.eventId,
          workspaceId: envelope.workspaceId,
          actor: envelope.actor,
          lamport: envelope.lamport,
          seq: envelope.seq,
          type: envelope.type,
          payload: JSON.stringify(envelope.payload),
          createdAt: envelope.createdAt,
        });

      this.db.prepare(
        `INSERT INTO oplog_counters (workspace_id, actor, last_seq, last_lamport)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, actor)
         DO UPDATE SET last_seq = excluded.last_seq, last_lamport = excluded.last_lamport`,
      ).run(workspaceId, actor, seq, lamport);

      return envelope;
    });
    return appendTx();
  }

  /**
   * 摄入远端事件（同步/迁移入口，里程碑 5 使用；v1 单节点测试全序也依赖它）。
   * 幂等：eventId 已存在则跳过；同时推进本地 lamport 视界。
   */
  ingest(envelopes: EventEnvelope[]): { accepted: number; skipped: number } {
    const ingestTx = this.db.transaction(() => {
      let accepted = 0;
      let skipped = 0;
      for (const env of envelopes) {
        if (!env.eventId || !env.type?.includes('.') || typeof env.lamport !== 'number') {
          throw new EventError(`非法事件信封: ${JSON.stringify(env).slice(0, 200)}`);
        }
        const exists = this.db.prepare(`SELECT 1 FROM oplog WHERE event_id = ?`).get(env.eventId);
        if (exists) {
          skipped++;
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO oplog (event_id, workspace_id, actor, lamport, seq, type, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            env.eventId,
            env.workspaceId,
            env.actor,
            env.lamport,
            env.seq,
            env.type,
            JSON.stringify(env.payload ?? null),
            env.createdAt,
          );

        // 推进该 actor 的计数器（拉取续传的水位依据）
        this.db
          .prepare(
            `INSERT INTO oplog_counters (workspace_id, actor, last_seq, last_lamport)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (workspace_id, actor)
             DO UPDATE SET
               last_seq = MAX(last_seq, excluded.last_seq),
               last_lamport = MAX(last_lamport, excluded.last_lamport)`,
          )
          .run(env.workspaceId, env.actor, env.seq, env.lamport);

        accepted++;
      }
      return { accepted, skipped };
    });
    return ingestTx();
  }

  /**
   * 按全序 (lamport, actor) 遍历事件——重放器与同步交换的共同基础。
   * 返回 false 可提前终止。
   */
  forEachEvent(
    workspaceId: string,
    handler: (envelope: EventEnvelope) => boolean | void,
    opts?: { fromLamport?: number; limit?: number },
  ): void {
    const rows = this.db
      .prepare<unknown[], EventRow>(
        `SELECT * FROM oplog
         WHERE workspace_id = ? AND lamport > ?
         ORDER BY lamport ASC, actor ASC
         LIMIT ?`,
      )
      .all(workspaceId, opts?.fromLamport ?? -1, opts?.limit ?? -1);

    for (const row of rows) {
      if (handler(rowToEnvelope(row)) === false) break;
    }
  }

  /** 按 actor 分通道拉取（§8.5 步骤 ③：交换各自缺失的 seq 区间） */
  getEventsByActor(workspaceId: string, actor: string, fromSeq: number, limit = 500): EventEnvelope[] {
    const rows = this.db
      .prepare<unknown[], EventRow>(
        `SELECT * FROM oplog
         WHERE workspace_id = ? AND actor = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(workspaceId, actor, fromSeq, limit);
    return rows.map(rowToEnvelope);
  }

  /** 各 actor 的水位（握手交换用，§8.8 hello 消息的数据源） */
  watermarks(workspaceId: string): Record<string, { seq: number; lamport: number }> {
    const rows = this.db
      .prepare<unknown[], { actor: string; last_seq: number; last_lamport: number }>(
        `SELECT actor, last_seq, last_lamport FROM oplog_counters WHERE workspace_id = ?`,
      )
      .all(workspaceId);
    const result: Record<string, { seq: number; lamport: number }> = {};
    for (const r of rows) result[r.actor] = { seq: r.last_seq, lamport: r.last_lamport };
    return result;
  }

  /**
   * 各 actor 通道的内容指纹（eventId 集合的 sha256，握手 checksum 用）。
   * 捕获「水位持平但事件集不同」的分裂（如多节点各自以相同 actor 落账）——
   * eventId 全局唯一，集合差异必然显影；排序后折叠保证与摄入顺序无关。
   */
  actorChecksums(workspaceId: string): Record<string, string> {
    const rows = this.db
      .prepare<unknown[], { actor: string; event_id: string }>(
        `SELECT actor, event_id FROM oplog WHERE workspace_id = ? ORDER BY actor, event_id`,
      )
      .all(workspaceId);
    const result: Record<string, string> = {};
    let actor = '';
    let hash = createHash('sha256');
    for (const r of rows) {
      if (r.actor !== actor) {
        if (actor !== '') result[actor] = hash.digest('hex');
        actor = r.actor;
        hash = createHash('sha256');
      }
      hash.update(r.event_id);
    }
    if (actor !== '') result[actor] = hash.digest('hex');
    return result;
  }

  /** 事件计数（checksum / 兜底校验的输入之一，§8.5 步骤 ⑤） */
  count(workspaceId: string): number {
    const row = this.db
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM oplog WHERE workspace_id = ?`)
      .get(workspaceId);
    return row?.n ?? 0;
  }

  #maxLamport(workspaceId: string): number {
    const row = this.db
      .prepare<unknown[], { m: number }>(
        `SELECT MAX(lamport) AS m FROM oplog WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    return row?.m ?? 0;
  }
}
