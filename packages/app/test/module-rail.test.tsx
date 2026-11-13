import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import App from '../src/App';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import ModuleRail from '../src/components/ModuleRail';
import type { UiPageDescriptor } from '../src/api/client';

/**
 * 左侧大类：点击立刻浮出功能网格，悬停约 0.4 秒也会浮出。点功能才切页。
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function Probe() {
  const { page } = useAppNav();
  return (
    <>
      <span data-testid="page">{page}</span>
      <ModuleRail />
    </>
  );
}

/** 声明式模块下发的一个页面（B.6）；只填导航要看的字段，列定义留最小可用 */
function uiPage(id: string, label: string, category?: string): UiPageDescriptor {
  return {
    id,
    label,
    kind: 'record-list',
    ...(category ? { category } : {}),
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
  };
}

function renderRail(profile?: ProfileSnapshot, pages?: UiPageDescriptor[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  if (profile) client.setQueryData(['profile'], profile);
  // ⚠️ 必须预置空清单：ModuleRail 会调 useUiPages，jsdom 里没有服务端，
  //    放任真 fetch 失败会让「动态页面」这几例永远测不到东西
  client.setQueryData(['ui-pages'], { pages: pages ?? [] });
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

describe('应用壳：导航在左，主区在右', () => {
  it('外层布局横向排列，主区不落到导航下面', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider>
        <AntApp>
          <QueryClientProvider client={client}>
            <App />
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>,
    );

    const shell = document.querySelector('.app-shell') as HTMLElement;
    expect(shell.style.flexDirection).toBe('row');
    expect(shell.style.height).toBe('100%');
    expect(shell.style.overflow).toBe('hidden');
    expect(shell.querySelector('nav')?.nextElementSibling?.classList.contains('ant-layout')).toBe(true);
    const page = shell.querySelector('.app-page') as HTMLElement;
    expect(page.style.overflow).toBe('auto');
    expect((page.parentElement as HTMLElement).style.overflow).toBe('hidden');
  });
});

describe('ModuleRail：悬停浮出功能网格', () => {
  it('点击大类立刻打开功能浮窗，不切页', async () => {
    const user = userEvent.setup();
    renderRail();

    expect(screen.queryByText('入库单')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '作业' }));
    expect(screen.getByText('入库单')).toBeInTheDocument();
    expect(screen.getByText('出库单')).toBeInTheDocument();
    expect(screen.queryByText('拣货单')).not.toBeInTheDocument();
    expect(screen.queryByText('上架')).not.toBeInTheDocument();
    expect(screen.queryByText('序列号')).not.toBeInTheDocument();
    expect(screen.queryByText('托盘')).not.toBeInTheDocument();
    expect(screen.getByTestId('module-flyout-grid').style.gridTemplateColumns).toBe('1fr 1fr');
    expect(screen.getByTestId('page').textContent).toBe('skus');
  });

  it('悬停稍候后以网格浮出该类功能，点功能切页并收起', async () => {
    const user = userEvent.setup();
    renderRail();

    await user.hover(screen.getByText('作业'));
    // 浮窗内层是 antd 的 tooltip 角色，子按钮不再暴露 button 角色，按可见文案断言
    const order = await screen.findByText('入库单', {}, { timeout: 2000 });
    expect(screen.queryByText('拣货单')).not.toBeInTheDocument();
    expect(screen.getByText('库存')).toBeInTheDocument();
    expect(screen.getByText('盘点')).toBeInTheDocument();
    expect(screen.getByTestId('module-flyout-grid').style.gridTemplateColumns).toBe('1fr 1fr');
    expect(order.closest('[role="dialog"]')).toHaveAccessibleName('作业功能');

    expect(screen.queryByText('序列号')).not.toBeInTheDocument();
    await user.click(screen.getByText('库存'));
    expect(screen.getByTestId('page').textContent).toBe('inventory');
    await waitFor(() => {
      expect(screen.queryByText('入库单')).not.toBeInTheDocument();
    });
  });

  it('模块开启后，作业里出现序列号和托盘，并可以进入', async () => {
    const user = userEvent.setup();
    const profile: ProfileSnapshot = {
      workspaceId: 'ws',
      version: 1,
      schema: { entities: {} },
      workflows: {},
      modules: {
        'module.serial': { enabled: true, version: '0.1.0' },
        'module.lpn': { enabled: true, version: '0.1.0' },
        'module.picking': { enabled: true, version: '0.1.0' },
        'module.putaway': { enabled: true, version: '0.1.0' },
      },
      roles: {},
    };
    renderRail(profile);
    await user.click(screen.getByRole('button', { name: '作业' }));
    expect(screen.getByText('拣货单')).toBeInTheDocument();
    expect(screen.getByText('上架')).toBeInTheDocument();
    expect(screen.getByText('序列号')).toBeInTheDocument();
    expect(screen.getByText('托盘')).toBeInTheDocument();
    await user.click(screen.getByText('托盘'));
    expect(screen.getByTestId('page').textContent).toBe('pallets');
  });

  it('系统里可以进入流程和模块', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(screen.getByText('流程')).toBeInTheDocument();
    expect(screen.getByText('规则')).toBeInTheDocument();
    expect(screen.getByText('模块')).toBeInTheDocument();
    expect(screen.getByText('对接')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
    await user.click(screen.getByText('流程'));
    expect(screen.getByTestId('page').textContent).toBe('flows');
    await user.click(screen.getByRole('button', { name: '系统' }));
    await user.click(screen.getByText('模块'));
    expect(screen.getByTestId('page').textContent).toBe('modules');
    await user.click(screen.getByRole('button', { name: '系统' }));
    await user.click(screen.getByText('规则'));
    expect(screen.getByTestId('page').textContent).toBe('rules');
    await user.click(screen.getByRole('button', { name: '系统' }));
    await user.click(screen.getByText('对接'));
    expect(screen.getByTestId('page').textContent).toBe('integrations');
  });
});

