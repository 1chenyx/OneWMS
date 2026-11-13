/**
 * 入站收件和出站队列。本机表，不进 oplog。
 * 同一外部主键只接受一次；同一领域事件对同一条路由只入队一次。
 * 已接受的收件就是关联：出站要不要推，看本连接器有没有这笔 internalRef。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CONNECTOR_ID_PATTERN } from './ids.js';
import { IntegrationStoreError } from './store-error.js';

const BODY_MAX = 256 * 1024;
const ERROR_MAX = 500;
const ID_MAX = 256;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'dead';

export interface InboxRow {
  id: string;
  connectorId: string;
  routeId: string;
  externalId: string;
  status: 'accepted' | 'rejected';
  internalRef: string | null;
  error: string | null;
  raw: unknown;
  createdAt: string;
}

export type InboxDisposition =
  | { disposition: 'accepted'; id: string; internalRef: string }
  | { disposition: 'rejected'; id: string }
  | { disposition: 'duplicate'; id: string; internalRef: string };

/** 一条入站拉取路由的水位。没有行表示还没拉过。 */
export interface PollWatermark {
  watermark: string | null;
  lastAttemptAt: string;
}

export interface OutboxRow {
  id: string;
  connectorId: string;
  routeId: string;
  eventId: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  body: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxMark {
  changed: boolean;
  row: OutboxRow;
}

interface InboxStored {
  id: string;
  connector_id: string;
  route_id: string;
  external_id: string;
  status: 'accepted' | 'rejected';
  internal_ref: string | null;
  error: string | null;
  raw_json: string;
  created_at: string;
}

interface OutboxStored {
  id: string;
  connector_id: string;
  route_id: string;
  event_id: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  body_json: string;
  created_at: string;
  updated_at: string;
}

/** 第 attempts 次失败之后的下次时间。第 1 次等 1 秒，之后翻倍，最多 1 小时。 */
export function nextAttemptAt(now: string, attempts: number): string {
  const start = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isInteger(attempts) || attempts < 1) {
    throw new IntegrationStoreError('INTEGRATION_QUEUE', '重试时间不合法');
  }
  const shift = Math.min(30, attempts - 1);
  const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** shift);
  return new Date(start + delay).toISOString();
}

export class IntegrationQueue {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /**
   * 记下一次收件。
   * 已经接受过的外部主键返回 duplicate，不改原来的单号。
   * 拒绝只留记录，不挡住下一次接受。
   */
  recordInbox(input: {
    connectorId: string;
    routeId: string;
    externalId: string;
    raw: unknown;
    outcome: 'accepted' | 'rejected';
    internalRef?: string;
    error?: string;
    now?: string;
  }): InboxDisposition {
    const connectorId = assertConnector(input.connectorId);
    const routeId = assertSlug(input.routeId, '路由 id');
    const externalId = assertToken(input.externalId, '外部主键');
    const rawJson = stringifyBody(input.raw);
    const now = clock(input.now);
    return this.db.transaction(() => {
      const existing = this.acceptedRow(connectorId, routeId, externalId);
      if (existing?.internal_ref) {
        return { disposition: 'duplicate' as const, id: existing.id, internalRef: existing.internal_ref };
      }
      const id = randomUUID();
      if (input.outcome === 'accepted') {
        const internalRef = typeof input.internalRef === 'string' ? input.internalRef.trim() : '';
        if (!internalRef || internalRef.length > ID_MAX) {
          throw new IntegrationStoreError('INTEGRATION_QUEUE', '接受收件要写内部单号');
        }
        this.db
          .prepare(
            `INSERT INTO integration_inbox
              (id, workspace_id, connector_id, route_id, external_id, status, internal_ref, error, raw_json, created_at)
             VALUES (?, ?, ?, ?, ?, 'accepted', ?, NULL, ?, ?)`,
          )
          .run(id, this.workspaceId, connectorId, routeId, externalId, internalRef, rawJson, now);
        return { disposition: 'accepted' as const, id, internalRef };
      }
      const error = typeof input.error === 'string' ? input.error.trim() : '';
      if (!error) throw new IntegrationStoreError('INTEGRATION_QUEUE', '拒绝收件要写原因');
      this.db
        .prepare(
          `INSERT INTO integration_inbox
            (id, workspace_id, connector_id, route_id, external_id, status, internal_ref, error, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, 'rejected', NULL, ?, ?, ?)`,
        )
        .run(id, this.workspaceId, connectorId, routeId, externalId, clip(error, ERROR_MAX), rawJson, now);
      return { disposition: 'rejected' as const, id };
    })();
  }

