import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  MEMORY_EVENT_TYPES,
  type MemoryItemForgottenPayload,
  type MemoryItemSavedPayload,
  type MemoryScope,
  type MemorySource,
} from '../events/catalog.js';

/**
 * 记忆投影（MemoryView）——memory_item 表的事件投影 + 查询。
 *
 * 纪律（与 wms 各投影一致，DESIGN.md §8「事件是唯一真相」）：
 *  - applyEvent 是本表唯一写路径，幂等（saved 按 memoryId upsert /
 *    forgotten 按主键 DELETE，重复应用是空操作）；
 *  - 同 memoryId 再存 = 更新（内容修正的天然实现），created_at 保留首存时间。
 */

export interface MemoryRecord {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly source: MemorySource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    content: row.content,
    source: row.source as MemorySource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 记忆行序：最近更新在前（注入 System Prompt 截断时保留最新） */
const ORDER_BY = ' ORDER BY updated_at DESC, id DESC';

export class MemoryView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 memory.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case MEMORY_EVENT_TYPES.itemSaved: {
        const p = env.payload as MemoryItemSavedPayload;
        // upsert：同 memoryId 重放幂等；再次保存（修正）覆盖内容并推 updated_at
        this.db
          .prepare(
            `INSERT INTO memory_item (id, workspace_id, scope, content, source, user_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               scope = excluded.scope,
               content = excluded.content,
               source = excluded.source,
               updated_at = excluded.updated_at`,
          )
          .run(p.memoryId, this.workspaceId, p.scope, p.content, p.source, env.createdAt, env.createdAt);
        break;
      }
      case MEMORY_EVENT_TYPES.itemForgotten: {
        const p = env.payload as MemoryItemForgottenPayload;
        this.db.prepare('DELETE FROM memory_item WHERE id = ?').run(p.memoryId);
        break;
      }
    }
  }

  /** 清空本工作区全部记忆行（全量重放的前置动作） */
  clear(): void {
    this.db.prepare('DELETE FROM memory_item WHERE workspace_id = ?').run(this.workspaceId);
  }

  /** 记忆清单（最近更新在前）；scope 可选过滤 */
  list(scope?: MemoryScope): MemoryRecord[] {
    const rows = scope
      ? this.#all<MemoryRow & { scope: string }>(
          'SELECT id, scope, content, source, created_at, updated_at FROM memory_item WHERE workspace_id = ? AND scope = ?' +
            ORDER_BY,
          this.workspaceId,
          scope,
        )
      : this.#all<MemoryRow>(
          'SELECT id, scope, content, source, created_at, updated_at FROM memory_item WHERE workspace_id = ?' +
            ORDER_BY,
          this.workspaceId,
        );
    return rows.map(rowToRecord);
  }

  byId(id: string): MemoryRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, scope, content, source, created_at, updated_at FROM memory_item WHERE workspace_id = ? AND id = ?',
      )
      .get(this.workspaceId, id) as MemoryRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** 当前记忆总量（上限护栏的判据） */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_item WHERE workspace_id = ?')
      .get(this.workspaceId) as { n: number };
    return row.n;
  }

  #all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
}
