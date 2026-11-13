import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import CommandPalette from '../src/components/CommandPalette';
import type { UiPageDescriptor } from '../src/api/client';

/**
 * Ctrl+K 全局搜索：不经过左侧浮窗，敲字直达任意页面。
 * 候选过滤规则须与浮窗一致：模块关闭的内置项不出现，动态页直接采信服务端。
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const PROFILE: ProfileSnapshot = {
  workspaceId: 'ws',
  version: 1,
  schema: { entities: {} },
  workflows: {},
  // 全关：质检/上架/波次/拣货/复核/打包/装车/序列号/托盘都不该出现在候选里
  modules: {},
  roles: {},
};

const uiPage = (id: string, label: string): UiPageDescriptor => ({
  id,
  label,
  kind: 'record-list',
  moduleId: 'vendor.asset',
  moduleName: '资产模块',
  record: {
    id: 'dyn.vendor.asset.device',
    label: '设备',
    module: 'vendor.asset',
    type: 'device',
    fields: [{ key: 'name', label: '名称', queryable: true }],
    tools: {
      list: 'dyn.vendor.asset.device.list',
      get: 'dyn.vendor.asset.device.get',
      create: 'dyn.vendor.asset.device.create',
      update: 'dyn.vendor.asset.device.update',
      delete: 'dyn.vendor.asset.device.delete',
    },
  },
});

function Probe() {
  const { page } = useAppNav();
  return (
    <>
      <span data-testid="page">{page}</span>
      <CommandPalette />
    </>
  );
}

function renderPalette(pages: UiPageDescriptor[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['profile'], PROFILE);
  client.setQueryData(['ui-pages'], { pages });
  return render(
    <ConfigProvider>
      <QueryClientProvider client={client}>
        <AppNavProvider>
          <Probe />
        </AppNavProvider>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

const ctrlK = '{Control>}k{/Control}';

describe('CommandPalette：Ctrl+K 全局搜索', () => {
  it('Ctrl+K 打开，敲字过滤，回车进入目标页', async () => {
    const user = userEvent.setup();
    renderPalette();

    expect(screen.queryByPlaceholderText('搜索页面：入库、库存、流程…')).not.toBeInTheDocument();
    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');

    // 模块全关时：入库单在（core.wms 常开），质检不在
    await user.type(input, '入库');
    const labels = screen.getAllByTestId('palette-result').map((node) => node.textContent ?? '');
    expect(labels.join('\n')).toContain('入库单');
    expect(labels.join('\n')).not.toContain('质检');

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('page').textContent).toBe('inbound');
    // 选完即关，不打断后续操作
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('搜索页面：入库、库存、流程…')).not.toBeInTheDocument();
    });
  });

  it('搜索命中动态模块页，也能进入', async () => {
    const user = userEvent.setup();
    renderPalette([uiPage('ui.vendor.asset.devices', '设备台账')]);

    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');
    await user.type(input, '设备台账');
    expect(screen.getAllByTestId('palette-result').map((n) => n.textContent).join('\n')).toContain('设备台账');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('page').textContent).toBe('ui.vendor.asset.devices');
  });

  it('无匹配给出空提示，Esc 关闭不切页', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');
    await user.type(input, '不存在的页面');
    expect(screen.getByText(/没有匹配的页面/)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByTestId('page').textContent).toBe('skus');
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('搜索页面：入库、库存、流程…')).not.toBeInTheDocument();
    });
  });

  it('再按一次 Ctrl+K 切换关闭', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard(ctrlK);
    expect(await screen.findByPlaceholderText('搜索页面：入库、库存、流程…')).toBeInTheDocument();
    await user.keyboard(ctrlK);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('搜索页面：入库、库存、流程…')).not.toBeInTheDocument();
    });
  });
});