describe('ModuleRail：声明式模块的页面（B.6）', () => {
  it('按 category 落进对应大类，点它进入 ui.* 页面', async () => {
    const user = userEvent.setup();
    renderRail(undefined, [
      uiPage('ui.vendor.asset.devices', '设备台账', 'ops'),
      uiPage('ui.vendor.asset.brands', '设备品牌', 'registry'),
    ]);

    await user.click(screen.getByRole('button', { name: '作业' }));
    expect(screen.getByText('设备台账')).toBeInTheDocument();
    expect(screen.queryByText('设备品牌')).not.toBeInTheDocument();
    await user.click(screen.getByText('设备台账'));
    expect(screen.getByTestId('page').textContent).toBe('ui.vendor.asset.devices');

    await user.click(screen.getByRole('button', { name: '档案' }));
    expect(screen.getByText('设备品牌')).toBeInTheDocument();
    expect(screen.getByText('SKU 管理')).toBeInTheDocument();
    await user.click(screen.getByText('设备品牌'));
    expect(screen.getByTestId('page').textContent).toBe('ui.vendor.asset.brands');
  });

  it('category 认不出来就归「档案」，页面不会消失', async () => {
    const user = userEvent.setup();
    renderRail(undefined, [
      uiPage('ui.vendor.asset.a', '写了大类', 'ops'),
      uiPage('ui.vendor.asset.b', '写错大类', 'not-a-category'),
      uiPage('ui.vendor.asset.c', '没写大类'),
    ]);

    await user.click(screen.getByRole('button', { name: '档案' }));
    expect(screen.getByText('写错大类')).toBeInTheDocument();
    expect(screen.getByText('没写大类')).toBeInTheDocument();
    expect(screen.queryByText('写了大类')).not.toBeInTheDocument();
  });

  it('进入动态页面后，高亮跟到它所属的大类而不是兜底到看板', async () => {
    const user = userEvent.setup();
    renderRail(undefined, [uiPage('ui.vendor.asset.devices', '设备台账', 'ops')]);

    await user.click(screen.getByRole('button', { name: '作业' }));
    await user.click(screen.getByText('设备台账'));
    expect(screen.getByTestId('page').textContent).toBe('ui.vendor.asset.devices');

    // categoryOfPage 对 ui.* 只会兜底到第一个大类（看板），
    // 所以这里断言「看板不亮、作业亮」正好卡住那条回归路径
    expect(screen.getByRole('button', { name: '看板' }).style.background).toBe('transparent');
    expect(screen.getByRole('button', { name: '档案' }).style.background).toBe('transparent');
    expect(screen.getByRole('button', { name: '作业' }).style.background).not.toBe('transparent');

    await user.click(screen.getByRole('button', { name: '作业' }));
    expect(screen.getByText('设备台账').closest('button')).toHaveAttribute('aria-current', 'page');
  });
});
