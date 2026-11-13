import type Database from 'better-sqlite3';
import { ReportInvalidError } from '../errors.js';
import {
  fieldOf,
  reportGrain,
  type FieldSpec,
  type GrainSpec,
} from './catalog.js';
import type { ReportDefinition, ReportParameter, ReportSection, ReportValueType } from './types.js';
import { isReportDay, nextUtcDay } from './validate.js';

export interface ReportColumn {
  field: string;
  label: string;
  type: ReportValueType;
}

export interface ReportRunPage {
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface CompiledReportQuery {
  sql: string;
  args: unknown[];
  columns: ReportColumn[];
  empty: boolean;
}

interface BoundFilter {
  field: FieldSpec;
  op: string;
  value: string | number | Array<string | number>;
}

function isParam(value: unknown): value is { param: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'param' in value;
}

function bindValue(
  value: ReportSection['filters'][number]['value'],
  parameters: Map<string, ReportParameter>,
  supplied: Record<string, unknown>,
): string | number | Array<string | number> {
  if (Array.isArray(value)) return value;
  if (!isParam(value)) return value;
  const param = parameters.get(value.param);
  if (!param) throw new ReportInvalidError(`条件引用了不存在的参数 ${value.param}`);
  const raw = supplied[value.param];
  if (raw === undefined || raw === null || raw === '') {
    throw new ReportInvalidError(`请先填写${param.label}`);
  }
  if (param.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new ReportInvalidError(`${param.label}必须是数字`);
    return n;
  }
  if (typeof raw !== 'string' || !raw.trim()) throw new ReportInvalidError(`请先填写${param.label}`);
  const trimmed = raw.trim();
  if (param.type === 'date' && !isReportDay(trimmed) && !trimmed.includes('T')) {
    throw new ReportInvalidError(`${param.label}要写成 YYYY-MM-DD`);
  }
  return trimmed;
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function idsFor(
  db: Database.Database,
  workspaceId: string,
  table: 'wms_sku' | 'wms_order' | 'wms_partner',
  column: 'sku_code' | 'order_no' | 'partner_code',
  codes: string[],
): string[] {
  const found: string[] = [];
  const stmt = db.prepare(
    `SELECT id FROM ${table} WHERE workspace_id = ? AND ${column} = ?`,
  );
  for (const code of codes) {
    const row = stmt.get(workspaceId, code) as { id: string } | undefined;
    if (row) found.push(row.id);
  }
  return found;
}

interface Predicate {
  sql: string;
  args: unknown[];
}

function idMatch(expr: string, ids: string[]): Predicate {
  if (ids.length === 1) return { sql: `${expr} = ?`, args: ids };
  return { sql: `${expr} IN (${ids.map(() => '?').join(', ')})`, args: ids };
}

function lookupPredicate(
  db: Database.Database,
  workspaceId: string,
  grain: GrainSpec,
  field: FieldSpec,
  op: string,
  value: string | number | Array<string | number>,
): Predicate | 'empty' | null {
  if ((op !== 'eq' && op !== 'in') || !field.lookup) return null;
  const codes = (Array.isArray(value) ? value : [value]).map(String);
  if (field.lookup === 'skuCode' && grain.skuIdExpr) {
    const ids = idsFor(db, workspaceId, 'wms_sku', 'sku_code', codes);
    if (ids.length === 0) return 'empty';
    return idMatch(grain.skuIdExpr, ids);
  }
  if (field.lookup === 'orderNo' && grain.orderIdExpr) {
    const ids = idsFor(db, workspaceId, 'wms_order', 'order_no', codes);
    if (ids.length === 0) return 'empty';
    return idMatch(grain.orderIdExpr, ids);
  }
  if (field.lookup === 'partnerCode' && grain.partnerIdExpr) {
    const ids = idsFor(db, workspaceId, 'wms_partner', 'partner_code', codes);
    if (ids.length === 0) return 'empty';
    if (grain.id === 'ledger' && grain.orderIdExpr) {
      const match = ids.length === 1 ? 'partner_id = ?' : `partner_id IN (${ids.map(() => '?').join(', ')})`;
      return {
        sql: `${grain.orderIdExpr} IN (SELECT id FROM wms_order WHERE workspace_id = ? AND ${match})`,
        args: [workspaceId, ...ids],
      };
    }
    return idMatch(grain.partnerIdExpr, ids);
  }
  return null;
}

function namePredicate(workspaceId: string, grain: GrainSpec, field: FieldSpec, op: string, value: string): Predicate | null {
  if (field.id !== 'partner.name' || (op !== 'eq' && op !== 'contains') || !grain.partnerIdExpr) return null;
  const compare = op === 'contains' ? `name LIKE ? ESCAPE '\\'` : 'name = ?';
  const bound = op === 'contains' ? likeContains(value) : value;
  const inner = `SELECT id FROM wms_partner WHERE workspace_id = ? AND ${compare}`;
  if (grain.id === 'ledger' && grain.orderIdExpr) {
    return {
      sql: `${grain.orderIdExpr} IN (SELECT id FROM wms_order WHERE workspace_id = ? AND partner_id IN (${inner}))`,
      args: [workspaceId, workspaceId, bound],
    };
  }
  return {
    sql: `${grain.partnerIdExpr} IN (${inner})`,
    args: [workspaceId, bound],
  };
}

function comparePredicate(field: FieldSpec, op: string, value: string | number | Array<string | number>): Predicate {
  const sql = field.sql;
  if (op === 'in' && Array.isArray(value)) {
    return { sql: `${sql} IN (${value.map(() => '?').join(', ')})`, args: value };
  }
  if (op === 'contains') {
    return { sql: `${sql} LIKE ? ESCAPE '\\'`, args: [likeContains(String(value))] };
  }
  if (op === 'neq') {
    return { sql: `(${sql} IS NULL OR ${sql} <> ?)`, args: [value] };
  }
  if (field.type === 'date' && typeof value === 'string' && isReportDay(value)) {
    const next = nextUtcDay(value);
    if (!next) throw new ReportInvalidError(`日期无效：${value}`);
    if (op === 'eq') return { sql: `(${sql} >= ? AND ${sql} < ?)`, args: [value, next] };
    if (op === 'lte') return { sql: `${sql} < ?`, args: [next] };
    if (op === 'gt') return { sql: `${sql} >= ?`, args: [next] };
  }
  const cmp = op === 'eq' ? '=' : op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<=';
  return { sql: `${sql} ${cmp} ?`, args: [value] };
}

function predicateFor(
  db: Database.Database,
  workspaceId: string,
  grain: GrainSpec,
  filter: BoundFilter,
): Predicate | 'empty' {
  const value = filter.value;
  const looked = lookupPredicate(db, workspaceId, grain, filter.field, filter.op, value);
  if (looked === 'empty') return 'empty';
  if (looked) return looked;
  if (typeof value === 'string') {
    const named = namePredicate(workspaceId, grain, filter.field, filter.op, value);
    if (named) return named;
  }
  return comparePredicate(filter.field, filter.op, value);
}

function driveFromOrder(grain: GrainSpec, filters: BoundFilter[]): boolean {
  if (!grain.fromOrder) return false;
  const sku = filters.some((filter) => filter.field.lookup === 'skuCode' && (filter.op === 'eq' || filter.op === 'in'));
  const onHeader = filters.some(
    (filter) => filter.field.selective && filter.field.lookup !== 'skuCode' && filter.field.id !== 'sku.skuCode',
  );
  return onHeader && !sku;
}

/** 编译一张明细表。empty 表示收窄条件对不上任何主数据，调用方直接给空页。 */
export function compileReportQuery(
  db: Database.Database,
  workspaceId: string,
  section: ReportSection,
  parameters: ReportParameter[],
  supplied: Record<string, unknown>,
  page: { limit: number; offset: number },
): CompiledReportQuery {
  const grain = reportGrain(section.grain);
  if (!grain) throw new ReportInvalidError(`粒度 ${section.grain} 不存在`);
  const byKey = new Map(parameters.map((param) => [param.key, param]));
  const columns: ReportColumn[] = section.columns.map((id) => {
    const field = fieldOf(grain, id);
    if (!field) throw new ReportInvalidError(`字段 ${id} 不在${grain.label}上`);
    return { field: field.id, label: field.label, type: field.type };
  });
  const filters: BoundFilter[] = section.filters.map((filter) => {
    const field = fieldOf(grain, filter.field);
    if (!field) throw new ReportInvalidError(`条件字段 ${filter.field} 不存在`);
    return {
      field,
      op: filter.op,
      value: bindValue(filter.value, byKey, supplied),
    };
  });
  const select = columns
    .map((column, index) => `${fieldOf(grain, column.field)!.sql} AS c${index}`)
    .join(', ');
  const fromOrder = driveFromOrder(grain, filters);
  const from = fromOrder ? grain.fromOrder! : grain.fromLine;
  const workspaceExpr = fromOrder ? grain.workspaceOrder! : grain.workspaceLine;
  const where: string[] = [`${workspaceExpr} = ?`];
  const args: unknown[] = [workspaceId];
  for (const filter of filters) {
    const pred = predicateFor(db, workspaceId, grain, filter);
    if (pred === 'empty') return { sql: '', args: [], columns, empty: true };
    where.push(pred.sql);
    args.push(...pred.args);
  }
  const sortField = section.sort ? fieldOf(grain, section.sort.field) : fieldOf(grain, grain.defaultSort.field);
  const sortDir = section.sort?.dir === 'asc' || (!section.sort && grain.defaultSort.dir === 'asc') ? 'ASC' : 'DESC';
  if (!sortField) throw new ReportInvalidError('排序字段不存在');
  const sql = `SELECT ${select}
${from}
WHERE ${where.join(' AND ')}
ORDER BY ${sortField.sql} ${sortDir}, ${grain.tieBreak}
LIMIT ? OFFSET ?`;
  args.push(page.limit + 1, page.offset);
  return { sql, args, columns, empty: false };
}

export function clampReportPage(limit: unknown, offset: unknown, max: number): { limit: number; offset: number } {
  const size = limit === undefined ? Math.min(50, max) : Number(limit);
  const skip = offset === undefined ? 0 : Number(offset);
  if (!Number.isInteger(size) || size < 1 || size > max) {
    throw new ReportInvalidError(`limit 须为 1 到 ${max} 的整数`);
  }
  if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) {
    throw new ReportInvalidError('offset 须为 0 到 100000 的整数');
  }
  return { limit: size, offset: skip };
}

export function runReportSection(
  db: Database.Database,
  workspaceId: string,
  section: ReportSection,
  parameters: ReportParameter[],
  supplied: Record<string, unknown>,
  page: { limit: number; offset: number },
): ReportRunPage {
  const compiled = compileReportQuery(db, workspaceId, section, parameters, supplied, page);
  if (compiled.empty) {
    return { columns: compiled.columns, rows: [], limit: page.limit, offset: page.offset, hasMore: false };
  }
  const raw = db.prepare(compiled.sql).all(...compiled.args) as Array<Record<string, string | number | null>>;
  const hasMore = raw.length > page.limit;
  const sliced = hasMore ? raw.slice(0, page.limit) : raw;
  const rows = sliced.map((row) => {
    const out: Record<string, string | number | null> = {};
    compiled.columns.forEach((column, index) => {
      const value = row[`c${index}`];
      out[column.field] = value === undefined ? null : value;
    });
    return out;
  });
  return { columns: compiled.columns, rows, limit: page.limit, offset: page.offset, hasMore };
}

export function runSavedSection(
  db: Database.Database,
  workspaceId: string,
  definition: ReportDefinition,
  sectionId: string,
  supplied: Record<string, unknown>,
  page: { limit: number; offset: number },
): ReportRunPage {
  const section = definition.sections.find((item) => item.id === sectionId);
  if (!section) throw new ReportInvalidError(`报表里没有表 ${sectionId}`);
  return runReportSection(db, workspaceId, section, definition.parameters, supplied, page);
}
