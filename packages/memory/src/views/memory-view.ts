import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  LEGACY_SECTION_KEY,
  MEMORY_EVENT_TYPES,
  type MemoryItemForgottenPayload,
  type MemoryItemSavedPayload,
  type MemoryScope,
  type MemorySectionRemovedPayload,
  type MemorySectionUpdatedPayload,
} from '../events/catalog.js';
import { renderResidentMemory, type ResidentMemory } from '../render.js';

/**
 * 记忆章节投影（MemorySectionView）——memory_section 表的事件投影 + 查询 + 渲染。
 *
 * 纪律（与 wms 各投影一致，DESIGN.md §8「事件是唯一真相」）：
 *  - applyEvent 是本表唯一写路径，幂等：
 *    · section.updated 按自然键 (workspace_id, scope, section_key) upsert，
 *      重放同一事件写入同样的值 = 空操作；
 *    · section.removed 按自然键 DELETE，重复删除是空操作；
 *  - base_lamport 取事件自身的 lamport（不是 payload）：只有本章节被写入时
 *    它才变，因此天然是 memory.rewrite 的乐观并发令牌；
 *  - v1 的 memory.item.* 事件投影进 legacy-* 章节（行内含 memoryId 以支持
 *    遗忘与幂等去重）——事件不可改写，兼容只能长在投影侧。
 */

