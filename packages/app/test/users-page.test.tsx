import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import UsersPage from '../src/pages/UsersPage';
import { noteAuthStatus, noteSessionUser, type SessionUser } from '../src/lib/session';
import type { AuthRoleView } from '../src/api/auth';

/**
 * 用户与角色页（module.rbac）。
 *
 * 导航里这一项挂了 moduleId，模块停用时整项不出现；页面自己再兜一层 Empty，
 * 免得从命令面板或 AI 跳转直接落到 users 这个 page key 上看见半个空壳。
 * 数据 hook 打桩，登录态用 lib/session 的真单例（useSession 走真的）。
 */

const harness = vi.hoisted(() => {
  const state: {
    users: { rows: SessionUser[]; total: number } | undefined;
    roles: { rows: AuthRoleView[]; total: number } | undefined;
    usersEnabled: boolean[];
    rolesEnabled: boolean[];
  } = { users: undefined, roles: undefined, usersEnabled: [], rolesEnabled: [] };
  const logoutMock = vi.fn();
  const changePasswordMock = vi.fn();
  const mutate = vi.fn();
  return { state, logoutMock, changePasswordMock, mutate };
});

vi.mock('../src/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/auth')>();
  const mutation = () => ({ mutate: harness.mutate, mutateAsync: harness.mutate, isPending: false });
  return {
    ...actual,
    useAuthUsers: (enabled: boolean) => {
      harness.state.usersEnabled.push(enabled);
      return { isLoading: false, data: harness.state.users };
    },
    useAuthRoles: (enabled: boolean) => {
      harness.state.rolesEnabled.push(enabled);
      return { isLoading: false, data: harness.state.roles };
    },
    useCreateUser: mutation,
    useUpdateUser: mutation,
    useDeleteUser: mutation,
    useCreateRole: mutation,
    useUpdateRole: mutation,
    useDeleteRole: mutation,
    logout: () => harness.logoutMock(),
    changeOwnPassword: (...args: unknown[]) => harness.changePasswordMock(...args),
  };
});

const manager: SessionUser = {
  id: 'u-manager',
  username: 'manager',
  displayName: '张经理',
  roleId: 'role.manager',
  roleName: '仓库经理',
  node: '',
  status: 'active',
  grants: ['*'],
};

const worker: SessionUser = {
  id: 'u-worker',
  username: 'worker',
  displayName: '小李',
  roleId: 'role.worker',
  roleName: '作业员',
  node: 'node-a',
  status: 'disabled',
  grants: ['page:*'],
};

const ROLES: AuthRoleView[] = [
  {
    id: 'role.manager',
    name: '仓库经理',
    description: '全部操作，含配置慢通道的提案与确认',
    builtin: true,
    grants: ['*'],
  },
  {
    id: 'role.worker',
    name: '作业员',
    description: '单据与库存作业',
    builtin: true,
    grants: ['page:*', 'tool.read:*', 'tool.write:wms.picking.*'],
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>
        <QueryClientProvider client={client}>
          <UsersPage />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );
}

