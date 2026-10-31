import { describe, it, expect } from 'vitest';
import {
  OneCore,
  ProfileValidationError,
  ProposalStateError,
  StaleProposalError,
  type PatchOp,
  type ProfileSnapshot,
} from '../src/index.js';

/**
 * 慢通道管线（里程碑 4）：propose → 影响报告 → 人工确认 → 热应用。
 * 全部经 facade 公共 API 验证行为契约（服务层测试策略）。
 */

/** 造一个空内核 + 工作区 */
function setup(workspaceId = 'ws-profile') {
  const core = OneCore.open(':memory:');
  return { core, ws: core.workspace(workspaceId) };
}

/** 在快照中定位字段索引（extensions 按 field_key 排序，测试里显式定位保证稳健） */
function fieldIndex(snapshot: ProfileSnapshot, entity: string, key: string): number {
  const idx = snapshot.schema.entities[entity]?.extensions.findIndex((f) => f.key === key) ?? -1;
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('Profile 快照（聚合投影）', () => {
  it('空工作区：version 0、无字段、无流程、roles 恒空', () => {
    const { core, ws } = setup();
    const snapshot = ws.profile.getSnapshot();
    expect(snapshot.version).toBe(0);
    expect(snapshot.schema.entities).toEqual({});
    expect(snapshot.workflows).toEqual({});
    expect(snapshot.modules).toEqual({});
    expect(snapshot.roles).toEqual({});
    core.close();
  });

  it('schema.entities 实时聚合自字段注册表（不存第二份真相）', () => {
    const { core, ws } = setup();
    ws.fields.provide('module.expiry', { entity: 'sku', key: 'expiry_date', label: '保质期', dataType: 'date', sharing: 'shared' });
    const snapshot = ws.profile.getSnapshot();
    expect(snapshot.schema.entities.sku.extensions).toEqual([
      { key: 'expiry_date', label: '保质期', type: 'date', visible: true, providedBy: 'module.expiry' },
    ]);
    core.close();
  });
});

describe('propose：校验三关', () => {
  it('语法关：路径根白名单外的操作被拒', () => {
    const { core, ws } = setup();
    expect(() => ws.profile.propose('user', [{ op: 'add', path: '/internal/x', value: 1 }])).toThrow(ProfileValidationError);
    core.close();
  });

  it('语义关：remove 字段被拒（软删除铁律：隐藏 = replace visible:false）', () => {
    const { core, ws } = setup();
    ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });
    expect(() =>
      ws.profile.propose('user', [{ op: 'remove', path: '/schema/entities/sku/extensions/0' }]),
    ).toThrow(/禁止删除字段/);
    core.close();
  });

  it('语义关：roles 冻结、when 条件域、转移引用完整性', () => {
    const { core, ws } = setup();
    const bad: PatchOp[][] = [
      // roles 冻结
      [{ op: 'add', path: '/roles/admin', value: {} }],
      // when 条件只认模块开关
      [
        {
          op: 'add',
          path: '/workflows/outbound',
          value: {
            states: [{ id: 'created', label: '已创建' }, { id: 'done', label: '完成' }],
            transitions: [{ from: 'created', to: 'done', when: 'user.isAdmin' }],
          },
        },
      ],
      // 转移引用不存在的状态
      [
        {
          op: 'add',
          path: '/workflows/outbound',
          value: {
            states: [{ id: 'created', label: '已创建' }],
            transitions: [{ from: 'created', to: 'ghost' }],
          },
        },
      ],
    ];
    for (const patch of bad) {
      expect(() => ws.profile.propose('user', patch)).toThrow(ProfileValidationError);
    }
    core.close();
  });

  it('语义关：流程连通性——孤立状态与无终态被拒', () => {
    const { core, ws } = setup();
    expect(() =>
      ws.profile.propose('user', [
        {
          op: 'add',
          path: '/workflows/inbound',
          value: {
            states: [
              { id: 'created', label: '已创建' },
              { id: 'received', label: '已收货' },
              { id: 'orphan', label: '孤立状态' },
            ],
            transitions: [{ from: 'created', to: 'received' }],
          },
        },
      ]),
    ).toThrow(/不可达/);

    expect(() =>
      ws.profile.propose('user', [
        {
          op: 'add',
          path: '/workflows/inbound',
          value: {
            states: [
              { id: 'created', label: '已创建' },
              { id: 'received', label: '已收货' },
            ],
            transitions: [
              { from: 'created', to: 'received' },
              { from: 'received', to: 'created' }, // 循环：无终态
            ],
          },
        },
      ]),
    ).toThrow(ProfileValidationError);
    core.close();
  });

  it('校验失败不产生任何事件与提议（提议不是事实）', () => {
    const { core, ws } = setup();
    const before = ws.events.count();
    try {
      ws.profile.propose('user', [{ op: 'add', path: '/workflows/x', value: 1 }]);
    } catch {
      // 预期失败
    }
    expect(ws.events.count()).toBe(before);
    expect(ws.profile.listPending()).toHaveLength(0);
    core.close();
  });
});