export interface MemorySection {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly sectionKey: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  /** 最后一次写入本章节的事件 lamport（rewrite 的乐观并发令牌） */
  readonly baseLamport: number;
  /** 最后一次写入者（审计 actor，含 @nodeId） */
  readonly lastActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SectionRow {
  id: string;
  scope: string;
  section_key: string;
  title: string;
  body_md: string;
  summary: string;
  keywords: string;
  base_lamport: number;
  last_actor: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, scope, section_key, title, body_md, summary, keywords, base_lamport, last_actor, created_at, updated_at';

function rowToSection(row: SectionRow): MemorySection {
  let keywords: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.keywords);
    if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    keywords = []; // 投影列是缓存：脏值降级为空关键词，不炸读路径
  }
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    sectionKey: row.section_key,
    title: row.title,
    bodyMd: row.body_md,
    summary: row.summary,
    keywords,
    baseLamport: row.base_lamport,
    lastActor: row.last_actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 章节稳定序：scope（personal 先，与 T0 段落顺序一致）→ 建档时间 → 键名 */
const ORDER_BY =
  " ORDER BY CASE scope WHEN 'personal' THEN 0 ELSE 1 END, created_at ASC, section_key ASC";

/**
 * 记忆投影组的版本号（memory_section 及其派生的章节/条目结构）。
 *
 * **改了本文件里的派生语义就把它 +1**：条目怎么归并进章节、legacy 条目的兜底
 * 章节规则、T0/T2 渲染依赖的字段口径、applyEvent 的应用顺序。只加列、只改查询 → 不用动。
 * +1 之后不需要写迁移脚本：用户下次启动自动清空并从 oplog 全量重放
 * （见 core/projection/projection-version.ts）。
 *
 * 2：legacy 收容章节的主键从 randomUUID() 改为按自然键确定性派生
 * （随机 id 会让全量重放不确定——同一份账本重放两次得到不同 id）。
 */
export const MEMORY_PROJECTION_VERSION = 2;

/**
 * legacy 章节 id 的派生命名空间（RFC 4122 v5）。
 *
 * ⚠️ 永不可改：改了等于给所有存量 legacy 章节换主键，重放后按 id 引用的东西全部悬空。
 */
const LEGACY_ID_NAMESPACE = 'a3f1c2d4-6e6f-5e61-8000-6f6e65776d73';

/**
 * legacy 收容章节的主键：由自然键 (workspace_id, scope, section_key) 确定性派生。
 *
 * 为什么不能 randomUUID()：正式章节的 id 由事件携带（payload.sectionId），重放天然复现；
 * legacy 章节没有对应事件——它是投影从 v1 条目事件凭空长出来的，随机 id 会让
 * 「同一份账本全量重放两次得到同一份投影」这条铁律失效（重放后 id 变了）。
 * 确定性派生同时让多节点各自重放出同一个 id，同步合并不会撞出两份同键章节。
 *
 * 形状仍是 uuid（migrations.ts 主键约定：uuid，禁自增 int）——sha1 摘要前 16 字节
 * 按 RFC 4122 v5 置 version/variant 位。
 */
function legacySectionId(workspaceId: string, scope: MemoryScope, sectionKey: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(LEGACY_ID_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`${workspaceId}\u0000${scope}\u0000${sectionKey}`)
    .digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version = 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant = RFC 4122
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class MemorySectionView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 memory.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case MEMORY_EVENT_TYPES.sectionUpdated:
        this.#upsert(env.payload as MemorySectionUpdatedPayload, env);
        break;
      case MEMORY_EVENT_TYPES.sectionRemoved: {
        const p = env.payload as MemorySectionRemovedPayload;
        this.db
          .prepare(
            'DELETE FROM memory_section WHERE workspace_id = ? AND scope = ? AND section_key = ?',
          )
          .run(this.workspaceId, p.scope, p.sectionKey);
        break;
      }
      case MEMORY_EVENT_TYPES.itemSaved:
        this.#legacyAppend(env.payload as MemoryItemSavedPayload, env);
        break;
      case MEMORY_EVENT_TYPES.itemForgotten:
        this.#legacyRemove(env.payload as MemoryItemForgottenPayload);
        break;
    }
  }

  /** 清空本工作区全部章节（全量重放的前置动作） */
  clear(): void {
    this.db.prepare('DELETE FROM memory_section WHERE workspace_id = ?').run(this.workspaceId);
  }

  /** 章节清单（稳定序）；scope 可选过滤 */
  list(scope?: MemoryScope): MemorySection[] {
    const rows = scope
      ? this.#all(
          `SELECT ${COLUMNS} FROM memory_section WHERE workspace_id = ? AND scope = ?${ORDER_BY}`,
          this.workspaceId,
          scope,
        )
      : this.#all(
          `SELECT ${COLUMNS} FROM memory_section WHERE workspace_id = ?${ORDER_BY}`,
          this.workspaceId,
        );
    return rows.map(rowToSection);
  }

  /** 按自然键取章节（工具与并发达令牌的读口） */
  byKey(scope: MemoryScope, sectionKey: string): MemorySection | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM memory_section WHERE workspace_id = ? AND scope = ? AND section_key = ?`,
      )
      .get(this.workspaceId, scope, sectionKey) as SectionRow | undefined;
    return row ? rowToSection(row) : undefined;
  }

  /** 章节总量（上限护栏的判据）；scope 可选 */
  count(scope?: MemoryScope): number {
    const row = (
      scope
        ? this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM memory_section WHERE workspace_id = ? AND scope = ?',
            )
            .get(this.workspaceId, scope)
        : this.db
            .prepare('SELECT COUNT(*) AS n FROM memory_section WHERE workspace_id = ?')
            .get(this.workspaceId)
    ) as { n: number };
    return row.n;
  }

  /**
   * T2 预取：用户消息命中章节关键词/标题 → 返回该节全文（确定性字符串匹配，
   * 零 LLM 成本）。只匹配 project 章节——personal 已在 T0 全文常驻，重复注入
   * 只是浪费 token。命中数排序，同分取最近更新者，最多 limit 节。
   *
   * 过短（少于 3 字）或过泛（入库单、供应商、sku 这类几乎每句都会出现的词）
   * 不计分。一节至少要有一个更长的专名才预取，避免整节正文灌进每一轮提示。
   */
  matchSections(userText: string, limit = 2): MemorySection[] {
    const hay = userText.toLowerCase();
    if (!hay.trim()) return [];
    const hits: { section: MemorySection; score: number }[] = [];
    for (const s of this.list('project')) {
      let score = needleScore(s.title, hay, 3);
      for (const kw of s.keywords) score += needleScore(kw, hay, 2);
      if (score > 0) hits.push({ section: s, score });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.section.updatedAt) - Date.parse(a.section.updatedAt) ||
        a.section.sectionKey.localeCompare(b.section.sectionKey),
    );
    return hits.slice(0, Math.max(0, limit)).map((h) => h.section);
  }

  /** T0 常驻段（personal 全文 + project 目录）。overflow 按层拆开，调用方归并对应层 */
  resident(now: number = Date.now()): ResidentMemory {
    return renderResidentMemory(this.list(), now);
  }

  // ── 写路径（唯一入口 applyEvent 的分支实现）────────────────────

  #upsert(p: MemorySectionUpdatedPayload, env: EventEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO memory_section
           (id, workspace_id, scope, section_key, title, body_md, summary, keywords,
            base_lamport, last_actor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, scope, section_key) DO UPDATE SET
           id           = excluded.id,
           title        = excluded.title,
           body_md      = excluded.body_md,
           summary      = excluded.summary,
           keywords     = excluded.keywords,
           base_lamport = excluded.base_lamport,
           last_actor   = excluded.last_actor,
           updated_at   = excluded.updated_at`,
      )
      .run(
        p.sectionId,
        this.workspaceId,
        p.scope,
        p.sectionKey,
        p.title,
        p.bodyMd,
        p.summary,
        JSON.stringify(p.keywords ?? []),
        env.lamport,
        env.actor,
        env.createdAt,
        env.createdAt,
      );
  }

  /** v1 条目 → legacy 章节追加一行（行内含 memoryId：幂等去重 + 支持遗忘） */
  #legacyAppend(p: MemoryItemSavedPayload, env: EventEnvelope): void {
    const key = LEGACY_SECTION_KEY[p.scope];
    const existing = this.byKey(p.scope, key);
    const marker = `[${p.memoryId}]`;
    if (existing?.bodyMd.includes(marker)) return; // 重放幂等
    const line = `- ${marker} ${p.content}`;
    this.#upsert(
      {
        sectionId: existing?.id ?? legacySectionId(this.workspaceId, p.scope, key),
        scope: p.scope,
        sectionKey: key,
        title: existing?.title ?? '历史条目（未归并）',
        bodyMd: existing ? `${existing.bodyMd.trimEnd()}\n${line}` : line,
        summary:
          existing?.summary ?? 'v1 条目式记忆迁移收容区：请人工归并进正式章节后删除本节',
        keywords: existing?.keywords ?? ['历史条目', '待归并'],
      },
      env,
    );
  }

  /** v1 遗忘 → 从 legacy 章节摘掉对应行；章节空了则整节删除 */
  #legacyRemove(p: MemoryItemForgottenPayload): void {
    const marker = `[${p.memoryId}]`;
    for (const scope of ['personal', 'project'] as const) {
      const key = LEGACY_SECTION_KEY[scope];
      const existing = this.byKey(scope, key);
      if (!existing || !existing.bodyMd.includes(marker)) continue;
      const rest = existing.bodyMd
        .split('\n')
        .filter((line) => !line.includes(marker))
        .join('\n')
        .trim();
      if (rest === '') {
        this.db
          .prepare(
            'DELETE FROM memory_section WHERE workspace_id = ? AND scope = ? AND section_key = ?',
          )
          .run(this.workspaceId, scope, key);
      } else {
        this.db
          .prepare(
            'UPDATE memory_section SET body_md = ?, updated_at = ? WHERE workspace_id = ? AND scope = ? AND section_key = ?',
          )
          .run(rest, existing.updatedAt, this.workspaceId, scope, key);
      }
    }
  }

  #all(sql: string, ...args: unknown[]): SectionRow[] {
    return this.db.prepare(sql).all(...args) as SectionRow[];
  }
}

/** 专名至少 3 字。两字词（入库、批次、库存）几乎句句都有，不拿来预取 */
const DISTINCTIVE_MIN_LENGTH = 3;

/**
 * 长度够、但本身就是业务里的普通说法。整词相等才排除，
 * 「易碎品」「先进先出」「A001」这种专名不受影响。
 */
const GENERIC_NEEDLES = new Set([
  'sku',
  '供应商',
  '入库单',
  '出库单',
  '退货单',
  '调拨单',
  '盘点单',
  '拣货单',
  '到货预报',
]);

function needleScore(raw: string, hay: string, weight: number): number {
  const needle = raw.trim().toLowerCase();
  if (needle.length < DISTINCTIVE_MIN_LENGTH || GENERIC_NEEDLES.has(needle)) return 0;
  return hay.includes(needle) ? weight : 0;
}
