import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import ModuleRail from '../src/components/ModuleRail';
import CommandPalette from '../src/components/CommandPalette';
import { noteAuthStatus, noteSessionUser, type SessionUser } from '../src/lib/session';

/**
 * 导航按 rbac 授权过滤（module.rbac）。
 *
 * 「用户与角色」这一项挂了两道门：profile 里的模块开关（moduleId）+ 角色的 page:users
 * 授权（canVisitPage）。浮窗和命令面板两处过滤规则必须一致，所以一起测。
 * rbac 停用（默认）时 canVisitPage 恒为真——单人作业的界面不能因为装了 rbac 就少东西。
 */

const DISABLED = { enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 };
const ENABLED = { enabled: true, bootstrapped: true, sessionTimeoutMinutes: 240 };

const profileWith = (modules: ProfileSnapshot['modules']): ProfileSnapshot => ({
  workspaceId: 'ws',
  version: 1,
  schema: { entities: {} },
  workflows: {},
  modules,
  roles: {},
});

/** 模块开关打开（服务端那侧），登录态由各用例自己写 */
const RBAC_ON = profileWith({ 'module.rbac': { enabled: true, version: '0.1.0' } });
/** 装上但停用：默认形态 */
const RBAC_OFF = profileWith({});

function signIn(grants: string[]) {
  noteAuthStatus(ENABLED);
  const user: SessionUser = {
    id: 'u-worker',
    username: 'worker',
    displayName: '小李',
    roleId: 'role.worker',
    roleName: '作业员',
    node: '',
    status: 'active',
    grants,
  };
  noteSessionUser(user);
}

beforeEach(() => {
  noteAuthStatus(DISABLED);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  noteAuthStatus(DISABLED);
  localStorage.clear();
});

function Probe({ children }: { children: ReactNode }) {
  const { page } = useAppNav();
  return (
    <>
      <span data-testid="page">{page}</span>
      {children}
    </>
  );
}

function renderNav(profile: ProfileSnapshot, ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['profile'], profile);
  client.setQueryData(['ui-pages'], { pages: [] });
  return render(
    <ConfigProvider>
      <QueryClientProvider client={client}>
        <AppNavProvider>
          <Probe>{ui}</Probe>
        </AppNavProvider>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

describe('ModuleRail：rbac 授权决定「用户与角色」入口', () => {
  it('模块停用（默认）时系统里没有这一项，其余入口照旧', async () => {
    const user = userEvent.setup();
    renderNav(RBAC_OFF, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(screen.queryByText('用户与角色')).not.toBeInTheDocument();
    expect(screen.getByText('模块')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
  });

  it('模块启用但当前角色没有 page:users 时不渲染入口，其他有授权的项照旧', async () => {
    const user = userEvent.setup();
    signIn(['page:settings', 'page:modules']);
    renderNav(RBAC_ON, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(screen.queryByText('用户与角色')).not.toBeInTheDocument();
    // 过滤是逐项按 page:{id} 判的，不是一刀切
    expect(screen.getByText('设置')).toBeInTheDocument();
    expect(screen.getByText('模块')).toBeInTheDocument();
    expect(screen.queryByText('流程')).not.toBeInTheDocument();
  });

  it('模块启用且有 page:* 授权时渲染入口，点它进入 users 页', async () => {
    const user = userEvent.setup();
    signIn(['page:*']);
    renderNav(RBAC_ON, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    await user.click(await screen.findByText('用户与角色'));
    expect(screen.getByTestId('page').textContent).toBe('users');
  });

  it('仓库经理那条 * 也能进入', async () => {
    const user = userEvent.setup();
    signIn(['*']);
    renderNav(RBAC_ON, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(await screen.findByText('用户与角色')).toBeInTheDocument();
  });

  it('模块开关打开但登录态是「未启用」时一律放行，不会因为没登录就丢入口', async () => {
    const user = userEvent.setup();
    renderNav(RBAC_ON, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(await screen.findByText('用户与角色')).toBeInTheDocument();
  });

  it('只有工具授权、没有任何 page 授权时，系统大类的页面入口全被过滤掉', async () => {
    const user = userEvent.setup();
    signIn(['tool.read:*']);
    renderNav(RBAC_ON, <ModuleRail />);

    await user.click(screen.getByRole('button', { name: '系统' }));
    expect(screen.queryByText('用户与角色')).not.toBeInTheDocument();
    expect(screen.queryByText('设置')).not.toBeInTheDocument();
    expect(screen.queryByText('流程')).not.toBeInTheDocument();
  });
});

describe('CommandPalette：候选过滤与浮窗一致', () => {
  const ctrlK = '{Control>}k{/Control}';

  it('没有 page:users 授权时搜不到「用户与角色」，回车也不切页', async () => {
    const user = userEvent.setup();
    signIn(['page:dashboard']);
    renderNav(RBAC_ON, <CommandPalette />);

    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');
    await user.type(input, '用户');
    expect(screen.queryByTestId('palette-result')).not.toBeInTheDocument();
    expect(screen.getByText(/没有匹配的页面/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('page').textContent).toBe('dashboard');
  });

  it('有 page:users 授权时搜得到，回车进入 users 页', async () => {
    const user = userEvent.setup();
    signIn(['page:users', 'page:dashboard']);
    renderNav(RBAC_ON, <CommandPalette />);

    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');
    await user.type(input, '用户');
    expect(screen.getAllByTestId('palette-result').map((n) => n.textContent).join('\n')).toContain(
      '用户与角色',
    );
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('page').textContent).toBe('users');
  });

  it('rbac 停用（免登录）时候选照常包含「用户与角色」，界面零变化', async () => {
    const user = userEvent.setup();
    renderNav(RBAC_ON, <CommandPalette />);

    await user.keyboard(ctrlK);
    const input = await screen.findByPlaceholderText('搜索页面：入库、库存、流程…');
    await user.type(input, '用户');
    expect(screen.getAllByTestId('palette-result').map((n) => n.textContent).join('\n')).toContain(
      '用户与角色',
    );
  });
});