  /** 本连接器是否已经接受过这个内部单号。出站 requireLink 用这个判断。 */
  hasLink(connectorId: string, internalRef: string): boolean {
    return this.externalIdFor(connectorId, internalRef) !== undefined;
  }

  /** 这条路由已经接受过的内部单号。没有则还没入过账。 */
  acceptedRef(connectorId: string, routeId: string, externalId: string): string | undefined {
    const row = this.acceptedRow(
      assertConnector(connectorId),
      assertSlug(routeId, '路由 id'),
      assertToken(externalId, '外部主键'),
    );
    return row?.internal_ref ?? undefined;
  }

  externalIdFor(connectorId: string, internalRef: string): string | undefined {
    assertConnector(connectorId);
    const ref = typeof internalRef === 'string' ? internalRef.trim() : '';
    if (!ref) return undefined;
    const row = this.db
      .prepare(
        `SELECT external_id FROM integration_inbox
         WHERE workspace_id = ? AND connector_id = ? AND status = 'accepted' AND internal_ref = ?
         LIMIT 1`,
      )
      .get(this.workspaceId, connectorId, ref) as { external_id: string } | undefined;
    return row?.external_id;
  }

  listInbox(connectorId: string, limit = 50): InboxRow[] {
    assertConnector(connectorId);
    const rows = this.db
      .prepare(
        `SELECT id, connector_id, route_id, external_id, status, internal_ref, error, raw_json, created_at
         FROM integration_inbox
         WHERE workspace_id = ? AND connector_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(this.workspaceId, connectorId, boundLimit(limit)) as InboxStored[];
    return rows.map(toInbox);
  }

  /** 同一连接器、路由、领域事件只入队一次。重放账本不会再插一行。 */
  enqueue(input: { connectorId: string; routeId: string; eventId: string; body: unknown; now?: string }): {
    created: boolean;
    row: OutboxRow;
  } {
    const connectorId = assertConnector(input.connectorId);
    const routeId = assertSlug(input.routeId, '路由 id');
    const eventId = assertToken(input.eventId, '事件 id');
    const bodyJson = stringifyBody(input.body);
    const now = clock(input.now);
    const id = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT INTO integration_outbox
          (id, workspace_id, connector_id, route_id, event_id, status, attempts, next_attempt_at, last_error, body_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, ?)
         ON CONFLICT (workspace_id, connector_id, route_id, event_id) DO NOTHING`,
      )
      .run(id, this.workspaceId, connectorId, routeId, eventId, now, bodyJson, now, now);
    const row = this.outboxByEvent(connectorId, routeId, eventId);
    if (!row) throw new IntegrationStoreError('INTEGRATION_QUEUE', '出站记录没有写上');
    return { created: inserted.changes > 0, row };
  }

  /** 到点该发的。pending 和 failed 都算，sent 和 dead 不算。 */
  due(now: string, limit = 20): OutboxRow[] {
    const at = clock(now);
    const rows = this.db
      .prepare(
        `SELECT id, connector_id, route_id, event_id, status, attempts, next_attempt_at, last_error, body_json, created_at, updated_at
         FROM integration_outbox
         WHERE workspace_id = ? AND status IN ('pending', 'failed') AND next_attempt_at <= ?
         ORDER BY next_attempt_at, id
         LIMIT ?`,
      )
      .all(this.workspaceId, at, boundLimit(limit)) as OutboxStored[];
    return rows.map(toOutbox);
  }

