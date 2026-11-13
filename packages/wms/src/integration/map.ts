/**
 * 连接器映射。纯函数。
 * 入站：对方一笔报文 → 工具参数。出站：规范快照 → 对方报文。
 * 不发 HTTP，不读密钥，不写账本。编码对照由调用方传入。
 */

import { DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { INBOUND_SHAPE, isInboundCanonical } from './allowlist.js';
import type { CodeLookup, DateForm, FieldMap, LineMap, MapResult, Route, ValueSource } from './types.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const YMD_RE = /^(\d{4})(\d{2})(\d{2})$/;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function outboundMatches(route: Route, snapshot: unknown, link: { hasLink: boolean }): boolean {
  if (route.direction !== 'out' || !route.enabled || !route.outbound) return false;
  if (route.outbound.requireLink && !link.hasLink) return false;
  const when = route.outbound.when;
  if (!when) return true;
  const read = readPath(snapshot, when.path);
  return read.ok && read.found && read.value === when.eq;
}

export function applyMapping(route: Route, source: unknown, codes: CodeLookup): MapResult {
  if (!isPlainObject(source)) return fail('MAP_SOURCE', '报文不是对象');
  const target: Record<string, unknown> = {};
  const inbound = route.direction === 'in' && isInboundCanonical(route.canonical) ? INBOUND_SHAPE[route.canonical] : undefined;

  for (const field of route.mapping.fields) {
    const placed = placeField(source, field, route.direction, codes, inbound?.required.includes(field.to) ?? route.direction === 'out');
    if (!placed.ok) return placed;
    if (placed.skip) continue;
    const invalid = checkValue(field.to, placed.value);
    if (invalid) return fail(invalid.code, invalid.message, field.to);
    const error = assign(target, field.to, placed.value);
    if (error) return fail('MAP_VALUE', error, field.to);
  }

  if (route.mapping.lines) {
    const lines = mapLines(source, route.mapping.lines, route, codes);
    if (!lines.ok) return lines;
    const error = assign(target, route.mapping.lines.to, lines.value);
    if (error) return fail('MAP_VALUE', error, route.mapping.lines.to);
  } else if (inbound?.lines) {
    return fail('MAP_LINES', '建单必须有明细', 'lines');
  }

  if (route.canonical === 'order.create' && Array.isArray(target.lines)) {
    for (const line of target.lines) {
      if (isPlainObject(line) && line.locationCode === undefined) line.locationCode = DEFAULT_LOCATION_ID;
    }
  }

  const missing = missingRequired(target, inbound);
  if (missing) return fail('MAP_MISSING', `缺少 ${missing}`, missing);
  return { ok: true, value: target };
}

function mapLines(
  source: unknown,
  lines: LineMap,
  route: Route,
  codes: CodeLookup,
): { ok: true; value: Record<string, unknown>[] } | MapResult {
  const read = readPath(source, lines.from);
  if (!read.ok) return fail('MAP_LINES', read.message, lines.from);
  if (!read.found || read.value == null) return fail('MAP_MISSING', `缺少明细 ${lines.from}`, lines.from);
  if (!Array.isArray(read.value)) return fail('MAP_LINES', '明细不是数组', lines.from);
  if (read.value.length === 0) return fail('MAP_LINES', '明细不能为空', lines.from);

  const inbound = route.direction === 'in' && isInboundCanonical(route.canonical) ? INBOUND_SHAPE[route.canonical] : undefined;
  const required = new Set(inbound?.lineRequired ?? []);
  const mapped: Record<string, unknown>[] = [];
  for (const [index, item] of read.value.entries()) {
    if (!isPlainObject(item)) return fail('MAP_LINES', `第 ${index + 1} 行不是对象`, lines.from);
    const row: Record<string, unknown> = {};
    for (const field of lines.item) {
      const requiredField = required.has(field.to) || route.direction === 'out';
      const placed = placeField(item, field, route.direction, codes, requiredField);
      if (!placed.ok) {
        return fail(placed.code, `第 ${index + 1} 行：${placed.message}`, placed.path ?? field.to);
      }
      if (placed.skip) continue;
      const error = checkValue(field.to, placed.value);
      if (error) return fail(error.code, `第 ${index + 1} 行：${error.message}`, field.to);
      const assignError = assign(row, field.to, placed.value);
      if (assignError) return fail('MAP_VALUE', assignError, field.to);
    }
    for (const name of required) {
      if (row[name] === undefined) return fail('MAP_MISSING', `第 ${index + 1} 行缺少 ${name}`, name);
    }
    mapped.push(row);
  }
  return { ok: true, value: mapped };
}

