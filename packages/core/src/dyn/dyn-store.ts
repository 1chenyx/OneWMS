import { randomUUID } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { EventEnvelope } from '../oplog/envelope.js';
import {
  DynRecordConflictError,
  DynRecordNotFoundError,
  DynRecordValidationError,
  EventError,
} from '../errors.js';
import { clearProjectionTables, type ProjectionTable } from '../projection/projection-group.js';
import { ensureProjectionVersion } from '../projection/projection-version.js';
import { DYN_RECORD_PREFIX, type ManifestRecord, type ManifestRecordField } from '../modules/manifest-types.js';

/**
 * 声明式模块的通用记录存储（B.2）——「引擎写代码、定制写数据」的存储地基。
 *
 * 一个声明式实体没有建表语句，全部字段存进 dyn_records.data（JSON 文本）；
 * manifest 声明 queryable:true 的字段额外在 dyn_index 落索引行，供 B.3 端点过滤。
 * 之所以是独立索引表而不是生成列：本层必须用可移植 SQL（§6——③ 平台版直接复用），
 * 而 SQLite 与 Postgres 的生成列语法、JSON 取值函数、列类型互不相通。
 *
 * 事件模型（真相在 oplog，本表只是投影）：
 *  - record.created / record.updated 携带全量 data（整替，不做 JSON patch——重放无须基准）
 *    与**目标 version**（写路径按当前行算好写进载荷——重放确定性靠它，见 applyEvent）；
 *  - record.deleted 只带定位三键；
 *  - 幂等摄入下的并发裁决是全序 LWW（后到者胜），确定性由 (lamport, actor) 全序保证。
 *
 * 版本管理：复用 B.0 的 per-group 机制，组名 = `dyn.{moduleId}`（见 dynGroupName）。
 * dyn_records / dyn_index 物理上各一张表，逻辑上按 module_id 切片（ProjectionTable.scope），
 * 某个模块 bump 版本或重装换 schema 只重建自己那几行，不牵连其他模块。
 */

/** 全部 dyn 投影组共享的派生规则版本。改了本文件任何投影语义就 +1，各组下次启动自动重建 */
export const DYN_PROJECTION_VERSION = 1;

export const RECORD_CREATED_EVENT = 'record.created';
export const RECORD_UPDATED_EVENT = 'record.updated';
export const RECORD_DELETED_EVENT = 'record.deleted';

const DYN_EVENT_TYPES = new Set([RECORD_CREATED_EVENT, RECORD_UPDATED_EVENT, RECORD_DELETED_EVENT]);

/** 判断是否是 B.2 记录事件（重放/追账的分发守卫） */
export function isDynRecordEvent(type: string): boolean {
  return DYN_EVENT_TYPES.has(type);
}

/** 模块的记录投影组名（也是 ensureProjectionVersion 的组维度与 meta key 组成部分） */
export function dynGroupName(moduleId: string): string {
  return `dyn.${moduleId}`;
}

/** 单条已存记录（dyn_records 一行的领域形态） */
export interface DynStoredRecord {
  recordId: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DynListOptions {
  limit?: number;
  offset?: number;
  /** 等值过滤：只允许作用在 manifest 声明 queryable:true 的字段上（B.3 白名单同源） */
  filter?: { field: string; equals: unknown };
  /** 排序：白名单同 filter（非 queryable 字段没有索引行，排不了）。缺省按 record_id 升序 */
  sort?: { field: string; dir?: 'asc' | 'desc' };
}

/**
 * 已安装模块声明的一个声明式实体（schema 来源）。
 * 由 ModuleRegistry.installedDynRecords 提供——「生效 manifest 全集 ∩ 已安装」，
 * DynStore 经此闭包取 schema，不直接依赖 ModuleRegistry（依赖经 Port/闭包反转，避免环）。
 */
export interface DynRecordSchema {
  moduleId: string;
  record: ManifestRecord;
}

/** ModuleRegistry → DynStore 的回调面（安装成功后的整组重投影）。用接口反转，注册表不持有存储实现 */
export interface DynProjectionPort {
  reprojectModule(workspaceId: string, moduleId: string): void;
}

/**
 * 索引值的规范字符串形态。string 原样；其余类型 JSON 序列化
 * （number→"1.5"、boolean→"true"、json→紧凑串）。
 * ⚠️ TEXT 字典序对 number 范围查询不可靠（"10" < "9"），B.3 做范围过滤时需回表取 data
 * 再按类型比较，等值过滤则直接用本形态比对。
 */
export function canonicalFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const s = JSON.stringify(value);
  if (s === undefined) {
    throw new DynRecordValidationError(`索引字段的值不能是 undefined（应省略该字段而不是传 undefined）`);
  }
  return s;
}

