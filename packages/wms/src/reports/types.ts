/**
 * 报表定义。一份报表是几张明细表；每张表先定粒度，再从能连上的字段里选列和条件。
 * 条件的 value 可以是字面量，或指向报表参数的 { param }。
 */

export type ReportValueType = 'text' | 'number' | 'date';

export type ReportFilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface ReportParameter {
  key: string;
  label: string;
  type: ReportValueType;
}

/** 字面量，或运行时再填的参数引用 */
export type ReportFilterValue =
  | string
  | number
  | { param: string }
  | Array<string | number>;

export interface ReportFilter {
  field: string;
  op: ReportFilterOp;
  value: ReportFilterValue;
}

export interface ReportSort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface ReportSection {
  id: string;
  title: string;
  grain: string;
  columns: string[];
  filters: ReportFilter[];
  sort?: ReportSort;
}

export interface ReportDefinition {
  title: string;
  note?: string;
  parameters: ReportParameter[];
  sections: ReportSection[];
}

export interface ReportFieldInfo {
  id: string;
  label: string;
  type: ReportValueType;
  /** 这个字段上的收窄条件可以让单据行 / 流水先走索引 */
  selective?: boolean;
}

export interface ReportGrainInfo {
  id: string;
  label: string;
  /** 一行是什么 */
  row: string;
  requireSelective: boolean;
  fields: ReportFieldInfo[];
}

export interface ReportCatalog {
  grains: ReportGrainInfo[];
  filterOps: Record<ReportValueType, ReportFilterOp[]>;
  notes: string[];
}
