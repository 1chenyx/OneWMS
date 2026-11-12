import { describe, expect, it } from 'vitest';
import { dedupeConfigState, OneCore, type ConfigState } from '../src/index.js';

describe('dedupeConfigState', () => {
  it('状态 id 与同一条转移只留第一次，when 不同的边都留', () => {
    const dirty: ConfigState = {
      workflows: {
        inbound: {
          states: [
            { id: 'created', label: '已创建' },
            { id: 'inspected', label: '已质检', providedBy: 'module.qc' },
            { id: 'inspected', label: '已质检', providedBy: 'module.qc' },
          ],
          transitions: [
            { from: 'created', to: 'inspected', providedBy: 'module.qc' },
            { from: 'created', to: 'inspected', providedBy: 'module.qc' },
            { from: 'created', to: 'inspected', when: 'module.qc.enabled', providedBy: 'module.qc' },
          ],
        },
      },
      modules: {},
      roles: {},
    };

    const healed = dedupeConfigState(dirty);
    expect(healed.workflows.inbound.states.map((s) => s.id)).toEqual(['created', 'inspected']);
    expect(healed.workflows.inbound.transitions).toEqual([
      { from: 'created', to: 'inspected', providedBy: 'module.qc' },
      { from: 'created', to: 'inspected', when: 'module.qc.enabled', providedBy: 'module.qc' },
    ]);
    expect(dedupeConfigState(healed)).toBe(healed);
  });
});

describe('同步拼链留下的重复流程状态', () => {
  it('读投影时折叠，之后的配置写入不再被整份快照拒绝', () => {
    const core = OneCore.open(':memory:');
    const ws = core.workspace('ws-heal');
    ws.profile.seedDefaults('module:test', {
      workflows: {
        inbound: {
          states: [
            { id: 'created', label: '已创建' },
            { id: 'done', label: '完成' },
          ],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    });

    const db = core.exposeDb();
    const row = db
      .prepare<[string], { workflows: string }>('SELECT workflows FROM profile_state WHERE workspace_id = ?')
      .get('ws-heal');
    const workflows = JSON.parse(row!.workflows) as ConfigState['workflows'];
    workflows.inbound.states.push({ id: 'done', label: '完成', providedBy: 'module.qc' });
    workflows.inbound.transitions.push({ from: 'created', to: 'done' });
    db.prepare('UPDATE profile_state SET workflows = ? WHERE workspace_id = ?').run(
      JSON.stringify(workflows),
      'ws-heal',
    );

    const seen = ws.profile.getSnapshot().workflows.inbound;
    expect(seen.states.map((s) => s.id)).toEqual(['created', 'done']);
    expect(seen.transitions).toHaveLength(1);

    const { proposalId } = ws.profile.propose('user:test', [
      { op: 'replace', path: '/workflows/inbound/states/0/label', value: '草稿' },
    ]);
    ws.profile.confirm(proposalId, 'user:test');

    const stored = db
      .prepare<[string], { workflows: string }>('SELECT workflows FROM profile_state WHERE workspace_id = ?')
      .get('ws-heal');
    const after = JSON.parse(stored!.workflows) as ConfigState['workflows'];
    expect(after.inbound.states.map((s) => s.id)).toEqual(['created', 'done']);
    expect(after.inbound.states[0].label).toBe('草稿');
    expect(after.inbound.transitions).toHaveLength(1);
    core.close();
  });
});
