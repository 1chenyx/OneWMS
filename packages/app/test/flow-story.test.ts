import { describe, expect, it } from 'vitest';
import type { ModuleConfig, WorkflowDef } from '@one/core';
import { buildFlowRecipe, buildFlowStory, diffStory, stateLabel } from '../src/lib/flow-story';
import { humanizeImpact } from '../src/lib/module-present';

/**
 * 流程故事：主步骤把可选能力排进去，抄近路和还没打开的步骤分开。
 */

const modules = (enabled: Record<string, boolean>): Record<string, ModuleConfig> =>
  Object.fromEntries(Object.entries(enabled).map(([id, on]) => [id, { enabled: on, version: '0.1.0' }]));

const inbound: WorkflowDef = {
  states: [
    { id: 'created', label: '已创建' },
    { id: 'received', label: '已收货' },
    { id: 'done', label: '已完成' },
    { id: 'canceled', label: '已取消' },
    { id: 'announced', label: '已预报', providedBy: 'module.asn' },
    { id: 'putaway', label: '已上架', providedBy: 'module.putaway' },
  ],
  transitions: [
    { from: 'created', to: 'received' },
    { from: 'received', to: 'done' },
    { from: 'created', to: 'canceled' },
    { from: 'created', to: 'announced', when: 'module.asn.enabled', effect: 'none' },
    { from: 'announced', to: 'received', effect: 'increase' },
    { from: 'announced', to: 'canceled', effect: 'none' },
    { from: 'received', to: 'putaway', when: 'module.putaway.enabled' },
    { from: 'putaway', to: 'done' },
    { from: 'received', to: 'canceled', when: 'module.reversal.enabled', effect: 'decrease' },
  ],
};

const allOn = modules({ 'module.asn': true, 'module.putaway': true, 'module.reversal': true });

describe('buildFlowStory', () => {
  it('预报和上架都开着时，主步骤走长的那条，抄近路留在旁边', () => {
    const story = buildFlowStory(inbound, allOn);
    expect(story.steps.map((step) => step.id)).toEqual(['created', 'announced', 'received', 'putaway', 'done']);
    expect(story.steps[0]?.sides).toEqual([
      { to: 'received', kind: 'skip' },
      { to: 'canceled', kind: 'cancel' },
    ]);
    expect(story.steps[2]?.sides).toEqual([
      { to: 'done', kind: 'skip' },
      { to: 'canceled', kind: 'cancel' },
    ]);
    expect(story.dormantInserts).toEqual([]);
    expect(story.dormantActions).toEqual([]);
  });

  it('预报关掉后，已预报变成插在已创建后面的未开启步骤', () => {
    const story = buildFlowStory(inbound, modules({ 'module.asn': false, 'module.putaway': true, 'module.reversal': true }));
    expect(story.steps.map((step) => step.id)).toEqual(['created', 'received', 'putaway', 'done']);
    expect(story.dormantInserts).toEqual([
      {
        from: 'created',
        to: 'announced',
        moduleId: 'module.asn',
        enableToActivate: true,
        insertsState: true,
      },
    ]);
  });

  it('冲销关掉后，已收货上多一个未开启的取消，不另画一步', () => {
    const story = buildFlowStory(inbound, modules({ 'module.asn': true, 'module.putaway': true, 'module.reversal': false }));
    expect(story.dormantActions).toEqual([
      {
        from: 'received',
        to: 'canceled',
        moduleId: 'module.reversal',
        enableToActivate: true,
        insertsState: false,
      },
    ]);
    expect(story.dormantInserts).toEqual([]);
  });

  it('环不会把主步骤走死', () => {
    const loop: WorkflowDef = {
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      transitions: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(buildFlowStory(loop, {}).steps.map((step) => step.id)).toEqual(['a', 'b']);
  });
});

describe('diffStory', () => {
  it('关掉上架：主步骤去掉已上架，只少掉进入上架的那条边', () => {
    const before = allOn;
    const after = modules({ 'module.asn': true, 'module.putaway': false, 'module.reversal': true });
    const change = diffStory(inbound, before, after);
    expect(change.pathBefore).toEqual(['created', 'announced', 'received', 'putaway', 'done']);
    expect(change.pathAfter).toEqual(['created', 'announced', 'received', 'done']);
    expect(change.lost).toEqual([{ from: 'received', to: 'putaway' }]);
    expect(change.gained).toEqual([]);
    expect(stateLabel(inbound, 'putaway')).toBe('已上架');
  });
});

describe('buildFlowRecipe', () => {
  it('关掉的步骤留在原位，开着的步骤标出可以绕过', () => {
    const on = buildFlowRecipe(inbound, allOn);
    expect(on.map((step) => step.id)).toEqual(['created', 'announced', 'received', 'putaway', 'done']);
    expect(on.every((step) => step.active)).toBe(true);
    expect(on.find((step) => step.id === 'announced')).toMatchObject({ moduleId: 'module.asn', skipTo: 'received' });
    expect(on.find((step) => step.id === 'putaway')).toMatchObject({ moduleId: 'module.putaway', skipTo: 'done' });

    const asnOff = buildFlowRecipe(inbound, modules({ 'module.asn': false, 'module.putaway': true, 'module.reversal': true }));
    expect(asnOff.map((step) => [step.id, step.active])).toEqual([
      ['created', true],
      ['announced', false],
      ['received', true],
      ['putaway', true],
      ['done', true],
    ]);
    expect(asnOff.find((step) => step.id === 'announced')?.skipTo).toBeUndefined();
    expect(asnOff.map((step) => step.id)).not.toContain('canceled');
  });
});

describe('流程页的说法', () => {
  it('影响报告里的模块 id 换成名字', () => {
    const text = humanizeImpact('模块「module.putaway」停用', (id) => (id === 'module.putaway' ? '上架作业' : id));
    expect(text).toBe('模块「上架作业」停用');
    expect(humanizeImpact('流程「inbound」', () => 'x')).toBe('流程「入库」');
  });
});
