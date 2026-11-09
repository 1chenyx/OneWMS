import type { CSSProperties } from 'react';
import type { TablePaginationConfig } from 'antd';

/**
 * 表格视觉规范——清单页共用：
 *  - 编码/单号/条码/批次/库位等机器标识列用等宽字体（字符对齐，扫读不易错位）；
 *  - 数量类列右对齐 + tabular-nums（等宽数字，纵向可比）；
 *  - 分页 50/页，分页条始终在（共 N 条，可以翻页）。
 * 主清单走服务端（serverPagination）；数据已经在手里的表用 TABLE_PAGINATION。
 * 用法：列上 onCell: monoCell / onCell: numCell。
 */

/** 等宽字体（机器标识列） */
export const MONO_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace",
};

/** 等宽数字（数量列，配合 align: 'right'） */
export const NUM_STYLE: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/** 清单页每页条数。服务端分页和仍走全量的表共用这一个数。 */
export const LIST_PAGE_SIZE = 50;

const pageShared = {
  pageSize: LIST_PAGE_SIZE,
  hideOnSinglePage: false,
  showSizeChanger: false,
  showTotal: (total: number) => `共 ${total} 条`,
};

/** 数据已经在手里时的客户端分页（盘点、拣货、效期、导入预览、聊天结果等）。 */
export const TABLE_PAGINATION: TablePaginationConfig = pageShared;

/** antd List 的分页类型和 Table 不通用，字段与 TABLE_PAGINATION 相同。 */
export const LIST_PAGINATION = pageShared;

/** 服务端已经按页返回时用。total 大于当前页行数时，表格不再自行切片。 */
export function serverPagination(opts: {
  current: number;
  total: number;
  onChange: (page: number) => void;
}): TablePaginationConfig {
  return {
    current: opts.current,
    pageSize: LIST_PAGE_SIZE,
    total: opts.total,
    hideOnSinglePage: false,
    showSizeChanger: false,
    showTotal: (total) => `共 ${total} 条`,
    onChange: opts.onChange,
  };
}

/** onCell 快捷引用（等宽标识列） */
export const monoCell = () => ({ style: MONO_STYLE });

/** onCell 快捷引用（数字列） */
export const numCell = () => ({ style: NUM_STYLE });

/** 打印区表头单元格（A1 单据打印）：屏幕预览与纸张同一套细边框 */
export const printTh: CSSProperties = {
  border: '1px solid #333',
  padding: '4px 6px',
  textAlign: 'left',
  background: '#f5f5f5',
};

/** 打印区数据单元格（A1 单据打印） */
export const printTd: CSSProperties = { border: '1px solid #333', padding: '4px 6px' };
