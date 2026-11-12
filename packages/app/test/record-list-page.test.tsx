import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { UiPageKind } from '@one/core';
import { api } from '../src/api/client';
import type { DynRow, UiPageDescriptor } from '../src/api/client';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import DynamicPage from '../src/pages/DynamicPage';
import RecordListPage from '../src/pages/RecordListPage';

/**
 * SDUI 主链路（B.6）：服务端下发的页面描述 → 通用组件渲染 → 写操作走 B.5 确认闸口。
 * mock HTTP，走真实 hooks 与真实组件。
 */

const descriptor: UiPageDescriptor = {
  id: 'ui.vendor.asset.devices',
  label: '设备台账',
  kind: 'record-list',
  category: 'ops',
  icon: 'DatabaseOutlined',
  moduleId: 'vendor.asset',
  moduleName: '资产模块',
  record: {
    id: 'dyn.vendor.asset.device',
    label: '设备',
    module: 'vendor.asset',
    type: 'device',
    note: '仓库设备',
    fields: [
      { key: 'name', label: '名称', type: 'string', queryable: true },
      { key: 'count', label: '数量', type: 'number', queryable: true },
      { key: 'active', label: '启用', type: 'boolean', queryable: false },
      { key: 'spec', label: '规格', type: 'json', queryable: false },
    ],
    tools: {
      list: 'dyn.vendor.asset.device.list',
      get: 'dyn.vendor.asset.device.get',
      create: 'dyn.vendor.asset.device.create',
      update: 'dyn.vendor.asset.device.update',
      delete: 'dyn.vendor.asset.device.delete',
    },
  },
};

const rows: DynRow[] = [
  {
    recordId: 'dev-1',
    version: 2,
    data: { name: '叉车', count: 3, active: true, spec: { w: 2 } },
  },
  { recordId: 'dev-2', version: 1, data: { name: '货架', count: 0, active: false } },
];

let pagesFixture: UiPageDescriptor[] = [descriptor];

/** 服务端在 invoke 阶段只发令牌（B.5）：label 也由服务端给，确认框标题就是它 */
function labelOf(toolId: string) {
  if (toolId.endsWith('.create')) return '新建设备';
  if (toolId.endsWith('.update')) return '更新设备';
  return '删除设备';
}

vi.mock('../src/api/client', () => ({
  api: {
    uiPages: async () => ({ pages: pagesFixture }),
    dynRecords: vi.fn(async (module: string, type: string, query?: { filter?: string; equals?: string }) => {
      const picked =
        query?.filter && query?.equals
          ? rows.filter((row) => String(row.data[query.filter!]) === query.equals)
          : rows;
      return { total: picked.length, limit: 20, offset: 0, hasMore: false, rows: picked };
    }),
    invokeTool: vi.fn(async (toolId: string, params: Record<string, unknown>) => ({
      pending: true as const,
      token: 'tok-1',
      expiresAt: '2026-11-12T00:05:00.000Z',
      toolId,
      label: labelOf(toolId),
      permission: 'write' as const,
      params,
    })),
    confirmTool: vi.fn(async (toolId: string) => ({
      pending: false as const,
      toolId,
      label: labelOf(toolId),
      result: { recordId: 'dev-9', version: 1 },
    })),
  },
  ApiError: class ApiError extends Error {
    code = 'ERR';
  },
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>{ui}</AntApp>
    </ConfigProvider>
  </QueryClientProvider>
);

/** DynamicPage 的 page key 来自导航上下文，这里给个跳板把它推到 ui.* 上 */
function Jump({ to }: { to: string }) {
  const { navigate } = useAppNav();
  return (
    <button type="button" data-testid="jump" onClick={() => navigate(to)}>
      跳转
    </button>
  );
}

function renderHost(page = descriptor.id) {
  return render(
    wrap(
      <AppNavProvider>
        <Jump to={page} />
        <DynamicPage />
      </AppNavProvider>,
    ),
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  pagesFixture = [descriptor];
});

describe('DynamicPage：按页面清单挑渲染器', () => {
  it('清单里有这个 page 就渲染出通用列表页', async () => {
    const user = userEvent.setup();
    renderHost();
    await user.click(screen.getByTestId('jump'));
    expect(await screen.findByText('设备台账')).toBeInTheDocument();
    expect(await screen.findByText('叉车')).toBeInTheDocument();
  });

  it('清单里找不到（模块刚停用/已卸载）就提示页面不可用，不白屏', async () => {
    const user = userEvent.setup();
    renderHost('ui.vendor.asset.gone');
    await user.click(screen.getByTestId('jump'));
    expect(await screen.findByText('页面不可用')).toBeInTheDocument();
    expect(screen.getByText(/没有找到页面/)).toBeInTheDocument();
  });

  it('前端不认识的 kind 走兜底提示，不索引出 undefined 组件', async () => {
    const user = userEvent.setup();
    pagesFixture = [{ ...descriptor, kind: 'dashboard' as UiPageKind }];
    renderHost();
    await user.click(screen.getByTestId('jump'));
    expect(await screen.findByText('暂不支持这种页面')).toBeInTheDocument();
  });
});

describe('RecordListPage：列与过滤都来自描述', () => {
  it('内联列定义长成表头，缺值的列显示占位符', async () => {
    render(wrap(<RecordListPage descriptor={descriptor} />));

    for (const title of ['记录 ID', '名称', '数量', '启用', '规格', '操作']) {
      expect(await screen.findByRole('columnheader', { name: title })).toBeInTheDocument();
    }
    const row1 = (await screen.findByText('叉车')).closest('tr') as HTMLElement;
    expect(within(row1).getByText('是')).toBeInTheDocument();
    expect(within(row1).getByText('{"w":2}')).toBeInTheDocument();
    const row2 = screen.getByText('货架').closest('tr') as HTMLElement;
    expect(within(row2).getByText('否')).toBeInTheDocument();
    expect(within(row2).getByText('-')).toBeInTheDocument();
    expect(screen.getByText('资产模块 · 仓库设备')).toBeInTheDocument();
  });

  it('只有 queryable 的列能当过滤条件，搜完带着 filter/equals 重新取数', async () => {
    const user = userEvent.setup();
    render(wrap(<RecordListPage descriptor={descriptor} />));
    await screen.findByText('叉车');

    const search = screen.getByPlaceholderText('精确匹配…');
    await user.type(search, '叉车');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByText('货架')).not.toBeInTheDocument();
    });
    const calls = vi.mocked(api.dynRecords).mock.calls;
    expect(calls.at(-1)).toEqual([
      'vendor.asset',
      'device',
      expect.objectContaining({ filter: 'name', equals: '叉车' }),
    ]);
  });
});