/** 记录行 id：字母数字开头，允许字母/数字/_/-，≤64 位（自动生成的形如 r-a1b2c3d4） */
const ROW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface RecordRow {
  record_id: string;
  data: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export class DynStore implements DynProjectionPort {
  /**
   * 追账游标（workspaceId → 已应用的最后 lamport）。进程内状态：重启后归 -1，
   * 首次 sync 会全量重放 record.* 事件——applyEvent 幂等（先删后插/UPSERT），
   * 慢一点但不错账；同时也自愈「append 已提交、投影未应用」的崩溃窗口。
   */
  readonly #cursors = new Map<string, number>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly oplog: OplogStore,
    private readonly nodeId: string,
    private readonly records: (workspaceId: string) => DynRecordSchema[],
  ) {}

  // ── 写路径（校验 → 落事件 → 立即应用投影；与 FieldRegistry 同一纪律）────

  /** 创建记录。recordId 缺省自动生成。返回 recordId 与初始版本 */
  create(
    workspaceId: string,
    recordType: string,
    recordId: string | undefined,
    data: unknown,
    opts?: { actor?: string },
  ): { recordId: string; version: number } {
    const schema = this.#resolveSchema(workspaceId, recordType);
    const id = recordId ?? `r-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    assertRowId(id);
    const clean = validateRecordData(schema.record, data);
    if (this.#row(workspaceId, schema.moduleId, recordType, id)) {
      throw new DynRecordConflictError(`记录 ${recordType}/${id} 已存在，不能重复创建`);
    }
    const env = this.oplog.append({
      workspaceId,
      actor: opts?.actor ?? this.nodeId,
      type: RECORD_CREATED_EVENT,
      payload: { moduleId: schema.moduleId, recordType, recordId: id, data: clean, version: 1 },
    });
    this.applyEvent(env);
    return { recordId: id, version: 1 };
  }

  /** 整替更新（乐观并发：调用方携带读取时的 version，过期拒绝） */
  update(
    workspaceId: string,
    recordType: string,
    recordId: string,
    data: unknown,
    expectedVersion: number,
    opts?: { actor?: string },
  ): { version: number } {
    const schema = this.#resolveSchema(workspaceId, recordType);
    const clean = validateRecordData(schema.record, data);
    const row = this.#requireRow(workspaceId, schema.moduleId, recordType, recordId);
    if (row.version !== expectedVersion) {
      throw new DynRecordConflictError(
        `记录 ${recordType}/${recordId} 版本冲突：当前 version ${row.version}，请求携带 ${expectedVersion}`,
      );
    }
    const env = this.oplog.append({
      workspaceId,
      actor: opts?.actor ?? this.nodeId,
      type: RECORD_UPDATED_EVENT,
      payload: { moduleId: schema.moduleId, recordType, recordId, data: clean, version: row.version + 1 },
    });
    this.applyEvent(env);
    return { version: row.version + 1 };
  }

  /** 删除记录（数据行 + 索引行一起消失；oplog 里的事件永久保留，重装重放仍可恢复） */
  delete(
    workspaceId: string,
    recordType: string,
    recordId: string,
    expectedVersion: number,
    opts?: { actor?: string },
  ): void {
    const schema = this.#resolveSchema(workspaceId, recordType);
    const row = this.#requireRow(workspaceId, schema.moduleId, recordType, recordId);
    if (row.version !== expectedVersion) {
      throw new DynRecordConflictError(
        `记录 ${recordType}/${recordId} 版本冲突：当前 version ${row.version}，请求携带 ${expectedVersion}`,
      );
    }
    const env = this.oplog.append({
      workspaceId,
      actor: opts?.actor ?? this.nodeId,
      type: RECORD_DELETED_EVENT,
      payload: { moduleId: schema.moduleId, recordType, recordId },
    });
    this.applyEvent(env);
  }

  // ── 读路径（B.3 端点 / B.4 工具 / 测试共用）────────────────

  get(workspaceId: string, recordType: string, recordId: string): DynStoredRecord | undefined {
    const schema = this.#resolveSchema(workspaceId, recordType);
    const row = this.#row(workspaceId, schema.moduleId, recordType, recordId);
    return row ?? undefined;
  }

  /**
   * 列表：过滤与排序都只认 manifest 声明 queryable:true 的字段（B.3 白名单同源）。
   * 过滤下推到 dyn_index 索引行；无过滤无排序时直查 dyn_records。
   */
  list(
    workspaceId: string,
    recordType: string,
    opts: DynListOptions = {},
  ): { rows: DynStoredRecord[]; total: number } {
    const schema = this.#resolveSchema(workspaceId, recordType);
    const { moduleId } = schema;
    const limit = clampLimit(opts.limit ?? LIST_LIMIT_DEFAULT);
    const offset = assertOffset(opts.offset ?? 0);

    const where = ['r.workspace_id = ?', 'r.module_id = ?', 'r.record_type = ?'];
    const whereArgs: unknown[] = [workspaceId, moduleId, recordType];
    const joins: string[] = [];
    const joinArgs: unknown[] = [];
    let orderBy = 'r.record_id';

    // 过滤用 INNER JOIN：索引行缺失（字段没值）本来就不该被等值条件命中
    if (opts.filter) {
      const field = requireQueryable(schema.record, opts.filter.field, '过滤');
      joins.push(indexJoin('f', 'JOIN'));
      joinArgs.push(field.key);
      where.push('f.field_value = ?');
      whereArgs.push(canonicalFieldValue(opts.filter.equals));
    }

    /**
     * 排序用 LEFT JOIN：排序字段是可选列，没有该字段的记录不能被 JOIN 悄悄丢掉。
     * 缺失值统一排最后——两库对 NULL 的默认排序方向相反（SQLite ASC 在前、
     * Postgres ASC 在后），显式写 CASE 才有跨库确定的顺序。
     */
    if (opts.sort) {
      const field = requireQueryable(schema.record, opts.sort.field, '排序');
      const dir = opts.sort.dir === 'desc' ? 'DESC' : 'ASC';
      joins.push(indexJoin('s', 'LEFT JOIN'));
      joinArgs.push(field.key);
      // ⚠️ number 列必须转数值再比：索引值是 TEXT 规范形态，字典序下 "10" < "9"
      //    （§B.2 的范围过滤同源坑）。CAST(x AS REAL) 在 SQLite / Postgres 都成立，不引方言。
      const expr = field.type === 'number' ? 'CAST(s.field_value AS REAL)' : 's.field_value';
      orderBy = `CASE WHEN s.field_value IS NULL THEN 1 ELSE 0 END, ${expr} ${dir}, r.record_id`;
    }

    const from = `FROM dyn_records r ${joins.join(' ')}`.trimEnd();
    const whereSql = where.join(' AND ');
    // 参数顺序跟 SQL 文本一致：join 的 ON 条件在 WHERE 之前
    const args = [...joinArgs, ...whereArgs];

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${whereSql}`).get(...args) as { n: number }
    ).n;
    const rows = (
      this.db
        .prepare<unknown[], RecordRow>(
          `SELECT r.record_id, r.data, r.version, r.created_at, r.updated_at
           ${from}
           WHERE ${whereSql}
           ORDER BY ${orderBy}
           LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset)
    ).map(toStored);
    return { rows, total };
  }

  // ── 投影（applyEvent 是 dyn_records/dyn_index 的唯一写路径）────────

  /**
   * 应用一条事件（本表唯一写路径；命令路径、追账、重放共用）。
   * 与事件类型无关的事件零成本早退——重放时逐条喂全部事件是安全的。
   *
   * 幂等规则（重放/重复摄入安全）：
   *  - version 是**事件载荷的一部分**（写路径按当前行算好带上），不是投影时推导——
   *    同一组事件无论重放几次，落出来的行都一样。若用 `version = version + 1`，
   *    重开库的构造期追账会把 version 顶到 2，乐观并发当场失真；
   *  - created/updated 用同一条 UPSERT：不存在则插入，在场则整替 data/updated_at/version
   *    （created_at 永远保留首次建档时间）；
   *  - created 撞已有行（并发双创建）按全序 LWW 覆盖——后到者的 version 胜出，确定性由全序保证；
   *  - deleted 对不存在的行是 no-op；
   *  - 索引行先删后插，与 data 严格同步。
   */
  applyEvent(env: EventEnvelope): void {
    if (!isDynRecordEvent(env.type)) return;
    const p = env.payload as {
      moduleId?: unknown;
      recordType?: unknown;
      recordId?: unknown;
      data?: unknown;
      version?: unknown;
    };
    const { moduleId, recordType, recordId } = assertPayloadShape(env, p);
    this.#advanceCursor(env.workspaceId, env.lamport);

    if (env.type === RECORD_DELETED_EVENT) {
      this.db
        .prepare(
          `DELETE FROM dyn_index
           WHERE workspace_id = ? AND module_id = ? AND record_type = ? AND record_id = ?`,
        )
        .run(env.workspaceId, moduleId, recordType, recordId);
      this.db
        .prepare(
          `DELETE FROM dyn_records
           WHERE workspace_id = ? AND module_id = ? AND record_type = ? AND record_id = ?`,
        )
        .run(env.workspaceId, moduleId, recordType, recordId);
      return;
    }

    if (typeof p.data !== 'object' || p.data === null || Array.isArray(p.data)) {
      throw new EventError(`事件 ${env.eventId} 的 data 载荷必须是对象`);
    }
    if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) {
      throw new EventError(`事件 ${env.eventId} 的 version 载荷必须是正整数`);
    }
    const data = p.data as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT INTO dyn_records
           (workspace_id, module_id, record_type, record_id, data, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, module_id, record_type, record_id)
         DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at,
           version = excluded.version`,
      )
      .run(
        env.workspaceId,
        moduleId,
        recordType,
        recordId,
        JSON.stringify(data),
        env.createdAt,
        env.createdAt,
        p.version,
      );

    // 索引重建：先删后插。manifest 不在场（模块已卸载）时只保数据行、不落索引行——
    // 「卸载后数据保留但不可访问」是刻意的（无 schema 数据不静默暴露，B.3 一律 404），
    // 重装同 id 模块时 reprojectModule 按新 manifest 补齐索引。
    this.db
      .prepare(
        `DELETE FROM dyn_index
         WHERE workspace_id = ? AND module_id = ? AND record_type = ? AND record_id = ?`,
      )
      .run(env.workspaceId, moduleId, recordType, recordId);
    const schema = this.records(env.workspaceId).find((s) => s.record.id === recordType);
    if (!schema) return;
    const insert = this.db.prepare(
      `INSERT INTO dyn_index
         (workspace_id, module_id, record_type, record_id, field_key, field_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const field of schema.record.fields) {
      if (!field.queryable) continue;
      const value = data[field.key];
      if (value === undefined) continue;
      insert.run(env.workspaceId, moduleId, recordType, recordId, field.key, canonicalFieldValue(value));
    }
  }

  /**
   * 增量追账：游标之后的 record.* 事件应用到投影。
   * 单事务；进程重启后游标归 -1 → 全量重放（幂等，见 applyEvent）。
   */
  sync(workspaceId: string): { appliedEvents: number } {
    const run = this.db.transaction(() => {
      let applied = 0;
      const from = this.#cursors.get(workspaceId) ?? -1;
      this.oplog.forEachEvent(
        workspaceId,
        (env) => {
          if (isDynRecordEvent(env.type)) {
            this.applyEvent(env);
            applied++;
          }
        },
        { fromLamport: from },
      );
      return { appliedEvents: applied };
    });
    return run();
  }

  /**
   * 整组重投影一个模块：清空该模块切片 + 从头重放它的全部 record.* 事件。
   *
   * 两个触发点，各有各的必要性：
   *  1. 安装成功后无条件调用（ModuleRegistry）——卸载保留数据，重装同 id 时 manifest
   *     可能已变（queryable 增减、字段增删），dyn_index 必须按**新** manifest 重建；
   *     版本戳帮不上这里（戳只认代码版本 DYN_PROJECTION_VERSION，manifest 是数据不是代码）；
   *  2. ensureModuleProjection 的 rebuild 回调——DYN_PROJECTION_VERSION bump 后整组重建。
   */
  reprojectModule(workspaceId: string, moduleId: string): void {
    const run = this.db.transaction(() => {
      clearProjectionTables(this.db, workspaceId, dynTables(moduleId));
      this.oplog.forEachEvent(workspaceId, (env) => {
        if (!isDynRecordEvent(env.type)) return;
        const p = env.payload as { moduleId?: unknown };
        if (p?.moduleId === moduleId) this.applyEvent(env);
      });
    });
    run();
  }

  /** per-module 投影版本戳（组名 dyn.{moduleId}）；rebuild = 该模块整组重投影 */
  ensureModuleProjection(workspaceId: string, moduleId: string): void {
    ensureProjectionVersion(this.db, {
      group: dynGroupName(moduleId),
      workspaceId,
      codeVersion: DYN_PROJECTION_VERSION,
      rebuild: () => this.reprojectModule(workspaceId, moduleId),
    });
  }

  /** 清空本工作区的全部动态记录投影（facade.replay 用；数据真相在 oplog，重放即恢复） */
  clearProjection(workspaceId: string): void {
    clearProjectionTables(this.db, workspaceId, [
      { table: 'dyn_index' },
      { table: 'dyn_records' },
    ]);
  }

  /** 游标复位（facade.replay 全量重放前调用；随后 applyEvent 会自然推回水位） */
  resetCursor(workspaceId: string): void {
    this.#cursors.set(workspaceId, -1);
  }

  // ── 内部 ─────────────────────────────────────────────────

  #resolveSchema(workspaceId: string, recordType: string): DynRecordSchema {
    const schema = this.records(workspaceId).find((s) => s.record.id === recordType);
    if (!schema) {
      throw new DynRecordNotFoundError(
        `实体 ${recordType} 未声明或所属模块未安装（动态记录的读写白名单严格来自已安装模块的 manifest）`,
      );
    }
    return schema;
  }

  #row(workspaceId: string, moduleId: string, recordType: string, recordId: string): DynStoredRecord | undefined {
    const row = this.db
      .prepare<unknown[], RecordRow>(
        `SELECT record_id, data, version, created_at, updated_at
         FROM dyn_records
         WHERE workspace_id = ? AND module_id = ? AND record_type = ? AND record_id = ?`,
      )
      .get(workspaceId, moduleId, recordType, recordId);
    return row ? toStored(row) : undefined;
  }

  #requireRow(workspaceId: string, moduleId: string, recordType: string, recordId: string): DynStoredRecord {
    const row = this.#row(workspaceId, moduleId, recordType, recordId);
    if (!row) {
      throw new DynRecordNotFoundError(`记录 ${recordType}/${recordId} 不存在`);
    }
    return row;
  }

  #advanceCursor(workspaceId: string, lamport: number): void {
    const cur = this.#cursors.get(workspaceId) ?? -1;
    if (lamport > cur) this.#cursors.set(workspaceId, lamport);
  }
}

/** 一个模块的投影组拥有的表（按 module_id 切片；先子表 dyn_index 后主表 dyn_records） */
export function dynTables(moduleId: string): ProjectionTable[] {
  return [
    { table: 'dyn_index', scope: { module_id: moduleId } },
    { table: 'dyn_records', scope: { module_id: moduleId } },
  ];
}

/** manifest 是否声明了 dyn 命名空间的实体（决定安装后是否需要重投影 / 构造期是否登记版本戳） */
export function hasDynRecords(records: ManifestRecord[] | undefined): boolean {
  return (records ?? []).some((r) => r.id.startsWith(DYN_RECORD_PREFIX));
}

// ── 校验纯函数（导出供测试复用）──────────────────────────

/**
 * 入参 data 校验：必须是对象；每个键必须是 manifest 声明的列；
 * 值按列类型白名单校验（string/number/boolean/date/json）。
 * 所有列都是可选的（manifest 无 required 概念）——缺列 = 存 JSON 里就没有这个键。
 */
export function validateRecordData(record: ManifestRecord, data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new DynRecordValidationError(`记录数据必须是对象（实体 ${record.label}）`);
  }
  const byKey = new Map(record.fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(data)) {
    const field = byKey.get(key);
    if (!field) {
      throw new DynRecordValidationError(
        `实体 ${record.id} 未声明字段「${key}」（声明的列：${record.fields.map((f) => f.key).join('、')}）`,
      );
    }
    assertFieldValue(record.id, field.key, field.type, value);
  }
  return data as Record<string, unknown>;
}

function assertFieldValue(recordId: string, key: string, type: string | undefined, value: unknown): void {
  const fail = (why: string): never => {
    throw new DynRecordValidationError(`实体 ${recordId} 的字段 ${key}（type=${type}）${why}：${JSON.stringify(value)}`);
  };
  switch (type) {
    case 'string':
      if (typeof value !== 'string') fail('必须是字符串');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('必须是有限数字');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail('必须是布尔值');
      return;
    case 'date':
      // 只约束「可解析的日期字符串」，不限死 ISO 格式——入参来自 JSON，宽松解析比格式洁癖更有跨端兼容性
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('必须是可解析的日期字符串');
      return;
    case 'json':
      return; // 任意 JSON 值皆可（data 本来就是从 JSON 来的）
    default:
      // 内置模块的列不声明 type（由代码事实决定）；声明式实体的列 type 必填（B.1 提案期已拦）
      throw new EventError(`实体 ${recordId} 的字段 ${key} 没有声明 type，动态记录存储无法校验入参`);
  }
}

function assertRowId(id: string): void {
  if (!ROW_ID_RE.test(id)) {
    throw new DynRecordValidationError(
      `记录 id 非法：${JSON.stringify(id)}（须字母数字开头，仅含字母/数字/_/-，≤64 位）`,
    );
  }
}

function assertPayloadShape(
  env: EventEnvelope,
  p: { moduleId?: unknown; recordType?: unknown; recordId?: unknown },
): { moduleId: string; recordType: string; recordId: string } {
  if (typeof p.moduleId !== 'string' || typeof p.recordType !== 'string' || typeof p.recordId !== 'string') {
    throw new EventError(`事件 ${env.eventId} 的 record.* 载荷缺定位键（moduleId/recordType/recordId）`);
  }
  return { moduleId: p.moduleId, recordType: p.recordType, recordId: p.recordId };
}

/**
 * 查询串 → 可比对值。**唯一**一处转换规则，B.3 的 HTTP 端点与 B.4 的 AI 工具共用：
 * 两者都是「把外部传来的字符串按列声明类型还原成值」的适配层，规则分两处写必然漂移。
 *
 * 为什么必须转：dyn_index 存的是规范字符串（number→"1.5"、boolean→"true"），
 * 拿原始查询串直接比会永远匹配不上——列类型是唯一的转换依据，所以它也在白名单里。
 *
 * 与 validateFieldValue 的分工：这里只服务等值过滤的入参，不做白名单判定
 * （列是否 queryable 由 requireQueryable 按调用方 workspace 的 manifest 判，
 * 不能用工具注册期的快照——总线是进程级的，manifest 是 per-workspace 的）。
 * 抛 ValidationError，由适配层各自映射到自己的错误语义（端点 400 / 工具入参不合法）。
 */
export function coerceQueryValue(column: ManifestRecordField, raw: string): unknown {
  switch (column.type) {
    case 'number': {
      const n = Number(raw);
      // 空串要显式挡：Number('') === 0，不挡就会把「没填」当成 0 去匹配
      if (raw.trim() === '' || !Number.isFinite(n)) {
        throw new DynRecordValidationError(`字段 ${column.key} 是数字列，收到 ${JSON.stringify(raw)}`);
      }
      return n;
    }
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new DynRecordValidationError(`字段 ${column.key} 是布尔列，只接受 true / false`);
    case 'json':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new DynRecordValidationError(`字段 ${column.key} 是 json 列，值必须是合法 JSON`);
      }
    default:
      // string / date：查询串原样比对（date 存的也是 ISO 字符串，字典序即时序）
      return raw;
  }
}

function toStored(row: RecordRow): DynStoredRecord {
  return {
    recordId: row.record_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 单页上限。与 server 界面清单分页上限一致——防止一次拉爆内存。
 * 导出：B.3 端点与 B.4 工具的 limit 上限必须同源，不许各写一个 200。
 */
export const LIST_LIMIT_MAX = 200;

/** 单页缺省条数（list 未给 limit 时用）。导出同理：适配层的参数文案必须与实际缺省一致 */
export const LIST_LIMIT_DEFAULT = 50;

function clampLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new DynRecordValidationError(`limit 必须是正整数：${n}`);
  }
  return Math.min(n, LIST_LIMIT_MAX);
}

/**
 * offset 不做上限截断——它和 limit 不是一类东西：limit 是「一次取多少」（要封顶），
 * offset 是「翻到第几页」（封顶等于翻不过去，深分页会静默返回同一页）。
 */
function assertOffset(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new DynRecordValidationError(`offset 必须是不小于 0 的整数：${n}`);
  }
  return n;
}

/**
 * 查询白名单闸口：字段必须已声明且 queryable:true。
 * 不在白名单里就是「这个查询不成立」，不是「参数写错了」——两者的错误语义不同，
 * 但存储层统一抛 ValidationError（端点层 B.3 会先自己判一遍并映射成 404）。
 */
function requireQueryable(record: ManifestRecord, key: string, usage: string): ManifestRecordField {
  const field = record.fields.find((f) => f.key === key);
  if (!field) {
    throw new DynRecordValidationError(`实体 ${record.id} 没有字段 ${key}，不能作为${usage}条件`);
  }
  if (!field.queryable) {
    throw new DynRecordValidationError(
      `字段 ${field.key} 未声明 queryable，不能作为${usage}条件（manifest 白名单限制）`,
    );
  }
  return field;
}

/** 按定位四键 + field_key 关联索引表。alias/kind 是代码内常量，不来自入参 */
function indexJoin(alias: string, kind: 'JOIN' | 'LEFT JOIN'): string {
  return (
    `${kind} dyn_index ${alias} ON ${alias}.workspace_id = r.workspace_id ` +
    `AND ${alias}.module_id = r.module_id AND ${alias}.record_type = r.record_type ` +
    `AND ${alias}.record_id = r.record_id AND ${alias}.field_key = ?`
  );
}