describe('propose → confirm：热应用双轨', () => {
  it('字段轨道：隐藏字段 → registry 事件、注册表生效、config version 不变', () => {
    const { core, ws } = setup();
    ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });

    const idx = fieldIndex(ws.profile.getSnapshot(), 'sku', 'spec');
    const { proposalId, report } = ws.profile.propose('ai:test', [
      { op: 'replace', path: `/schema/entities/sku/extensions/${idx}/visible`, value: false },
    ], '隐藏规格字段');

    expect(report.summary).toContain('隐藏');
    expect(report.items.some((i) => i.kind === 'field.hidden' && i.target === 'sku.spec')).toBe(true);

    const eventsBefore = ws.events.count();
    const { newVersion } = ws.profile.confirm(proposalId, 'node-human');

    // 字段变更走注册表事件，不落 config.change
    expect(newVersion).toBe(0);
    expect(ws.events.count()).toBe(eventsBefore + 1); // registry.field.visibility_changed
    expect(ws.fields.get('sku', 'spec')?.visible).toBe(false);
    // 快照聚合反映新状态
    expect(ws.profile.getSnapshot().schema.entities.sku.extensions[0].visible).toBe(false);
    // 审计：visibility_changed 的 actor 是确认者
    const marks = ws.events.watermarks();
    expect(marks['node-human'].seq).toBe(1);
    core.close();
  });

  it('流程轨道：config.change 落账、version 严格 +1、快照更新', () => {
    const { core, ws } = setup();
    const { proposalId } = ws.profile.propose('ai:test', [
      {
        op: 'add',
        path: '/workflows/outbound',
        value: {
          states: [
            { id: 'created', label: '已创建' },
            { id: 'done', label: '已完成' },
          ],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    ]);

    const eventsBefore = ws.events.count();
    const { newVersion } = ws.profile.confirm(proposalId, 'node-human');
    expect(newVersion).toBe(1);
    expect(ws.events.count()).toBe(eventsBefore + 1); // config.change

    const snapshot = ws.profile.getSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.workflows.outbound.states.map((s) => s.id)).toEqual(['created', 'done']);
    core.close();
  });

  it('混合 patch：字段 + 流程一次确认，双轨顺序执行', () => {
    const { core, ws } = setup();
    ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });

    const idx = fieldIndex(ws.profile.getSnapshot(), 'sku', 'spec');
    const { proposalId, report } = ws.profile.propose('ai:test', [
      { op: 'replace', path: `/schema/entities/sku/extensions/${idx}/visible`, value: false },
      {
        op: 'add',
        path: '/workflows/outbound',
        value: {
          states: [{ id: 'created', label: '已创建' }, { id: 'done', label: '完成' }],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    ]);
    expect(report.items).toHaveLength(2);

    const { newVersion } = ws.profile.confirm(proposalId);
    expect(newVersion).toBe(1);
    expect(ws.fields.get('sku', 'spec')?.visible).toBe(false);
    expect(ws.profile.getSnapshot().workflows.outbound).toBeDefined();
    core.close();
  });

  it('新增字段：add extension → provide 落账（actor = module:提供者）', () => {
    const { core, ws } = setup();
    const { proposalId } = ws.profile.propose('ai:test', [
      { op: 'add', path: '/schema/entities/sku/extensions/-', value: { key: 'shelf_life', label: '货架期', type: 'number', providedBy: 'core' } },
    ]);
    ws.profile.confirm(proposalId, 'node-human');

    expect(ws.fields.get('sku', 'shelf_life')).toMatchObject({ label: '货架期', dataType: 'number', visible: true });
    core.close();
  });

  it('模块轨道：enabled 开关 + settings 变更', () => {
    const { core, ws } = setup();
    ws.profile.seedDefaults('module:core.wms', {
      modules: { 'module.expiry': { enabled: false, settings: { warnDaysBefore: 30 } } },
    });

    const { proposalId, report } = ws.profile.propose('ai:test', [
      { op: 'replace', path: '/modules/module.expiry/enabled', value: true },
      { op: 'add', path: '/modules/module.expiry/settings/frequency', value: 'daily' },
    ]);
    expect(report.items.some((i) => i.kind === 'module.enabled' && i.severity === 'info')).toBe(true);

    const { newVersion } = ws.profile.confirm(proposalId);
    expect(newVersion).toBe(2);
    const mod = ws.profile.getSnapshot().modules['module.expiry'];
    expect(mod.enabled).toBe(true);
    expect(mod.settings).toEqual({ warnDaysBefore: 30, frequency: 'daily' });
    core.close();
  });
});

