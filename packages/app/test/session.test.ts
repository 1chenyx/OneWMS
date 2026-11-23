import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authStatus,
  canVisitPage,
  clearSession,
  currentSessionUser,
  grantMatches,
  noteAuthStatus,
  noteSessionUser,
  readSessionToken,
  sessionCan,
  subscribeSession,
  writeSessionToken,
  type AuthStatus,
  type SessionUser,
} from '../src/lib/session';

/**
 * 本机登录态单例（module.rbac）的纯逻辑：授权模式匹配 + 「停用即全放行」的口径。
 * 这块不渲染组件，但导航过滤（nav/ModuleRail/CommandPalette）和请求头拼装都读它，
 * 判错就是「该有的入口没了」或「不该进的地方能进」。
 */

/** 默认形态：rbac 装上但停用，单人本地作业免登录 */
const DISABLED: AuthStatus = { enabled: false, bootstrapped: false, sessionTimeoutMinutes: 240 };
const ENABLED: AuthStatus = { enabled: true, bootstrapped: true, sessionTimeoutMinutes: 240 };

const person = (grants: string[], over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u-manager',
  username: 'manager',
  displayName: '张经理',
  roleId: 'role.manager',
  roleName: '仓库经理',
  node: '',
  status: 'active',
  grants,
  ...over,
});

// 单例是模块级的：每个用例前后都清干净，别让上一条的登录态串到下一条
beforeEach(() => {
  noteAuthStatus(DISABLED);
  localStorage.clear();
});

afterEach(() => {
  noteAuthStatus(DISABLED);
  localStorage.clear();
});

describe('grantMatches：授权模式匹配', () => {
  it('单独一条 * 匹配一切权限对象', () => {
    expect(grantMatches('*', 'page:users')).toBe(true);
    expect(grantMatches('*', 'tool.write:wms.picking.confirm')).toBe(true);
    expect(grantMatches('*', 'config.confirm')).toBe(true);
    expect(grantMatches('*', 'report.export:inventory')).toBe(true);
  });

  it('没有通配时只做全等比较', () => {
    expect(grantMatches('config.confirm', 'config.confirm')).toBe(true);
    expect(grantMatches('config.confirm', 'config.propose')).toBe(false);
    expect(grantMatches('page:users', 'page:users2')).toBe(false);
    expect(grantMatches('page:users', 'users')).toBe(false);
  });

  it('page:* 命中同类页面，不跨类命中工具权限', () => {
    expect(grantMatches('page:*', 'page:users')).toBe(true);
    expect(grantMatches('page:*', 'page:dashboard')).toBe(true);
    expect(grantMatches('page:*', 'tool.read:wms.sku.list')).toBe(false);
    expect(grantMatches('page:*', 'config.confirm')).toBe(false);
  });

  it('尾段通配只在同一类里放开：tool.write:wms.picking.* 不放过读，也不放过别的工具', () => {
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.picking.confirm')).toBe(true);
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.picking.create')).toBe(true);
    expect(grantMatches('tool.write:wms.picking.*', 'tool.read:wms.picking.confirm')).toBe(false);
    expect(grantMatches('tool.write:wms.picking.*', 'tool.write:wms.putaway.confirm')).toBe(false);
  });

  it('首段必须从头对齐：page:* 不能命中 xpage:users', () => {
    expect(grantMatches('page:*', 'xpage:users')).toBe(false);
    expect(grantMatches('page:*', 'my.page:users')).toBe(false);
    expect(grantMatches('tool.read:*', 'xtool.read:wms.sku.list')).toBe(false);
  });

  it('尾段必须收到末尾：*list 不命中 tool.read:wms.sku.listX', () => {
    expect(grantMatches('*list', 'tool.read:wms.sku.list')).toBe(true);
    expect(grantMatches('*list', 'tool.read:wms.sku.listX')).toBe(false);
    expect(grantMatches('*users', 'page:users')).toBe(true);
    expect(grantMatches('*users', 'page:users-x')).toBe(false);
    // 结尾是 * 就退化成前缀匹配，收到哪儿都算命中
    expect(grantMatches('page:user*', 'page:users-x')).toBe(true);
  });

  it('通配在中间时可以跨段', () => {
    expect(grantMatches('tool.*:wms.sku.list', 'tool.read:wms.sku.list')).toBe(true);
    expect(grantMatches('tool.*:wms.sku.list', 'tool.write:wms.sku.list')).toBe(true);
    expect(grantMatches('tool.*:wms.sku.list', 'tool.read:wms.sku.get')).toBe(false);
  });
});

