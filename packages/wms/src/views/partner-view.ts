import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type PartnerCreatedPayload,
  type PartnerUpdatedPayload,
} from '../events/catalog.js';

/**
 * 往来单位投影（PartnerView，M21）——wms_partner 表的事件投影 + 查询。
 *
 * 纪律（与 SkuView 同款）：
 *  - applyEvent 是本表唯一写路径，幂等（按事件携带的 partnerId 查重早退）；
 *  - partner.updated 字段级 LWW 由全序重放天然实现（COALESCE 未传保持不变）；
 *  - kind（supplier/customer）不可改——那是两个不同业务身份，改身份 = 新建。
 */

export type PartnerKind = 'supplier' | 'customer';

export interface PartnerRecord {
  readonly id: string;
  readonly partnerCode: string;
  readonly kind: PartnerKind;
  readonly name: string;
  readonly contact: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly note: string | null;
  readonly extData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PartnerRow {
  id: string;
  partner_code: string;
  kind: string;
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  ext_data: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: PartnerRow): PartnerRecord {
  return {
    id: row.id,
    partnerCode: row.partner_code,
    kind: row.kind as PartnerKind,
    name: row.name,
    contact: row.contact,
    phone: row.phone,
    address: row.address,
    note: row.note,
    extData: JSON.parse(row.ext_data) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PartnerView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** 幂等应用一条 wms.partner.* 事件（重放器/追账器调用，事务内） */
  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.partnerCreated: {
        const p = env.payload as PartnerCreatedPayload;
        if (this.#byIdRaw(p.partnerId)) return; // 已应用过（幂等）
        // partner_code 唯一冲突不走 OR IGNORE 静默——业务冲突必须显式炸出来
        this.db
          .prepare(
            `INSERT INTO wms_partner (id, workspace_id, partner_code, kind, name, contact, phone, address, note, ext_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.partnerId,
            this.workspaceId,
            p.partnerCode,
            p.kind,
            p.name,
            p.contact ?? null,
            p.phone ?? null,
            p.address ?? null,
            p.note ?? null,
            JSON.stringify(p.extData ?? {}),
            env.createdAt,
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.partnerUpdated: {
        const p = env.payload as PartnerUpdatedPayload;
        this.db
          .prepare(
            `UPDATE wms_partner SET
               name = COALESCE(?, name),
               contact = COALESCE(?, contact),
               phone = COALESCE(?, phone),
               address = COALESCE(?, address),
               note = COALESCE(?, note),
               ext_data = COALESCE(?, ext_data),
               updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(
            p.name ?? null,
            p.contact ?? null,
            p.phone ?? null,
            p.address ?? null,
            p.note ?? null,
            p.extData === undefined ? null : JSON.stringify(p.extData),
            env.createdAt,
            this.workspaceId,
            p.partnerId,
          );
        break;
      }
    }
  }

  /** 按编码查（业务键） */
  byCode(partnerCode: string): PartnerRecord | undefined {
    const row = this.db
      .prepare<unknown[], PartnerRow>(
        `SELECT * FROM wms_partner WHERE workspace_id = ? AND partner_code = ?`,
      )
      .get(this.workspaceId, partnerCode);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按 id 查（单据联查展示用） */
  byId(id: string): PartnerRecord | undefined {
    const row = this.#byIdRaw(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 全部往来单位，可按 kind 过滤 */
  list(kind?: PartnerKind): PartnerRecord[] {
    return this.listMatching({ kind });
  }

  /** kind 精确，q 对编码和名称做包含匹配 */
  listMatching(opts: { kind?: PartnerKind; q?: string }): PartnerRecord[] {
    const { where, args } = this.#match(opts);
    const rows = this.db
      .prepare<unknown[], PartnerRow>(
        `SELECT * FROM wms_partner WHERE ${where} ORDER BY partner_code`,
      )
      .all(...args) as unknown as PartnerRow[];
    return rows.map(rowToRecord);
  }

  /** 与 listMatching 同一套条件，SQL LIMIT/OFFSET。 */
  listMatchingPage(opts: {
    kind?: PartnerKind;
    q?: string;
    limit: number;
    offset: number;
  }): { rows: PartnerRecord[]; total: number } {
    const { where, args } = this.#match(opts);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM wms_partner WHERE ${where}`).get(...args) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare<unknown[], PartnerRow>(
        `SELECT * FROM wms_partner WHERE ${where} ORDER BY partner_code LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as unknown as PartnerRow[];
    return { rows: rows.map(rowToRecord), total };
  }

  #match(opts: { kind?: PartnerKind; q?: string }): { where: string; args: unknown[] } {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [this.workspaceId];
    if (opts.kind) {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    if (opts.q) {
      where.push(`(partner_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`);
      const pat = `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      args.push(pat, pat);
    }
    return { where: where.join(' AND '), args };
  }

  #byIdRaw(id: string): PartnerRow | undefined {
    return this.db
      .prepare<unknown[], PartnerRow>(`SELECT * FROM wms_partner WHERE workspace_id = ? AND id = ?`)
      .get(this.workspaceId, id) as PartnerRow | undefined;
  }
}