describe('确认工作流的护栏', () => {
  it('新鲜度检查：propose 后配置变化 → 提议过期拒绝', () => {
    const { core, ws } = setup();
    ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });
    const idx = fieldIndex(ws.profile.getSnapshot(), 'sku', 'spec');

    const { proposalId } = ws.profile.propose('ai:test', [
      { op: 'replace', path: `/schema/entities/sku/extensions/${idx}/visible`, value: false },
    ]);

    // propose 与 confirm 之间，外部发生了配置变更（另一条路径隐藏了它）
    ws.fields.setVisibility('someone-else', 'sku', 'spec', false);

    expect(() => ws.profile.confirm(proposalId)).toThrow(StaleProposalError);
    // 提议仍为 pending，可重新决策或拒绝
    expect(ws.profile.listPending()).toHaveLength(1);
    core.close();
  });

  it('版本过期：propose 后 config 版本前进 → 拒绝', () => {
    const { core, ws } = setup();
    const { proposalId: first } = ws.profile.propose('ai:test', [
      {
        op: 'add',
        path: '/workflows/a',
        value: { states: [{ id: 's', label: 'S' }], transitions: [] },
      },
    ]);
    const { proposalId: second } = ws.profile.propose('ai:test', [
      {
        op: 'add',
        path: '/workflows/b',
        value: { states: [{ id: 's', label: 'S' }], transitions: [] },
      },
    ]);
    ws.profile.confirm(first);
    expect(() => ws.profile.confirm(second)).toThrow(StaleProposalError);
    core.close();
  });

  it('reject：标记终态、零事件；重复操作被拒', () => {
    const { core, ws } = setup();
    const { proposalId } = ws.profile.propose('ai:test', [
      { op: 'add', path: '/workflows/a', value: { states: [{ id: 's', label: 'S' }], transitions: [] } },
    ]);
    const eventsBefore = ws.events.count();

    ws.profile.reject(proposalId);
    expect(ws.events.count()).toBe(eventsBefore); // 拒绝不落任何事件
    expect(ws.profile.listPending()).toHaveLength(0);

    // 已拒绝的提议不能再 confirm / reject（终态不可逆）
    expect(() => ws.profile.confirm(proposalId)).toThrow();
    expect(() => ws.profile.reject(proposalId)).toThrow(ProposalStateError);
    core.close();
  });
});