beforeEach(() => {
  harness.state.users = { rows: [manager, worker], total: 2 };
  harness.state.roles = { rows: ROLES, total: 2 };
  harness.state.usersEnabled = [];
  harness.state.rolesEnabled = [];
  harness.mutate.mockReset();
  harness.logoutMock.mockReset();
  noteAuthStatus({ enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  noteAuthStatus({ enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 });
  localStorage.clear();
});

describe('UsersPage：模块停用时的兜底', () => {
  it('渲染「没启用」提示，不渲染当前登录与两个 Tab，也不去要用户/角色数据', () => {
    renderPage();

    expect(screen.getByText(/没有启用，现在是免登录单人作业/)).toBeInTheDocument();
    // 指路文案里要点明去哪个页面打开
    expect(screen.getByText(/去「系统 → 模块」把它打开/)).toBeInTheDocument();
    expect(screen.queryByText('当前登录')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('manager')).not.toBeInTheDocument();
    expect(harness.state.usersEnabled.every((enabled) => enabled === false)).toBe(true);
    expect(harness.state.rolesEnabled.every((enabled) => enabled === false)).toBe(true);
  });
});

describe('UsersPage：模块启用时', () => {
  beforeEach(() => {
    noteAuthStatus({ enabled: true, bootstrapped: true, sessionTimeoutMinutes: 240 });
    noteSessionUser(manager);
  });

  it('当前登录区显示账号、显示名与角色，并给改口令 / 退出登录', () => {
    renderPage();

    expect(screen.getByText('当前登录')).toBeInTheDocument();
    // 账号 / 显示名 / 角色名在用户表里也会各出现一次，所以按「至少有一处」断言
    expect(screen.getAllByText('manager').length).toBeGreaterThan(0);
    expect(screen.getAllByText('张经理').length).toBeGreaterThan(0);
    expect(screen.getAllByText('仓库经理').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '改口令' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
    expect(screen.queryByText('未登录')).not.toBeInTheDocument();
    // 启用才去要数据
    expect(harness.state.usersEnabled.some((enabled) => enabled === true)).toBe(true);
    expect(harness.state.rolesEnabled.some((enabled) => enabled === true)).toBe(true);
  });

  it('用户 Tab 列出账号、角色名与所属节点，自己那一行的停用/删除被禁掉', () => {
    renderPage();

    expect(screen.getByRole('tab', { name: '用户（2）' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '角色（2）' })).toBeInTheDocument();
    expect(screen.getByText('谁能登录')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建用户' })).toBeInTheDocument();

    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('小李')).toBeInTheDocument();
    expect(screen.getByText('node-a')).toBeInTheDocument();
    expect(screen.getAllByText('作业员').length).toBeGreaterThan(0);

    // 只认当前 Tab 面板里的表（antd Tabs 默认不销毁隐藏面板，角色表也在 DOM 里）
    const pane = document.querySelector<HTMLElement>('.ant-tabs-tabpane-active') as HTMLElement;
    const rowOf = (username: string) =>
      Array.from(pane.querySelectorAll<HTMLElement>('tbody tr')).find((row) =>
        Array.from(row.querySelectorAll('td')).some((cell) => cell.textContent?.trim() === username),
      );
    const buttonOf = (row: HTMLElement, text: string) =>
      Array.from(row.querySelectorAll('button')).find((node) => node.textContent?.includes(text));

    const mine = rowOf('manager') as HTMLElement;
    const his = rowOf('worker') as HTMLElement;
    expect(mine).toBeTruthy();
    expect(his).toBeTruthy();

    // 当前登录的这个人不能被自己停用/删掉（否则把自己锁在门外）
    expect(mine.querySelector('button.ant-switch')).toBeDisabled();
    expect(buttonOf(mine, '删除')).toBeDisabled();
    // 别人那一行照旧能操作
    expect(his.querySelector('button.ant-switch')).not.toBeDisabled();
    expect(buttonOf(his, '删除')).not.toBeDisabled();
    expect(buttonOf(his, '重置口令')).not.toBeDisabled();
  });

  it('切到角色 Tab 看到授权模式串与内置标记', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('tab', { name: '角色（2）' }));

    expect(await screen.findByText('角色能干什么')).toBeInTheDocument();
    expect(screen.getByText('授权用模式串，* 是通配')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建角色' })).toBeInTheDocument();
    expect(screen.getByText('tool.write:wms.picking.*')).toBeInTheDocument();
    expect(screen.getAllByText('内置').length).toBe(2);
    // 内置角色不能删
    expect(screen.getAllByRole('button', { name: '内置不可删' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: '改授权' }).length).toBe(2);
  });

  it('启用但当前没有会话时，当前登录区显示未登录，管理功能照旧', () => {
    noteSessionUser(null);
    renderPage();

    expect(screen.getByText('未登录')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '改口令' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '用户（2）' })).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
  });
});
