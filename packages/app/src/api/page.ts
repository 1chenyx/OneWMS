import { useState } from 'react';
import { setListPageSize, useListPageSize } from '../components/table-style';
import type { ListPage } from '@one/wms/page';

/** 分页壳直接复用服务端 wms 的定义，避免两边字段漂移。不传 limit 时接口仍返回数组。 */
export type { ListPage };

export function isListPage<T>(data: T[] | ListPage<T> | undefined): data is ListPage<T> {
  return !!data && !Array.isArray(data) && Array.isArray(data.rows);
}

export function rowsOf<T>(data: T[] | ListPage<T> | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : data.rows;
}

export function totalOf<T>(data: T[] | ListPage<T> | undefined): number {
  if (!data) return 0;
  return Array.isArray(data) ? data.length : data.total;
}

/**
 * 清单页码。筛选条件或每页条数变化时回到第 1 页。
 * 条件在本次渲染里变了，请求用 1，不等下一次渲染。
 * 每页条数跟其它清单共用，并记在本地。
 */
export function useListPage(resetKey: string): {
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  limit: number;
  offset: number;
  onChange: (page: number, pageSize: number) => void;
} {
  const pageSize = useListPageSize();
  const [page, setPage] = useState(1);
  const [key, setKey] = useState(resetKey);
  const [seenSize, setSeenSize] = useState(pageSize);
  const reset = key !== resetKey || seenSize !== pageSize;
  if (reset) {
    setKey(resetKey);
    setSeenSize(pageSize);
    setPage(1);
  }
  const current = reset ? 1 : page;
  return {
    page: current,
    setPage,
    pageSize,
    limit: pageSize,
    offset: (current - 1) * pageSize,
    onChange: (nextPage, nextSize) => {
      if (nextSize !== pageSize) {
        setListPageSize(nextSize);
        setPage(1);
        return;
      }
      setPage(nextPage);
    },
  };
}
