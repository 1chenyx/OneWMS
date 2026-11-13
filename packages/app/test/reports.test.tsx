import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import ReportsPage from '../src/pages/ReportsPage';
import type { ReportCatalog, ReportDraft, StoredReport } from '../src/api/wms-api';

/**
 * 报表页：先填参数再出表；新建时单据行默认带一个日期收窄。
 * 数据层整页 mock，这里只点页面。
 */

const catalog: ReportCatalog = {
  notes: [],
  filterOps: {
    text: ['eq', 'neq', 'contains', 'in'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
    date: ['eq', 'gt', 'gte', 'lt', 'lte'],
  },
  grains: [
    {
      id: 'order_line',
      label: '单据行',
      row: '一行是一张出入库单上的一行明细',
      requireSelective: true,
      fields: [
        { id: 'order.orderNo', label: '单号', type: 'text', selective: true },
        { id: 'order.createdAt', label: '创建时间', type: 'date', selective: true },
        { id: 'sku.skuCode', label: '商品编码', type: 'text', selective: true },
        { id: 'line.quantity', label: '订单数量', type: 'number' },
      ],
    },
    {
      id: 'inventory',
      label: '库存桶',
      row: '一行是一个库存桶',
      requireSelective: false,
      fields: [
        { id: 'sku.skuCode', label: '商品编码', type: 'text', selective: true },
        { id: 'line.quantity', label: '数量', type: 'number' },
      ],
    },
  ],
};

const stored: StoredReport = {
  reportId: 'r-1',
  title: '华东未发',
  note: '给华东客户看',
  updatedAt: '2026-11-13T00:00:00.000Z',
  parameters: [{ key: 'sku', label: '商品', type: 'text' }],
  sections: [
    {
      id: 'lines',
      title: '明细',
      grain: 'order_line',
      columns: ['order.orderNo'],
      filters: [{ field: 'sku.skuCode', op: 'eq', value: { param: 'sku' } }],
    },
  ],
};

const { save } = vi.hoisted(() => ({
  save: vi.fn(async (draft: ReportDraft) => ({
    reportId: 'r-new',
    title: draft.title,
    sectionCount: draft.sections.length,
  })),
}));

vi.mock('../src/api/hooks', () => ({
  useReportCatalog: () => ({ isLoading: false, data: catalog }),
  useReports: () => ({ isLoading: false, isFetching: false, data: [stored] }),
  useRunReport: (_reportId: string, _sectionId: string, _params: Record<string, string>, _offset: number, enabled: boolean) => ({
    isLoading: false,
    isError: false,
    data: enabled
      ? {
          columns: [{ field: 'order.orderNo', label: '单号', type: 'text' as const }],
          rows: [{ 'order.orderNo': 'OUT-1' }],
          hasMore: false,
          limit: 50,
          offset: 0,
        }
      : undefined,
  }),
  useSaveReport: () => ({ isPending: false, mutateAsync: save }),
  useDeleteReport: () => ({ isPending: false, mutateAsync: vi.fn(async () => ({ deleted: true })) }),
}));

afterEach(() => {
  cleanup();
  save.mockClear();
});

function renderPage() {
  return render(
    <ConfigProvider>
      <AntApp>
        <ReportsPage />
      </AntApp>
    </ConfigProvider>,
  );
}

describe('报表页', () => {
  it('参数没填时不出行，填上商品编码后才列出明细', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole('heading', { name: '报表' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '华东未发' })).toBeInTheDocument();
    expect(screen.getByText('单据行')).toBeInTheDocument();
    expect(screen.queryByText('order_line')).not.toBeInTheDocument();
    expect(screen.getByText('填完上面的条件后再看这张表。')).toBeInTheDocument();
    expect(screen.queryByText('OUT-1')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('商品'), 'A-1');
    expect(await screen.findByText('OUT-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('新建单据行时带上日期收窄，保存后提示已保存', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /新建/ }));
    expect(await screen.findByText('一行是一张出入库单上的一行明细')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('标题，例如 华东客户未完成出库'), '近一个月出库');
    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    expect(save).toHaveBeenCalledTimes(1);
    const draft = save.mock.calls[0]![0] as ReportDraft;
    expect(draft.title).toBe('近一个月出库');
    expect(draft.sections[0]?.grain).toBe('order_line');
    const date = draft.sections[0]?.filters.find((filter) => filter.field === 'order.createdAt');
    expect(date).toMatchObject({ op: 'gte' });
    expect(date?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await screen.findByText('报表已保存')).toBeInTheDocument();
  });
});
