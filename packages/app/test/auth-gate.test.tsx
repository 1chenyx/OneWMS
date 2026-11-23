import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import AuthGate from '../src/components/AuthGate';
import {
  noteAuthStatus,
  noteSessionUser,
  writeSessionToken,
  type AuthStatus,
  type SessionUser,
} from '../src/lib/session';

/**
 * 登录门（module.rbac）三态：停用直接放行、启用未建号走建号表单、启用已建号走登录表单。
 * 「停用 = 界面零变化」是产品口径，第一条用例就是钉住它。
 *
 * 只打桩两个数据 hook（useAuthStatus / useSessionUser）；useSession 用真的，
 * 登录态由 lib/session 的单例写进去，顺带把「单例 → 组件」这条链路一起测了。
 */

const harness = vi.hoisted(() => {
  const state: { status: AuthStatus | undefined; isLoading: boolean; meEnabled: boolean[] } = {
    status: undefined,
    isLoading: true,
    meEnabled: [],
  };
  return { state };
});

vi.mock('../src/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/auth')>();
  return {
    ...actual,
    useAuthStatus: () => ({ data: harness.state.status, isLoading: harness.state.isLoading }),
    // 记下每次调用的 enabled 实参：刷新页面接回登录态只在「启用 + 无用户 + 有令牌」时才发
    useSessionUser: (enabled: boolean) => {
      harness.state.meEnabled.push(enabled);
      return { data: undefined, isLoading: false };
    },
  };
});

const ENABLED: AuthStatus = { enabled: true, bootstrapped: true, sessionTimeoutMinutes: 240 };

const person: SessionUser = {
  id: 'u-manager',
  username: 'manager',
  displayName: '张经理',
  roleId: 'role.manager',
  roleName: '仓库经理',
  node: '',
  status: 'active',
  grants: ['*'],
};

const Main = () => <div data-testid="main">入库单</div>;

// 禁用两字按钮自动插空格（否则「登录」被拆成「登 录」，按名字找不到）
function gate() {
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AuthGate>
        <Main />
      </AuthGate>
    </ConfigProvider>,
  );
}

beforeEach(() => {
  harness.state.status = undefined;
  harness.state.isLoading = true;
  harness.state.meEnabled = [];
  noteAuthStatus({ enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  noteAuthStatus({ enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 });
  localStorage.clear();
});

describe('AuthGate：登录门三态', () => {
  it('状态还没问回来时先不渲染主界面，免得一堆请求以未登录身份打出去', async () => {
    harness.state.isLoading = true;
    gate();

    expect(await screen.findByText('正在确认登录方式…')).toBeInTheDocument();
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
  });

  it('模块停用（默认）时直接渲染主界面，界面一个字都不多', async () => {
    harness.state.status = { enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 };
    harness.state.isLoading = false;
    gate();

    expect(await screen.findByTestId('main')).toHaveTextContent('入库单');
    expect(screen.queryByText('正在确认登录方式…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建号' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('口令')).not.toBeInTheDocument();
    // 停用就不该去问 /me
    expect(harness.state.meEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('启用但一个账号都没有时给建号表单（bootstrap 模式）', async () => {
    harness.state.status = { enabled: true, bootstrapped: false, sessionTimeoutMinutes: 240 };
    harness.state.isLoading = false;
    gate();

    expect(await screen.findByRole('heading', { name: '建第一个仓库经理' })).toBeInTheDocument();
    expect(screen.getByText('这个库还没有账号')).toBeInTheDocument();
    expect(screen.getByText(/只有这个角色能确认配置变更/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '建号' })).toBeInTheDocument();
    expect(screen.getByLabelText('显示名')).toBeInTheDocument();
    expect(screen.getByLabelText('账号')).toBeInTheDocument();
    expect(screen.getByLabelText('口令')).toBeInTheDocument();
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
    // 启用 + 没有本地令牌：不必去问 /me
    expect(harness.state.meEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('启用且已建号、当前没有会话时给登录表单', async () => {
    harness.state.status = ENABLED;
    harness.state.isLoading = false;
    gate();

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByText(/需要用账号登录后才能作业/)).toBeInTheDocument();
    // 登录表单不收显示名，那是建号才有的字段
    expect(screen.queryByLabelText('显示名')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建号' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
  });

  it('启用且已登录时门自己消失，渲染主界面', async () => {
    harness.state.status = ENABLED;
    harness.state.isLoading = false;
    noteAuthStatus(ENABLED);
    noteSessionUser(person);
    writeSessionToken('tok-123');
    gate();

    expect(await screen.findByTestId('main')).toHaveTextContent('入库单');
    expect(screen.queryByRole('heading', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建号' })).not.toBeInTheDocument();
  });

  it('启用且本地还留着令牌但内存里没有用户时，才去问一次 /me 把登录态接回来', async () => {
    harness.state.status = ENABLED;
    harness.state.isLoading = false;
    noteAuthStatus(ENABLED);
    writeSessionToken('tok-from-last-run');
    gate();

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    // 有令牌就不显示「需要用账号登录」那句提示（那是首次到登录门时说的）
    expect(screen.queryByText(/需要用账号登录后才能作业/)).not.toBeInTheDocument();
    expect(harness.state.meEnabled.some((enabled) => enabled === true)).toBe(true);
  });
});