describe('种子与重放', () => {
  it('seedDefaults：首次装载 version 1；重复调用幂等', () => {
    const { core, ws } = setup();
    const first = ws.profile.seedDefaults('module:core.wms', {
      workflows: {
        inbound: {
          states: [{ id: 'created', label: '已创建' }, { id: 'done', label: '完成' }],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    });
    expect(first).toEqual({ seeded: true, version: 1 });

    const second = ws.profile.seedDefaults('module:core.wms', { workflows: { x: { states: [], transitions: [] } } });
    expect(second).toEqual({ seeded: false, version: 1 });
    // 第二次的 workflow 未被装载
    expect(ws.profile.getSnapshot().workflows.x).toBeUndefined();
    core.close();
  });

  it('replay：config 投影随事件重放重建，版本链一致', () => {
    const { core, ws } = setup();
    const { proposalId } = ws.profile.propose('ai:test', [
      {
        op: 'add',
        path: '/workflows/outbound',
        value: {
          states: [{ id: 'created', label: '已创建' }, { id: 'done', label: '完成' }],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    ]);
    ws.profile.confirm(proposalId, 'node-human'); // 提议确认后才落 config.change
    ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });
    const before = ws.profile.getSnapshot();
    expect(before.version).toBe(1);

    const result = ws.replay();
    expect(result.appliedConfigEvents).toBe(1);
    expect(result.appliedRegistryEvents).toBe(1);

    const after = ws.profile.getSnapshot();
    expect(after.version).toBe(1);
    expect(after.workflows.outbound).toEqual(before.workflows.outbound);
    expect(after.schema.entities.sku.extensions[0].key).toBe('spec');
    core.close();
  });
});

describe('AI 慢通道入口：profile.propose 工具', () => {
  it('经工具总线提议：返回影响报告、不直接修改配置、actor 审计', async () => {
    const { core, ws } = setup();

    // 工具已由内核注册（AI 可见）
    const tool = ws.tools.list().find((t) => t.id === 'profile.propose');
    expect(tool).toBeDefined();
    expect(tool!.permission).toBe('write');

    const result = (await ws.tools.invoke(
      'profile.propose',
      {
        patch: [
          {
            op: 'add',
            path: '/workflows/outbound',
            value: {
              states: [{ id: 'created', label: '已创建' }, { id: 'done', label: '完成' }],
              transitions: [{ from: 'created', to: 'done' }],
            },
          },
        ],
        note: '用户想简化出库流程',
      },
      'ai:qwen3:8b',
    )) as { proposalId: string; report: { summary: string; items: unknown[] }; pendingConfirm: boolean };

    // 提议产生但配置未变（AI 无权应用）
    expect(result.pendingConfirm).toBe(true);
    expect(result.report.items.length).toBeGreaterThan(0);
    expect(ws.profile.getSnapshot().version).toBe(0);

    // 待确认清单就绪，人类确认后生效
    expect(ws.profile.listPending()).toHaveLength(1);
    ws.profile.confirm(result.proposalId, 'node-human');
    expect(ws.profile.getSnapshot().version).toBe(1);

    // confirm 不是工具——人工确认权不可委托（§4.1）
    expect(ws.tools.list().some((t) => t.id.startsWith('profile.confirm') || t.id.startsWith('profile.reject'))).toBe(false);
    core.close();
  });

  it('校验失败以错误回传模型（错误回传不中断），零事件', async () => {
    const { core, ws } = setup();
    const eventsBefore = ws.events.count();

    await expect(
      ws.tools.invoke('profile.propose', { patch: [{ op: 'remove', path: '/schema/entities/sku/extensions/0' }] }, 'ai:test'),
    ).rejects.toThrow(/禁止删除字段/);
    expect(ws.events.count()).toBe(eventsBefore);
    core.close();
  });
});
