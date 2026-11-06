import type { CSSProperties } from 'react';
import type { TablePaginationConfig } from 'antd';

/**
 * 表格视觉规范（P1 界面优化）——五张清单页共用：
 *  - 编码/单号/条码/批次/库位等机器标识列用等宽字体（字符对齐，扫读不易错位）；
 *  - 数量类列右对齐 + tabular-nums（等宽数字，纵向可比）；
 *  - 统一客户端分页：50/页、单页隐藏（数据少时零噪音，超 50 自动出现）。
 * 用法：列上 onCell: monoCell / onCell: numCell；Table 上 pagination={TABLE_PAGINATION}。
 */

/** 等宽字体（机器标识列） */
export const MONO_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace",
};

/** 等宽数字（数量列，配合 align: 'right'） */
export const NUM_STYLE: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/** 统一分页配置（数据全量来自 hooks，客户端分页即可） */
export const TABLE_PAGINATION: TablePaginationConfig = {
  pageSize: 50,
  hideOnSinglePage: true,
  showTotal: (total) => `共 ${total} 条`,
};

/** onCell 快捷引用（等宽标识列） */
export const monoCell = () => ({ style: MONO_STYLE });

/** onCell 快捷引用（数字列） */
export const numCell = () => ({ style: NUM_STYLE });
