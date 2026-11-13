import { useState } from 'react';
import { LIST_PAGE_SIZE } from '../components/table-style';
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
 * 清单页码。筛选条件变化时回到第 1 页。
 * 条件在本次渲染里变了，请求用 1，不等下一次渲染。
 */
export function useListPage(resetKey: string): {
  page: number;
  setPage: (page: number) => void;
  limit: number;
  offset: number;
} {
  const [page, setPage] = useState(1);
  const [key, setKey] = useState(resetKey);
  const reset = key !== resetKey;
  if (reset) {
    setKey(resetKey);
    setPage(1);
  }
  const current = reset ? 1 : page;
  return {
    page: current,
    setPage,
    limit: LIST_PAGE_SIZE,
    offset: (current - 1) * LIST_PAGE_SIZE,
  };
}
