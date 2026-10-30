import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 内核表结构（领域无关；领域表由领域模块通过字段注册表声明）。
 *
 * 设计映射：
 *  - oplog / oplog_counters —— DESIGN.md §8.1/§8.2 事件账本与双时钟；
 *  - field_registry / field_usage —— §7.1 全局字段注册表（owner/usedBy）；
 *  - meta —— 节点身份等运行时元数据。
 */
export const SCHEMA_VERSION = 1;

export function migrate(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  db.transaction(() => {
    // ── 事件账本（append-only，无任何 UPDATE/DELETE 路径）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS oplog (
        event_id      TEXT    NOT NULL PRIMARY KEY,
        workspace_id  TEXT    NOT NULL,
        actor         TEXT    NOT NULL,
        lamport       INTEGER NOT NULL,
        seq           INTEGER NOT NULL,
        type          TEXT    NOT NULL,
        payload       TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,
        UNIQUE (workspace_id, actor, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_oplog_total_order
        ON oplog (workspace_id, lamport, actor);
      CREATE INDEX IF NOT EXISTS idx_oplog_type
        ON oplog (workspace_id, type);
    `);

    // ── 双时钟水位（事务内 UPSERT 递增，见 OplogStore）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS oplog_counters (
        workspace_id TEXT    NOT NULL,
        actor        TEXT    NOT NULL,
        last_seq     INTEGER NOT NULL DEFAULT 0,
        last_lamport INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, actor)
      );
    `);

    // ── 字段注册表（§7.1：字段属于实体，owner/usedBy 双层关系）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS field_registry (
        workspace_id TEXT NOT NULL,
        entity       TEXT NOT NULL,
        field_key    TEXT NOT NULL,
        label        TEXT NOT NULL,
        data_type    TEXT NOT NULL,
        visible      INTEGER NOT NULL DEFAULT 1,
        sharing      TEXT NOT NULL DEFAULT 'private',
        owner        TEXT NOT NULL,
        description  TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, entity, field_key)
      );
      CREATE TABLE IF NOT EXISTS field_usage (
        workspace_id TEXT NOT NULL,
        entity       TEXT NOT NULL,
        field_key    TEXT NOT NULL,
        used_by      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, entity, field_key, used_by)
      );
    `);

    // ── 运行时元数据（node id 等）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
