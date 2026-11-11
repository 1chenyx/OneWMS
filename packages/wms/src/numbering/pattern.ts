/**
 * 编号模板。纯函数，不读库。
 * 界面用同一份记号做即时示例（vite 把本文件打进前端）。
 *
 * 记号：{yyyy} {yy} {MM} {dd} {yyyyMMdd} {seq} {seq:位数}
 * 必须有且只有一个序号。写了日就按天重新计数，只写到月按月，只写年按年，都不写就一直累加。
 */

export const RESET_LABEL = {
  day: '每天重新计数',
  month: '每月重新计数',
  year: '每年重新计数',
  never: '一直累加',
} as const;

export type ResetScope = keyof typeof RESET_LABEL;

export const NUMBERING_PLACES = [
  { id: 'order.in', label: '入库单', group: '作业', fallback: 'IN-{yyyyMMdd}-{seq:4}' },
  { id: 'order.out', label: '出库单', group: '作业', fallback: 'OUT-{yyyyMMdd}-{seq:4}' },
  { id: 'order.asn', label: '到货预报', group: '作业', fallback: 'ASN-{yyyyMMdd}-{seq:4}' },
  { id: 'order.return.in', label: '客退单', group: '作业', fallback: 'RT-{yyyyMMdd}-{seq:4}' },
  { id: 'order.return.out', label: '退供单', group: '作业', fallback: 'RTS-{yyyyMMdd}-{seq:4}' },
  { id: 'picking', label: '拣货单', group: '作业', fallback: 'PK-{yyyyMMdd}-{seq:3}' },
  { id: 'wave', label: '波次', group: '作业', fallback: 'WV-{yyyyMMdd}-{seq:3}' },
  { id: 'stocktake', label: '盘点单', group: '作业', fallback: 'ST-{yyyyMMdd}-{seq:3}' },
  { id: 'sku', label: '商品', group: '档案', fallback: 'SKU-{seq:5}' },
  { id: 'partner.supplier', label: '供应商', group: '档案', fallback: 'SUP-{seq:4}' },
  { id: 'partner.customer', label: '客户', group: '档案', fallback: 'CUS-{seq:4}' },
  { id: 'location', label: '库位', group: '档案', fallback: 'LOC-{seq:4}' },
  { id: 'warehouse', label: '仓库', group: '档案', fallback: 'WH-{seq:2}' },
  { id: 'lpn', label: '托盘', group: '档案', fallback: 'LPN-{seq:4}' },
] as const;

export type NumberPlaceId = (typeof NUMBERING_PLACES)[number]['id'];
export type NumberGroup = (typeof NUMBERING_PLACES)[number]['group'];

const PLACE_IDS = new Set<string>(NUMBERING_PLACES.map((place) => place.id));

export function isNumberPlace(value: string): value is NumberPlaceId {
  return PLACE_IDS.has(value);
}

/** 单据用哪一条规则。预报只对入库；退货按开出的方向。 */
export function orderNumberPlace(input: {
  direction: 'in' | 'out';
  asn?: boolean;
  returnOf?: boolean;
}): NumberPlaceId {
  if (input.returnOf) return input.direction === 'in' ? 'order.return.in' : 'order.return.out';
  if (input.asn && input.direction === 'in') return 'order.asn';
  return input.direction === 'in' ? 'order.in' : 'order.out';
}

type DateToken = 'yyyy' | 'yy' | 'MM' | 'dd' | 'yyyyMMdd';

type Part =
  | { kind: 'lit'; text: string }
  | { kind: DateToken }
  | { kind: 'seq'; width: number };

export interface CompiledPattern {
  source: string;
  reset: ResetScope;
  parts: Part[];
}

export type CompileResult = { ok: true; pattern: CompiledPattern } | { ok: false; error: string };

const DATE_TOKENS = new Set<string>(['yyyy', 'yy', 'MM', 'dd', 'yyyyMMdd']);

export function compilePattern(raw: string): CompileResult {
  const source = raw.trim();
  if (!source) return { ok: false, error: '编号模板不能为空' };
  if (source.length > 80) return { ok: false, error: '编号模板不能超过 80 个字符' };
  if (/\s/.test(source)) return { ok: false, error: '编号模板不能含空白' };

  const parts: Part[] = [];
  let seqCount = 0;
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '{') {
      let j = i;
      while (j < source.length && source[j] !== '{') j += 1;
      const text = source.slice(i, j);
      if (text.includes('}')) return { ok: false, error: '编号模板里有未成对的 }' };
      parts.push({ kind: 'lit', text });
      i = j;
      continue;
    }
    const end = source.indexOf('}', i);
    if (end < 0) return { ok: false, error: '编号模板里有未闭合的 {' };
    const token = source.slice(i + 1, end);
    const seq = /^seq(?::([1-8]))?$/.exec(token);
    if (seq) {
      seqCount += 1;
      parts.push({ kind: 'seq', width: seq[1] ? Number(seq[1]) : 4 });
    } else if (DATE_TOKENS.has(token)) {
      parts.push({ kind: token as DateToken });
    } else {
      return {
        ok: false,
        error: `不认识的记号 {${token}}。可用 {yyyy} {yy} {MM} {dd} {yyyyMMdd} {seq} {seq:位数}`,
      };
    }
    i = end + 1;
  }
  if (seqCount !== 1) return { ok: false, error: '编号模板必须有且只有一个 {seq} 或 {seq:位数}' };

  const hasDay = parts.some((part) => part.kind === 'dd' || part.kind === 'yyyyMMdd');
  const hasMonth = parts.some((part) => part.kind === 'MM' || part.kind === 'yyyyMMdd');
  const hasYear = parts.some((part) => part.kind === 'yyyy' || part.kind === 'yy' || part.kind === 'yyyyMMdd');
  const reset: ResetScope = hasDay ? 'day' : hasMonth ? 'month' : hasYear ? 'year' : 'never';
  return { ok: true, pattern: { source, reset, parts } };
}

