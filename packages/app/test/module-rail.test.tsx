import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import App from '../src/App';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import ModuleRail from '../src/components/ModuleRail';

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

function renderRail() {
  return render(
    <ConfigProvider>
      <AppNavProvider>
        <Probe />
      </AppNavProvider>
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

    const shell = document.querySelector('.ant-layout') as HTMLElement;
    expect(shell.style.flexDirection).toBe('row');
    expect(shell.querySelector('nav')?.nextElementSibling?.classList.contains('ant-layout')).toBe(true);
  });
});

describe('ModuleRail：悬停浮出功能网格', () => {
  it('点击大类立刻打开功能浮窗，不切页', async () => {
    const user = userEvent.setup();
    renderRail();

    expect(screen.queryByText('出入库单')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '作业' }));
    expect(screen.getByText('出入库单')).toBeInTheDocument();
    expect(screen.getByText('拣货单')).toBeInTheDocument();
    expect(screen.getByTestId('module-flyout-grid').style.gridTemplateColumns).toBe('1fr 1fr');
    expect(screen.getByTestId('page').textContent).toBe('skus');
  });

  it('悬停稍候后以网格浮出该类功能，点功能切页并收起', async () => {
    const user = userEvent.setup();
    renderRail();

    await user.hover(screen.getByText('作业'));
    // 浮窗内层是 antd 的 tooltip 角色，子按钮不再暴露 button 角色，按可见文案断言
    const order = await screen.findByText('出入库单', {}, { timeout: 2000 });
    expect(screen.getByText('拣货单')).toBeInTheDocument();
    expect(screen.getByText('库存')).toBeInTheDocument();
    expect(screen.getByText('盘点')).toBeInTheDocument();
    expect(screen.getByTestId('module-flyout-grid').style.gridTemplateColumns).toBe('1fr 1fr');
    expect(order.closest('[role="dialog"]')).toHaveAccessibleName('作业功能');

    await user.click(screen.getByText('库存'));
    expect(screen.getByTestId('page').textContent).toBe('inventory');
    await waitFor(() => {
      expect(screen.queryByText('出入库单')).not.toBeInTheDocument();
    });
  });
});