describe('sessionCan / canVisitPage：rbac 停用即全放行', () => {
  it('停用时没有登录用户也一律通过（免登录单人作业）', () => {
    expect(authStatus().enabled).toBe(false);
    expect(currentSessionUser()).toBeNull();
    expect(sessionCan('config.confirm')).toBe(true);
    expect(sessionCan('tool.write:wms.inbound.create')).toBe(true);
    expect(canVisitPage('users')).toBe(true);
    expect(canVisitPage('settings')).toBe(true);
  });

  it('启用但还没登录时一律拒绝', () => {
    noteAuthStatus(ENABLED);
    expect(currentSessionUser()).toBeNull();
    expect(sessionCan('page:dashboard')).toBe(false);
    expect(canVisitPage('users')).toBe(false);
    expect(canVisitPage('dashboard')).toBe(false);
  });

  it('启用且有用户时按 grants 判定，page:{页面} 决定导航', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person(['page:*', 'tool.read:*']));
    expect(canVisitPage('users')).toBe(true);
    expect(canVisitPage('reports')).toBe(true);
    expect(sessionCan('tool.read:wms.sku.list')).toBe(true);
    expect(sessionCan('tool.write:wms.picking.confirm')).toBe(false);
    expect(sessionCan('config.confirm')).toBe(false);
  });

  it('启用且 grants 为空时什么都进不去', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person([]));
    expect(canVisitPage('dashboard')).toBe(false);
    expect(sessionCan('config.propose')).toBe(false);
  });

  it('仓库经理那条 * 覆盖四类权限对象', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person(['*']));
    expect(canVisitPage('users')).toBe(true);
    expect(sessionCan('tool.write:wms.outbound.confirm')).toBe(true);
    expect(sessionCan('config.confirm')).toBe(true);
    expect(sessionCan('report.export:inventory')).toBe(true);
  });
});

describe('令牌与会话状态', () => {
  it('writeSessionToken 写进 localStorage 的 onewms.sessionToken，写 null 即删除', () => {
    expect(readSessionToken()).toBeNull();
    writeSessionToken('tok-123');
    expect(readSessionToken()).toBe('tok-123');
    expect(localStorage.getItem('onewms.sessionToken')).toBe('tok-123');
    writeSessionToken(null);
    expect(readSessionToken()).toBeNull();
    expect(localStorage.getItem('onewms.sessionToken')).toBeNull();
  });

  it('clearSession 同时清掉用户和令牌', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person(['*']));
    writeSessionToken('tok-123');
    clearSession();
    expect(currentSessionUser()).toBeNull();
    expect(readSessionToken()).toBeNull();
  });

  it('noteAuthStatus 收到 enabled:false 会把登录态清干净，不留「已登录」假象', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person(['*']));
    writeSessionToken('tok-123');

    noteAuthStatus({ enabled: false, bootstrapped: true, sessionTimeoutMinutes: 240 });

    expect(authStatus().enabled).toBe(false);
    expect(currentSessionUser()).toBeNull();
    expect(readSessionToken()).toBeNull();
    expect(localStorage.getItem('onewms.sessionToken')).toBeNull();
    // 清干净之后判定回到「停用即放行」
    expect(canVisitPage('users')).toBe(true);
  });

  it('启用状态下改 status（如超时时长）不动登录态', () => {
    noteAuthStatus(ENABLED);
    noteSessionUser(person(['*']));
    writeSessionToken('tok-123');

    noteAuthStatus({ enabled: true, bootstrapped: true, sessionTimeoutMinutes: 30 });

    expect(authStatus().sessionTimeoutMinutes).toBe(30);
    expect(currentSessionUser()?.username).toBe('manager');
    expect(readSessionToken()).toBe('tok-123');
  });
});

describe('noteSessionUser + subscribeSession：单例变更通知订阅者', () => {
  it('写入用户、退出登录、改 status 都会通知；退订后不再通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);

    noteAuthStatus(ENABLED);
    expect(listener).toHaveBeenCalledTimes(1);

    noteSessionUser(person(['page:*']));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(currentSessionUser()?.grants).toEqual(['page:*']);

    // 登出路径：clearSession 之后紧跟 noteSessionUser(null)，由后者发通知
    clearSession();
    noteSessionUser(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(currentSessionUser()).toBeNull();

    unsubscribe();
    noteSessionUser(person(['*']));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('多个订阅者都收到通知，各自退订互不影响', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeSession(first);
    subscribeSession(second);

    noteSessionUser(person(['*']));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    noteSessionUser(null);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