describe('RecordListPage：写操作走 invoke → 确认框 → confirm', () => {
  it('新建：invoke 只拿到令牌，弹框摊开入参，确认执行才落地', async () => {
    const user = userEvent.setup();
    render(wrap(<RecordListPage descriptor={descriptor} />));
    await screen.findByText('叉车');

    // 带图标的 antd 按钮，可访问名是「plus 新建」这种拼接形式，只能用正则匹配
    await user.click(screen.getByRole('button', { name: /新建/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建设备' });
    await user.type(within(dialog).getByLabelText('名称'), '堆高车');
    await user.type(within(dialog).getByLabelText('数量'), '5');
    await user.click(within(dialog).getByRole('button', { name: '新建' }));

    // 表单先关掉，服务端确认框才登场——两层弹框叠着看不清要确认哪一层
    const confirm = await screen.findByRole('dialog', { name: '确认新建设备' });
    expect(screen.queryByRole('dialog', { name: '新建设备' })).not.toBeInTheDocument();
    expect(within(confirm).getByText(/"name": "堆高车"/)).toBeInTheDocument();

    expect(vi.mocked(api.invokeTool)).toHaveBeenCalledWith('dyn.vendor.asset.device.create', {
      data: { name: '堆高车', count: 5, active: false },
    });
    expect(api.confirmTool).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: '确认执行' }));
    await waitFor(() => {
      expect(api.confirmTool).toHaveBeenCalledWith('dyn.vendor.asset.device.create', 'tok-1');
    });
    expect(await screen.findByText('新建设备完成')).toBeInTheDocument();
  });

  it('编辑：带上 version 走乐观并发，JSON 列以对象回传而不是字符串', async () => {
    const user = userEvent.setup();
    render(wrap(<RecordListPage descriptor={descriptor} />));
    const row1 = (await screen.findByText('叉车')).closest('tr') as HTMLElement;

    await user.click(within(row1).getByRole('button', { name: /编辑/ }));
    const dialog = await screen.findByRole('dialog', { name: '编辑设备' });
    expect(within(dialog).getByLabelText('规格')).toHaveValue('{"w":2}');
    expect(within(dialog).getByText(/保存为整替/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(api.invokeTool).toHaveBeenCalledWith('dyn.vendor.asset.device.update', {
        recordId: 'dev-1',
        expectedVersion: 2,
        data: { name: '叉车', count: 3, active: true, spec: { w: 2 } },
      });
    });
  });

  it('删除：同样先要令牌，确认框里摊开 recordId 与 version', async () => {
    const user = userEvent.setup();
    render(wrap(<RecordListPage descriptor={descriptor} />));
    const row2 = (await screen.findByText('货架')).closest('tr') as HTMLElement;

    await user.click(within(row2).getByRole('button', { name: /删除/ }));
    const confirm = await screen.findByRole('dialog', { name: '确认删除设备' });
    expect(within(confirm).getByText(/"expectedVersion": 1/)).toBeInTheDocument();

    await user.click(within(confirm).getByRole('button', { name: '确认执行' }));
    await waitFor(() => {
      expect(api.confirmTool).toHaveBeenCalledWith('dyn.vendor.asset.device.delete', 'tok-1');
    });
    expect(await screen.findByText('删除设备完成')).toBeInTheDocument();
  });
});