type Placed =
  | { ok: true; skip: true }
  | { ok: true; skip: false; value: unknown }
  | { ok: false; code: string; message: string; path?: string };

function placeField(source: unknown, field: FieldMap, direction: 'in' | 'out', codes: CodeLookup, required: boolean): Placed {
  const resolved = resolve(source, field.from, direction, codes);
  if (!resolved.ok) return resolved;
  if (!resolved.present) {
    if (required) return fail('MAP_MISSING', `缺少 ${field.to}`, field.to);
    return { ok: true, skip: true };
  }
  if (typeof resolved.value === 'string' && resolved.value.trim() === '') {
    if (required) return fail('MAP_VALUE', `${field.to} 不能是空串`, field.to);
    return { ok: true, skip: true };
  }
  return { ok: true, skip: false, value: resolved.value };
}

function checkValue(name: string, value: unknown): { code: string; message: string } | undefined {
  if (name === 'quantity') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { code: 'MAP_NUMBER', message: '数量必须是正数' };
    }
  }
  if (name === 'reorderPoint') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { code: 'MAP_NUMBER', message: '安全库存必须是大于等于 0 的整数' };
    }
  }
  if (name === 'batchExpiryDate' && (typeof value !== 'string' || !isUtcDate(value))) {
    return { code: 'MAP_DATE', message: '效期必须是 YYYY-MM-DD' };
  }
  if ((name === 'direction' || name === 'kind' || name === 'orderNo' || name === 'skuCode' || name === 'partnerCode' || name === 'name' || name === 'to') && typeof value !== 'string') {
    return { code: 'MAP_VALUE', message: `${name} 必须是字符串` };
  }
  return undefined;
}

function missingRequired(target: Record<string, unknown>, inbound: { required: readonly string[] } | undefined): string | undefined {
  if (!inbound) return undefined;
  return inbound.required.find((name) => target[name] === undefined);
}

type Resolved =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false; code: string; message: string; path?: string };

function resolve(source: unknown, from: ValueSource, direction: 'in' | 'out', codes: CodeLookup): Resolved {
  if (from.op === 'const') {
    if (from.value === null) return { ok: true, present: false };
    return { ok: true, present: true, value: from.value };
  }
  if (from.op === 'template') return resolveTemplate(source, from.template);
  const read = readPath(source, from.path);
  if (!read.ok) return fail('MAP_SOURCE', read.message, from.path);
  const absent = !read.found || read.value == null;
  if (from.op === 'path') {
    if (absent) return { ok: true, present: false };
    return { ok: true, present: true, value: read.value };
  }
  if (from.op === 'number') {
    if (absent) return { ok: true, present: false };
    const parsed = parseNumber(read.value);
    if (parsed === undefined) return fail('MAP_NUMBER', `${from.path} 不是数字`, from.path);
    return { ok: true, present: true, value: parsed };
  }
  if (from.op === 'enum') {
    if (absent) return fail('MAP_ENUM', `${from.path} 没有值`, from.path);
    const key = enumKey(read.value);
    if (key === undefined || !Object.hasOwn(from.map, key)) {
      return fail('MAP_ENUM', `${from.path} 的值不在对照表里`, from.path);
    }
    return { ok: true, present: true, value: from.map[key] };
  }
  if (from.op === 'date') {
    if (absent) return { ok: true, present: false };
    const parsed = parseDate(read.value, from.from);
    if (!parsed) return fail('MAP_DATE', `${from.path} 不是 ${from.from} 日期`, from.path);
    return { ok: true, present: true, value: formatDate(parsed, from.to) };
  }
  if (absent) return { ok: true, present: false };
  if (typeof read.value !== 'string' || read.value.trim() === '') {
    return fail('MAP_CODE', `${from.path} 不是编码`, from.path);
  }
  const internal = codes.resolve(from.entity, read.value.trim(), direction);
  if (!internal) {
    const side = direction === 'in' ? '对方编码' : '内部编码';
    return fail('MAP_CODE', `编码表没有 ${from.entity} 的${side} ${read.value.trim()}`, from.path);
  }
  return { ok: true, present: true, value: internal };
}

