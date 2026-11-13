import { ReportInvalidError } from '../errors.js';
import {
  REPORT_COLUMN_MAX,
  REPORT_FILTER_MAX,
  REPORT_FILTER_OPS,
  REPORT_IN_MAX,
  REPORT_PARAM_MAX,
  REPORT_SECTION_MAX,
  fieldOf,
  isSelectiveFilter,
  reportGrain,
} from './catalog.js';
import type {
  ReportDefinition,
  ReportFilter,
  ReportFilterOp,
  ReportFilterValue,
  ReportParameter,
  ReportSection,
  ReportSort,
} from './types.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const FILTER_OPS = new Set<string>(['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte']);

export interface ValidReport {
  reportId?: string;
  definition: ReportDefinition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ReportInvalidError(`${label}必须是文字`);
  const trimmed = value.trim();
  if (!trimmed) throw new ReportInvalidError(`${label}不能为空`);
  if (trimmed.length > max) throw new ReportInvalidError(`${label}最长 ${max} 个字`);
  return trimmed;
}

/** 日历日的下一天。非法日期返回 null。 */
export function nextUtcDay(day: string): string | null {
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utc = Date.UTC(year, month - 1, date);
  const parsed = new Date(utc);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== date
  ) {
    return null;
  }
  const next = new Date(utc + 86_400_000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isReportDay(value: string): boolean {
  return nextUtcDay(value) !== null;
}

function dateLiteral(value: string, label: string): string {
  if (isReportDay(value) || STAMP_RE.test(value)) return value;
  throw new ReportInvalidError(`${label}要写成 YYYY-MM-DD`);
}

function parametersOf(value: unknown): ReportParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ReportInvalidError('parameters 必须是数组');
  if (value.length > REPORT_PARAM_MAX) throw new ReportInvalidError(`参数最多 ${REPORT_PARAM_MAX} 个`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ReportInvalidError(`参数 ${index + 1} 必须是对象`);
    const key = text(item.key, `参数 ${index + 1} 的 key`, 32);
    if (!KEY_RE.test(key)) throw new ReportInvalidError(`参数 ${key} 的 key 只能用小写字母、数字和下划线，并且以字母开头`);
    if (seen.has(key)) throw new ReportInvalidError(`参数 ${key} 重复了`);
    seen.add(key);
    const type = item.type;
    if (type !== 'text' && type !== 'number' && type !== 'date') {
      throw new ReportInvalidError(`参数 ${key} 的 type 只能是 text、number 或 date`);
    }
    return { key, label: text(item.label, `参数 ${key} 的名称`, 40), type };
  });
}

function paramRef(value: unknown, parameters: Map<string, ReportParameter>, expect: ReportParameter['type'], label: string): { param: string } {
  if (!isRecord(value) || typeof value.param !== 'string' || Object.keys(value).length !== 1) {
    throw new ReportInvalidError(`${label}要是字面量，或 { param: 参数key }`);
  }
  const key = value.param.trim();
  const param = parameters.get(key);
  if (!param) throw new ReportInvalidError(`${label}引用了不存在的参数 ${key}`);
  if (param.type !== expect) throw new ReportInvalidError(`参数 ${key} 是 ${param.type}，不能用于${label}`);
  return { param: key };
}

function literal(value: unknown, type: ReportParameter['type'], label: string): string | number {
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReportInvalidError(`${label}必须是数字`);
    return value;
  }
  if (typeof value !== 'string') throw new ReportInvalidError(`${label}必须是文字`);
  const trimmed = value.trim();
  if (!trimmed) throw new ReportInvalidError(`${label}不能为空`);
  if (trimmed.length > 200) throw new ReportInvalidError(`${label}最长 200 个字`);
  if (type === 'date') return dateLiteral(trimmed, label);
  return trimmed;
}

function filterValue(
  value: unknown,
  op: ReportFilterOp,
  type: ReportParameter['type'],
  parameters: Map<string, ReportParameter>,
  label: string,
): ReportFilterValue {
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > REPORT_IN_MAX) {
      throw new ReportInvalidError(`${label}的「属于」要给 1 到 ${REPORT_IN_MAX} 个值`);
    }
    return value.map((item, index) => literal(item, type, `${label}的第 ${index + 1} 个值`) as string | number);
  }
  if (isRecord(value)) return paramRef(value, parameters, type, label);
  return literal(value, type, label);
}

