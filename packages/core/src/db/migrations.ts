import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DataVersionError } from '../errors.js';

/**
 * 内核表结构（领域无关；领域表由领域模块通过字段注册表声明）。
 *
 * 设计映射：
 *  - oplog / oplog_counters —— DESIGN.md §8.1/§8.2 事件账本与双时钟；
 *  - field_registry / field_usage —— §7.1 全局字段注册表（owner/usedBy）；
 *  - profile_state —— §8.2 config.change 事件的投影（慢通道，里程碑 4）；
 *  - meta —— 节点身份等运行时元数据。
 */
export const SCHEMA_VERSION = 4;

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