function resolveTemplate(source: unknown, template: string): Resolved {
  let failed: Resolved | undefined;
  const text = template.replace(/\{([^{}]+)\}/g, (_all, inner: string) => {
    if (failed) return '';
    const read = readPath(source, inner);
    if (!read.ok || !read.found || read.value == null) {
      failed = fail('MAP_TEMPLATE', `模板缺少 {${inner}}`, inner);
      return '';
    }
    if (typeof read.value === 'string' || typeof read.value === 'number' || typeof read.value === 'boolean') {
      return String(read.value);
    }
    failed = fail('MAP_TEMPLATE', `{${inner}} 不是可以拼进文本的值`, inner);
    return '';
  });
  if (failed) return failed;
  return { ok: true, present: true, value: text };
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && NUMBER_RE.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function enumKey(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function parseDate(value: unknown, from: DateForm): Date | undefined {
  if (from === 'unixMs' || from === 'unixSec') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
    if (n === undefined || !Number.isFinite(n)) return undefined;
    return new Date(from === 'unixSec' ? n * 1000 : n);
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (from === 'iso8601') {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? undefined : new Date(parsed);
  }
  if (from === 'date') return utcDate(text, DATE_RE);
  if (from === 'yyyyMMdd') {
    const match = YMD_RE.exec(text);
    if (!match) return undefined;
    return utcParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (from === 'yyyy-MM-dd HH:mm:ss') {
    const match = STAMP_RE.exec(text);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute ||
      date.getUTCSeconds() !== second
    ) {
      return undefined;
    }
    return date;
  }
  return undefined;
}

function utcDate(text: string, pattern: RegExp): Date | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return utcParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

function utcParts(year: number, month: number, day: number): Date | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date;
}

function formatDate(date: Date, to: DateForm): string | number {
  if (to === 'unixMs') return date.getTime();
  if (to === 'unixSec') return Math.floor(date.getTime() / 1000);
  const iso = date.toISOString();
  if (to === 'date') return iso.slice(0, 10);
  if (to === 'yyyyMMdd') return iso.slice(0, 10).replaceAll('-', '');
  if (to === 'yyyy-MM-dd HH:mm:ss') return iso.slice(0, 19).replace('T', ' ');
  return iso;
}

function isUtcDate(value: string): boolean {
  return utcDate(value, DATE_RE) !== undefined;
}

type Read = { ok: true; found: boolean; value?: unknown } | { ok: false; message: string };

function readPath(root: unknown, path: string): Read {
  let cursor = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return { ok: false, message: `路径 ${path} 中间不是对象` };
    if (!Object.hasOwn(cursor, segment)) return { ok: true, found: false };
    cursor = cursor[segment];
  }
  return { ok: true, found: true, value: cursor };
}

function assign(target: Record<string, unknown>, path: string, value: unknown): string | undefined {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] ?? '';
    const next = cursor[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
      continue;
    }
    if (!isPlainObject(next)) return `路径 ${path} 中间不是对象`;
    cursor = next;
  }
  cursor[parts[parts.length - 1] ?? ''] = value;
  return undefined;
}

function fail(code: string, message: string, path?: string): {
  ok: false;
  code: string;
  message: string;
  path?: string;
} {
  return { ok: false, code, message, ...(path ? { path } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
