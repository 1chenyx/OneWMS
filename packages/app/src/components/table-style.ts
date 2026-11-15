import { useEffect, useState, type CSSProperties } from 'react';

/**
 * 表格视觉规范——清单页共用：
 *  - 编码/单号/条码/批次/库位等机器标识列用等宽字体（字符对齐，扫读不易错位）；
 *  - 数量类列右对齐 + tabular-nums（等宽数字，纵向可比）；
 *  - 默认 10 条/页，分页条上可以改成 20 或 50。分页条始终在（共 N 条）。
 * 主清单走服务端（serverPagination）；数据已经在手里的表用 useClientPagination。
 * 用法：列上 onCell: monoCell / onCell: numCell。
 */

/** 等宽字体（机器标识列） */
export const MONO_STYLE: CSSProperties = {
  fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace',
  fontVariantNumeric: 'tabular-nums',
};

/** 等宽数字（数量列，配合 align: 'right'） */
export const NUM_STYLE: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/** 清单默认每页条数。10 行在常见窗口里一页能看完，不用再滚表格。 */
export const LIST_PAGE_SIZE = 10;

/** 分页条上的可选项。各清单共用，存在本地。 */
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export type ListPageSize = (typeof PAGE_SIZE_OPTIONS)[number];

const PAGE_SIZE_KEY = 'onewms.listPageSize';

function isListPageSize(n: number): n is ListPageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n);
}

/** 本次会话里改过的条数。localStorage 写失败时仍以它为准。 */
let memorySize: ListPageSize | null = null;

export function readListPageSize(): ListPageSize {
  if (memorySize !== null) return memorySize;
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if (isListPageSize(n)) return n;
  } catch {
    /* 无 localStorage 时用默认 */
  }
  return LIST_PAGE_SIZE;
}

const pageSizeListeners = new Set<() => void>();

/** 改每页条数。非法值忽略。各清单订阅后一起变，并回到第 1 页。 */
export function setListPageSize(size: number): void {
  if (!isListPageSize(size) || size === readListPageSize()) return;
  memorySize = size;
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    /* 写不进时 memorySize 仍生效 */
  }
  pageSizeListeners.forEach((fn) => fn());
}

export function useListPageSize(): ListPageSize {
  const [size, setSize] = useState(readListPageSize);
  useEffect(() => {
    const sync = () => setSize(readListPageSize());
    pageSizeListeners.add(sync);
    return () => {
      pageSizeListeners.delete(sync);
    };
  }, []);
  return size;
}

/** 表格和 List 都能接的分页字段。不带 position，两边的 position 类型对不上。 */
interface SharedPagination {
  current?: number;
  total?: number;
  pageSize: number;
  pageSizeOptions: number[];
  hideOnSinglePage: false;
  showSizeChanger: true;
  showTotal: (total: number) => string;
  onChange: (page: number, pageSize: number) => void;
}

function pageSizeConfig(pageSize: number, onChange: (page: number, pageSize: number) => void): SharedPagination {
  return {
    pageSize,
    pageSizeOptions: [...PAGE_SIZE_OPTIONS],
    hideOnSinglePage: false,
    showSizeChanger: true,
    showTotal: (total: number) => `共 ${total} 条`,
    onChange,
  };
}

/**
 * 数据已经在手里时的分页（盘点、拣货、效期、导入预览、聊天结果、记忆历史等）。
 * 页码由表格自己记；每页条数跟服务端清单共用。
 */
export function useClientPagination(): SharedPagination {
  const pageSize = useListPageSize();
  return pageSizeConfig(pageSize, (_page, nextSize) => {
    setListPageSize(nextSize);
  });
}

/** 服务端已经按页返回时用。total 大于当前页行数时，表格不再自行切片。 */
export function serverPagination(opts: {
  current: number;
  total: number;
  pageSize: number;
  onChange: (page: number, pageSize: number) => void;
}): SharedPagination {
  return {
    ...pageSizeConfig(opts.pageSize, opts.onChange),
    current: opts.current,
    total: opts.total,
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