  markSent(id: string, now?: string): OutboxMark {
    return this.finish(id, now, (row, at) => {
      if (row.status !== 'pending' && row.status !== 'failed') return undefined;
      this.db
        .prepare(
          `UPDATE integration_outbox
           SET status = 'sent', last_error = NULL, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(at, row.id, this.workspaceId);
      return true;
    });
  }

  /** 这个连接器的出站账本水位。没有扫过是 -1。停用的连接器不要往前推。 */
  cursor(connectorId: string): number {
    assertConnector(connectorId);
    const row = this.db
      .prepare(`SELECT lamport FROM integration_cursor WHERE workspace_id = ? AND connector_id = ?`)
      .get(this.workspaceId, connectorId) as { lamport: number } | undefined;
    return row?.lamport ?? -1;
  }

  /** 这条拉取路由上次拉到哪。没有行就是还没拉过。 */
  pollWatermark(connectorId: string, routeId: string): PollWatermark | undefined {
    const row = this.db
      .prepare(
        `SELECT watermark, last_attempt_at FROM integration_poll
         WHERE workspace_id = ? AND connector_id = ? AND route_id = ?`,
      )
      .get(this.workspaceId, assertConnector(connectorId), assertSlug(routeId, '路由 id')) as
      | { watermark: string | null; last_attempt_at: string }
      | undefined;
    if (!row) return undefined;
    return { watermark: row.watermark, lastAttemptAt: row.last_attempt_at };
  }

  /**
   * 记下这次拉取。watermark 不传就保留原来的水位，只更新尝试时间。
   * 失败也要记尝试时间，间隔未到就不再打对方。
   */
  recordPoll(connectorId: string, routeId: string, at: string, watermark?: string): void {
    const connector = assertConnector(connectorId);
    const route = assertSlug(routeId, '路由 id');
    const stamp = clock(at);
    if (watermark === undefined) {
      this.db
        .prepare(
          `INSERT INTO integration_poll (workspace_id, connector_id, route_id, watermark, last_attempt_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT (workspace_id, connector_id, route_id) DO UPDATE SET
             last_attempt_at = excluded.last_attempt_at`,
        )
        .run(this.workspaceId, connector, route, stamp);
      return;
    }
    const mark = assertToken(watermark, '拉取水位');
    this.db
      .prepare(
        `INSERT INTO integration_poll (workspace_id, connector_id, route_id, watermark, last_attempt_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, connector_id, route_id) DO UPDATE SET
           watermark = excluded.watermark,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(this.workspaceId, connector, route, mark, stamp);
  }

  /** 只往前走。映射失败时调用方停在失败事件之前，下一轮还能再试。 */
  advanceCursor(connectorId: string, lamport: number): void {
    assertConnector(connectorId);
    if (!Number.isInteger(lamport) || lamport < 0) {
      throw new IntegrationStoreError('INTEGRATION_QUEUE', '账本水位不合法');
    }
    this.db
      .prepare(
        `INSERT INTO integration_cursor (workspace_id, connector_id, lamport)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, connector_id) DO UPDATE SET
           lamport = MAX(integration_cursor.lamport, excluded.lamport)`,
      )
      .run(this.workspaceId, connectorId, lamport);
  }

  /** 失败次数到 maxAttempts 就进死信，否则按次数往后推。已发送和死信不再改。 */
  markFailed(id: string, error: string, options: { maxAttempts: number; now?: string }): OutboxMark {
    const reason = typeof error === 'string' ? error.trim() : '';
    if (!reason) throw new IntegrationStoreError('INTEGRATION_QUEUE', '失败要写原因');
    const maxAttempts = options.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) {
      throw new IntegrationStoreError('INTEGRATION_QUEUE', 'maxAttempts 必须是 1 到 50 的整数');
    }
    return this.finish(id, options.now, (row, at) => {
      if (row.status !== 'pending' && row.status !== 'failed') return undefined;
      const attempts = row.attempts + 1;
      const status: OutboxStatus = attempts >= maxAttempts ? 'dead' : 'failed';
      const next = status === 'dead' ? at : nextAttemptAt(at, attempts);
      this.db
        .prepare(
          `UPDATE integration_outbox
           SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(status, attempts, next, clip(reason, ERROR_MAX), at, row.id, this.workspaceId);
      return true;
    });
  }

  private finish(
    id: string,
    now: string | undefined,
    apply: (row: OutboxStored, at: string) => true | undefined,
  ): OutboxMark {
    if (typeof id !== 'string' || id === '') {
      throw new IntegrationStoreError('INTEGRATION_QUEUE', '出站记录不存在');
    }
    const at = clock(now);
    return this.db.transaction(() => {
      const row = this.outboxById(id);
      if (!row) throw new IntegrationStoreError('INTEGRATION_QUEUE', '出站记录不存在');
      const changed = apply(row, at) === true;
      return { changed, row: toOutbox(changed ? this.outboxById(id)! : row) };
    })();
  }

  private acceptedRow(connectorId: string, routeId: string, externalId: string): InboxStored | undefined {
    return this.db
      .prepare(
        `SELECT id, connector_id, route_id, external_id, status, internal_ref, error, raw_json, created_at
         FROM integration_inbox
         WHERE workspace_id = ? AND connector_id = ? AND route_id = ? AND external_id = ? AND status = 'accepted'`,
      )
      .get(this.workspaceId, connectorId, routeId, externalId) as InboxStored | undefined;
  }

  private outboxByEvent(connectorId: string, routeId: string, eventId: string): OutboxRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, connector_id, route_id, event_id, status, attempts, next_attempt_at, last_error, body_json, created_at, updated_at
         FROM integration_outbox
         WHERE workspace_id = ? AND connector_id = ? AND route_id = ? AND event_id = ?`,
      )
      .get(this.workspaceId, connectorId, routeId, eventId) as OutboxStored | undefined;
    return row ? toOutbox(row) : undefined;
  }

  private outboxById(id: string): OutboxStored | undefined {
    return this.db
      .prepare(
        `SELECT id, connector_id, route_id, event_id, status, attempts, next_attempt_at, last_error, body_json, created_at, updated_at
         FROM integration_outbox
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(this.workspaceId, id) as OutboxStored | undefined;
  }
}

function toInbox(row: InboxStored): InboxRow {
  return {
    id: row.id,
    connectorId: row.connector_id,
    routeId: row.route_id,
    externalId: row.external_id,
    status: row.status,
    internalRef: row.internal_ref,
    error: row.error,
    raw: JSON.parse(row.raw_json) as unknown,
    createdAt: row.created_at,
  };
}

function toOutbox(row: OutboxStored): OutboxRow {
  return {
    id: row.id,
    connectorId: row.connector_id,
    routeId: row.route_id,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    body: JSON.parse(row.body_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stringifyBody(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new IntegrationStoreError('INTEGRATION_QUEUE', '报文不能序列化');
  }
  if (json === undefined) throw new IntegrationStoreError('INTEGRATION_QUEUE', '报文不能序列化');
  if (json.length > BODY_MAX) throw new IntegrationStoreError('INTEGRATION_QUEUE', '报文过大');
  return json;
}

function clock(now: string | undefined): string {
  const parsed = Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(parsed)) throw new IntegrationStoreError('INTEGRATION_QUEUE', '时间不合法');
  return new Date(parsed).toISOString();
}

function boundLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new IntegrationStoreError('INTEGRATION_QUEUE', '条数必须是 1 到 200 的整数');
  }
  return limit;
}

function assertConnector(connectorId: string): string {
  return assertSlug(connectorId, '连接器 id');
}

function assertSlug(value: string, label: string): string {
  if (typeof value !== 'string' || !CONNECTOR_ID_PATTERN.test(value)) {
    throw new IntegrationStoreError('INTEGRATION_QUEUE', `${label}不合法`);
  }
  return value;
}

function assertToken(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX || /[\s\u0000-\u001f]/.test(value)) {
    throw new IntegrationStoreError('INTEGRATION_QUEUE', `${label}不合法`);
  }
  return value;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
