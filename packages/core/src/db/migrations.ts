import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DataVersionError } from '../errors.js';

/**
 * 内核表结构（领域无关；领域表由领域模块通过字段注册表声明）。
 *
 * 设计映射：
 *  - oplog / oplog_counters —— DESIGN.md §8.1/§8.2 事件账本与双时钟；
 *  - field_registry / field_usage —— §7.1 全局字段注册表（owner/usedBy）；
 *  - profile_state —— §8.2 config.change 事件的投影（慢通道，里程碑 4）；
 *  - dyn_records / dyn_index —— B.2 声明式模块的通用记录存储（单表 JSON + 独立索引表）；
 *  - tool_idempotency —— 写工具幂等键 → 首次结果缓存（调用层去重，非投影）；
 *  - meta —— 节点身份等运行时元数据。
 */
export const SCHEMA_VERSION = 6;

/**
 * 本代码还能打开的最低表结构版本（读旧写新的下界）。
 *
 * 现状所有建表都是 CREATE TABLE IF NOT EXISTS，v1..v3 的老库跑一遍即补齐，
 * 所以下界是 1。将来若某次变更真的无法从老结构前滚（改列语义、拆表），
 * 就把这个值提到「必须先经过的中间版本」，逼用户走升级链而不是硬开。
 */
export const MIN_SCHEMA_VERSION = 1;

export function migrate(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  // 降级拒绝：库比程序新时，表都在但语义已变——静默通过等于让旧代码写坏投影。
  if (current > SCHEMA_VERSION) {
    throw new DataVersionError(
      `此数据目录的表结构版本为 v${current}，当前程序最高只支持 v${SCHEMA_VERSION}——` +
        `说明它曾被更新版本的 OneWMS 打开过。请安装新版本程序；` +
        `若必须继续使用当前版本，请从升级前的备份恢复数据。`,
    );
  }
  // current === 0 是全新库（SQLite 出厂值），不参与下界校验——否则新装即砖。
  if (current !== 0 && current < MIN_SCHEMA_VERSION) {
    throw new DataVersionError(
      `此数据目录的表结构版本为 v${current}，过于陈旧（当前程序最低支持 v${MIN_SCHEMA_VERSION}）。` +
        `请先用中间版本升级，或从备份恢复。`,
    );
  }
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
      CREATE INDEX IF NOT EXISTS idx_oplog_time
        ON oplog (workspace_id, created_at);
    `);

    // ── v6：给事件盖上「写入时的应用版本」（排查用，见 EventEnvelope.appVersion）──
    //    老库 oplog 已存在，CREATE IF NOT EXISTS 不会补列 → 显式 guarded ALTER（幂等）
    const oplogCols = db.prepare(`PRAGMA table_info(oplog)`).all() as { name: string }[];
    if (!oplogCols.some((c) => c.name === 'app_version')) {
      db.exec(`ALTER TABLE oplog ADD COLUMN app_version TEXT`);
    }

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

    // ── Profile 配置投影（§5/§8.2：workflows/modules/roles 的真相是
    //    config.change 事件，本表只是投影；schema.entities 不在此表——
    //    字段部分实时聚合自 field_registry，不存第二份真相）──
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_state (
        workspace_id TEXT    NOT NULL PRIMARY KEY,
        version      INTEGER NOT NULL DEFAULT 0,
        workflows    TEXT    NOT NULL DEFAULT '{}',
        modules      TEXT    NOT NULL DEFAULT '{}',
        roles        TEXT    NOT NULL DEFAULT '{}'
      );
    `);

    // ── 声明式模块的通用记录存储（B.2）：单表 JSON + 独立索引表 ──
    // 可移植 SQL 纪律（§6）：不写 SQLite 方言——无生成列、无 JSON 取值函数，
    // Postgres 同样成立。dyn_records.data 存 JSON 文本（列类型 TEXT 两边通用）；
    // dyn_index 只为 manifest 声明 queryable:true 的字段落行，
    // (workspace_id, module_id, record_type, field_key, field_value) 是 B.3 过滤查询的索引。
    db.exec(`
      CREATE TABLE IF NOT EXISTS dyn_records (
        workspace_id TEXT    NOT NULL,
        module_id    TEXT    NOT NULL,
        record_type  TEXT    NOT NULL,
        record_id    TEXT    NOT NULL,
        data         TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, module_id, record_type, record_id)
      );
      CREATE TABLE IF NOT EXISTS dyn_index (
        workspace_id TEXT NOT NULL,
        module_id    TEXT NOT NULL,
        record_type  TEXT NOT NULL,
        record_id    TEXT NOT NULL,
        field_key    TEXT NOT NULL,
        field_value  TEXT NOT NULL,
        PRIMARY KEY (workspace_id, module_id, record_type, record_id, field_key)
      );
      CREATE INDEX IF NOT EXISTS idx_dyn_index_query
        ON dyn_index (workspace_id, module_id, record_type, field_key, field_value);
    `);

    // ── 写工具幂等（v6）：调用方带 idempotencyKey 时，同键二次提交直接回放首次结果，
    //    不再进 handler——UI 双击、AI 重试、网络重发都不会把同一笔业务落两遍账。
    //    不是事件表：只是调用层缓存，删了不影响任何投影（真相仍在 oplog）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_idempotency (
        workspace_id TEXT NOT NULL,
        tool_id      TEXT NOT NULL,
        idem_key     TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, tool_id, idem_key)
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