function sectionOf(value: unknown, index: number, parameters: Map<string, ReportParameter>): ReportSection {
  if (!isRecord(value)) throw new ReportInvalidError(`第 ${index + 1} 张表必须是对象`);
  const id = text(value.id, `第 ${index + 1} 张表的 id`, 32);
  if (!KEY_RE.test(id)) throw new ReportInvalidError(`表 ${id} 的 id 只能用小写字母、数字和下划线，并且以字母开头`);
  const title = text(value.title, `表 ${id} 的标题`, 80);
  const grainId = text(value.grain, `表 ${id} 的粒度`, 40);
  const grain = reportGrain(grainId);
  if (!grain) throw new ReportInvalidError(`表 ${id} 的粒度 ${grainId} 不存在。先看 wms.report.catalog`);
  if (!Array.isArray(value.columns) || value.columns.length === 0 || value.columns.length > REPORT_COLUMN_MAX) {
    throw new ReportInvalidError(`表 ${id} 要选 1 到 ${REPORT_COLUMN_MAX} 列`);
  }
  const columns: string[] = [];
  for (const column of value.columns) {
    if (typeof column !== 'string') throw new ReportInvalidError(`表 ${id} 的列要填字段 id，例如 sku.skuCode`);
    const fieldId = column.trim();
    if (!fieldOf(grain, fieldId)) throw new ReportInvalidError(`表 ${id} 没有字段 ${fieldId}`);
    if (columns.includes(fieldId)) throw new ReportInvalidError(`表 ${id} 的列 ${fieldId} 重复了`);
    columns.push(fieldId);
  }
  if (value.filters !== undefined && !Array.isArray(value.filters)) {
    throw new ReportInvalidError(`表 ${id} 的 filters 必须是数组`);
  }
  const rawFilters = (value.filters ?? []) as unknown[];
  if (rawFilters.length > REPORT_FILTER_MAX) throw new ReportInvalidError(`表 ${id} 的条件最多 ${REPORT_FILTER_MAX} 个`);
  const filters: ReportFilter[] = rawFilters.map((item, filterIndex) => {
    if (!isRecord(item)) throw new ReportInvalidError(`表 ${id} 的第 ${filterIndex + 1} 个条件必须是对象`);
    const fieldId = text(item.field, `表 ${id} 的条件字段`, 80);
    const field = fieldOf(grain, fieldId);
    if (!field) throw new ReportInvalidError(`表 ${id} 的条件字段 ${fieldId} 不存在`);
    if (typeof item.op !== 'string' || !FILTER_OPS.has(item.op)) {
      throw new ReportInvalidError(`表 ${id} 的条件 ${field.label} 用了不能识别的比较`);
    }
    const op = item.op as ReportFilterOp;
    if (!REPORT_FILTER_OPS[field.type].includes(op)) {
      throw new ReportInvalidError(`表 ${id} 的 ${field.label} 不能用这个比较`);
    }
    return {
      field: fieldId,
      op,
      value: filterValue(item.value, op, field.type, parameters, `表 ${id} 的 ${field.label}`),
    };
  });
  if (grain.requireSelective && !filters.some((filter) => isSelectiveFilter(fieldOf(grain, filter.field)!, filter.op))) {
    const names = grain.fields.filter((field) => field.selective).map((field) => field.label).join('、');
    throw new ReportInvalidError(`表 ${title} 要先收窄，请给这些字段里的至少一个加上条件：${names}`);
  }
  let sort: ReportSort | undefined;
  if (value.sort !== undefined) {
    if (!isRecord(value.sort)) throw new ReportInvalidError(`表 ${id} 的排序必须是对象`);
    const fieldId = text(value.sort.field, `表 ${id} 的排序字段`, 80);
    if (!fieldOf(grain, fieldId)) throw new ReportInvalidError(`表 ${id} 不能按 ${fieldId} 排序`);
    if (value.sort.dir !== 'asc' && value.sort.dir !== 'desc') {
      throw new ReportInvalidError(`表 ${id} 的排序方向只能是 asc 或 desc`);
    }
    sort = { field: fieldId, dir: value.sort.dir };
  }
  return { id, title, grain: grainId, columns, filters, ...(sort ? { sort } : {}) };
}

/** 把人和助手提交的对象收成一份可保存的报表。不合格直接拒绝。 */
export function validateReport(input: unknown): ValidReport {
  if (!isRecord(input)) throw new ReportInvalidError('报表必须是对象');
  let reportId: string | undefined;
  if (input.reportId !== undefined && input.reportId !== null && input.reportId !== '') {
    reportId = text(input.reportId, 'reportId', 64);
    if (!ID_RE.test(reportId)) throw new ReportInvalidError('reportId 只能含字母、数字、下划线和短横线');
  }
  const title = text(input.title, '标题', 80);
  const note = input.note === undefined || input.note === null || input.note === ''
    ? undefined
    : text(input.note, '说明', 400);
  const parameters = parametersOf(input.parameters);
  const byKey = new Map(parameters.map((param) => [param.key, param]));
  if (!Array.isArray(input.sections) || input.sections.length === 0 || input.sections.length > REPORT_SECTION_MAX) {
    throw new ReportInvalidError(`一份报表要有 1 到 ${REPORT_SECTION_MAX} 张表`);
  }
  const sections = input.sections.map((section, index) => sectionOf(section, index, byKey));
  const ids = new Set<string>();
  for (const section of sections) {
    if (ids.has(section.id)) throw new ReportInvalidError(`表 id ${section.id} 重复了`);
    ids.add(section.id);
  }
  const definition: ReportDefinition = {
    title,
    ...(note ? { note } : {}),
    parameters,
    sections,
  };
  if (JSON.stringify(definition).length > 48_000) throw new ReportInvalidError('报表定义太长');
  return { reportId, definition };
}

export interface PreviewRequest {
  parameters: ReportParameter[];
  section: ReportSection;
}

/** 不保存，只校验将要预览的那一张表。 */
export function validatePreview(input: unknown): PreviewRequest {
  if (!isRecord(input)) throw new ReportInvalidError('预览必须是对象');
  const wrapped = validateReport({
    title: '预览',
    parameters: input.parameters,
    sections: [input.section],
  });
  const section = wrapped.definition.sections[0];
  if (!section) throw new ReportInvalidError('预览缺少表');
  return { parameters: wrapped.definition.parameters, section };
}
