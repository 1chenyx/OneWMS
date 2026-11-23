import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { WmsDomain } from '../src/index.js';

/**
 * P0 两个模块的落地口径（docs/ROADMAP.md §3.1 / §3.4）：
 *  - module.scenario 场景作业：装上即启用，是表单、AI 之外的第三种作业入口；
 *  - module.rbac 用户与角色：装上但**默认停用**。代码里连接模式只有 lan / platform，
 *    没有 local，所以「本地单人不需要账号」落地为默认停用——单人作业免登录，
 *    要多人时经慢通道打开。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-p0-modules');
});

afterEach(() => {
  core.close();
});

function propose(patch: PatchOp[], note: string): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, note);
  ws.profile.confirm(proposalId, 'user:tester');
}

function enabled(moduleId: string): boolean {
  return ws.profile.getSnapshot().modules[moduleId]?.enabled === true;
}

interface ModuleView {
  name: string;
  installed: boolean;
  enabled: boolean;
  description: string;
  settings: { key: string; value: unknown }[];
}

async function query(moduleId: string): Promise<ModuleView> {
  const view = (await ws.tools.invoke('profile.module.query', { moduleId })) as {
    modules: ModuleView[];
  };
  expect(view.modules).toHaveLength(1);
  return view.modules[0]!;
}

describe('module.scenario 场景作业', () => {
  it('装上即启用，模块目录里查得到', async () => {
    const view = await query('module.scenario');
    expect(view).toMatchObject({ name: '场景作业', installed: true, enabled: true });
    expect(view.description).toContain('扫码');
  });

  it('三个 settings 有默认值：默认场景、拣货路径、声音反馈', async () => {
    const { settings } = await query('module.scenario');
    expect(settings.find((s) => s.key === 'defaultScenario')?.value).toBe('receive');
    expect(settings.find((s) => s.key === 'pickPathStrategy')?.value).toBe('locationCode');
    expect(settings.find((s) => s.key === 'feedbackSound')?.value).toBe(true);
  });

  it('可以经慢通道停用；停用不删档案，重新启用即恢复', () => {
    propose([{ op: 'replace', path: '/modules/module.scenario/enabled', value: false }], '关场景');
    expect(enabled('module.scenario')).toBe(false);
    propose([{ op: 'replace', path: '/modules/module.scenario/enabled', value: true }], '开回来');
    expect(enabled('module.scenario')).toBe(true);
  });
});

describe('module.rbac 用户与角色', () => {
  it('装上但默认停用：单人本地作业不需要账号', async () => {
    const view = await query('module.rbac');
    expect(view).toMatchObject({ name: '用户与角色', installed: true, enabled: false });
  });

  it('settings 默认值到位：会话 240 分钟、创建即指派关着', async () => {
    const { settings } = await query('module.rbac');
    expect(settings.find((s) => s.key === 'sessionTimeoutMinutes')?.value).toBe(240);
    expect(settings.find((s) => s.key === 'assignOnCreate')?.value).toBe(false);
  });

  it('经慢通道打开后生效，再关掉也不删档案', () => {
    propose([{ op: 'replace', path: '/modules/module.rbac/enabled', value: true }], '多人作业，开账号');
    expect(enabled('module.rbac')).toBe(true);
    propose([{ op: 'replace', path: '/modules/module.rbac/enabled', value: false }], '回到单人');
    expect(enabled('module.rbac')).toBe(false);
    expect(ws.profile.getSnapshot().modules['module.rbac']).toBeDefined();
  });

  it('不借 ConfigState.roles：账号体系落在宿主层，不进会被同步、会被 AI 读到的事实流', () => {
    // profile-types.ts 注明 ConfigState.roles 是 v1 预留、恒空
    expect(Object.keys(ws.profile.getSnapshot().roles ?? {})).toEqual([]);
  });
});
