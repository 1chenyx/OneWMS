import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 记忆领域表结构（@one/memory 私有表，memory_ 前缀，与内核表同居一库）。
 *
 * 铁律（DESIGN.md §13.4，与 wms 领域一致）：
 *  - 主键一律 uuid（事件携带的 memoryId），禁用自增 int；
 *  - 带 workspace_id（隔离第一参数）；
 *  - 本表是 oplog 的缓存投影，唯一写路径是 MemoryView.applyEvent
 *    （重放 memory.item.saved / memory.item.forgotten）。
 *
 * user_key 列是 v2 多用户预留口子（权限机制 v1 不实现），v1 恒 NULL。
 * 建表幂等（IF NOT EXISTS）；将来结构升级时按 wms 迁移的整组 DROP 重建
 * 模式补检测（投影可丢，事件是唯一真相）。
 */
export function migrateMemory(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_item (
        id           TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope        TEXT NOT NULL,
        content      TEXT NOT NULL,
        source       TEXT NOT NULL,
        user_key     TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_item_ws
        ON memory_item (workspace_id, scope);
    `);
  })();
}