function dateParts(now: Date) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return {
    yyyy: String(year),
    yy: String(year).slice(-2),
    MM: month,
    dd: day,
    yyyyMMdd: `${year}${month}${day}`,
  };
}

export function renderNumber(pattern: CompiledPattern, seq: number, now: Date): string {
  const dates = dateParts(now);
  return pattern.parts
    .map((part) => {
      if (part.kind === 'lit') return part.text;
      if (part.kind === 'seq') return String(seq).padStart(part.width, '0');
      return dates[part.kind];
    })
    .join('');
}

function escapeReg(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 这个号在当前计数周期里对应的序号。对不上当前周期则返回 null。 */
export function seqInCode(pattern: CompiledPattern, code: string, now: Date): number | null {
  const dates = dateParts(now);
  let source = '^';
  for (const part of pattern.parts) {
    if (part.kind === 'lit') source += escapeReg(part.text);
    else if (part.kind === 'seq') source += '(\\d+)';
    else source += escapeReg(dates[part.kind]);
  }
  source += '$';
  const matched = new RegExp(source).exec(code);
  if (!matched?.[1]) return null;
  const seq = Number(matched[1]);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  return seq;
}

/** 在已有编号上取下一号。已经占用的号会跳过，不覆盖。 */
export function nextFromExisting(pattern: CompiledPattern, existing: Iterable<string>, now = new Date()): string {
  let max = 0;
  const taken = new Set<string>();
  for (const code of existing) {
    taken.add(code);
    const seq = seqInCode(pattern, code, now);
    if (seq !== null && seq > max) max = seq;
  }
  let seq = max + 1;
  for (let i = 0; i < 10000; i += 1) {
    const value = renderNumber(pattern, seq, now);
    if (!taken.has(value)) return value;
    seq += 1;
  }
  throw new Error('编号已经用尽，请改模板或加大序号位数');
}

export interface ResolvedPlace {
  id: NumberPlaceId;
  label: string;
  group: NumberGroup;
  /** 实际用来发号的模板。非法配置已回落内置模板。 */
  pattern: string;
  /** 存下来的原文。没存过是 null。 */
  configured: string | null;
  invalid: string | null;
  reset: ResetScope;
}

export interface NumberingRules {
  stored: boolean;
  patchOp: 'add' | 'replace';
  byId: Record<NumberPlaceId, ResolvedPlace>;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读 core.wms settings.numbering。缺键、脏值都回落内置模板，不抛错。 */
export function readNumbering(settings: Record<string, unknown> | undefined): NumberingRules {
  const stored = !!settings && Object.hasOwn(settings, 'numbering');
  const raw = stored ? settings.numbering : undefined;
  const obj = isPlain(raw) ? raw : {};
  const byId = {} as Record<NumberPlaceId, ResolvedPlace>;
  for (const place of NUMBERING_PLACES) {
    const configured = typeof obj[place.id] === 'string' ? (obj[place.id] as string) : null;
    const compiled = configured === null ? null : compilePattern(configured);
    const ok = compiled?.ok === true ? compiled.pattern : null;
    const fallback = compilePattern(place.fallback);
    if (!fallback.ok) throw new Error(`内置编号模板不可用：${place.id}`);
    const used = ok ?? fallback.pattern;
    byId[place.id] = {
      id: place.id,
      label: place.label,
      group: place.group,
      pattern: used.source,
      configured,
      invalid: compiled && !compiled.ok ? compiled.error : null,
      reset: used.reset,
    };
  }
  return { stored, patchOp: stored ? 'replace' : 'add', byId };
}

/** 给界面看的示例：序号取 1，日期取今天。 */
export function sampleNumber(source: string, now = new Date()): { ok: true; sample: string; reset: ResetScope } | { ok: false; error: string } {
  const compiled = compilePattern(source);
  if (!compiled.ok) return compiled;
  return { ok: true, sample: renderNumber(compiled.pattern, 1, now), reset: compiled.pattern.reset };
}
