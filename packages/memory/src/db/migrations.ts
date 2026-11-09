import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 记忆领域表结构（@one/memory 私有表，memory_ 前缀，与内核表同居一库）。
 *
 * 铁律（DESIGN.md §13.4，与 wms 领域一致）：
 *  - 主键一律 uuid（事件携带的 sectionId），禁用自增 int；
 *  - 带 workspace_id（隔离第一参数）；
 *  - 本表是 oplog 的缓存投影，唯一写路径是 MemorySectionView.applyEvent。
 *
 * v2 结构升级（章节账本）：memory_item 整组 DROP——投影可丢、事件是唯一真相，
 * 老库的 memory.item.* 事件由 applyEvent 投影进 legacy-* 章节（人审后归并）。
 * 自然键 (workspace_id, scope, section_key) 是唯一约束：同一章节多次写入 = 覆盖。
 */
export function migrateMemory(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS memory_item;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_section (
        id           TEXT    NOT NULL PRIMARY KEY,
        workspace_id TEXT    NOT NULL,
        scope        TEXT    NOT NULL,
        section_key  TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        body_md      TEXT    NOT NULL,
        summary      TEXT    NOT NULL,
        keywords     TEXT    NOT NULL,
        base_lamport INTEGER NOT NULL,
        last_actor   TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_section_key
        ON memory_section (workspace_id, scope, section_key);
    `);
  })();
}
