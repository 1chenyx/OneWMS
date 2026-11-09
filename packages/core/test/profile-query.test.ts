import { describe, it, expect } from 'vitest';
import { OneCore, ToolValidationError, type ModuleManifest } from '../src/index.js';

/**
 * 项目实况查询：流程、功能、字段。只读，不落事件。
 * 用合成模块把「装了 / 没装 / 停用后转移是否还能走」钉死。
 */

function baseModule(): ModuleManifest {
  return {
    id: 'module.base',
    name: '基础流程',
    description: '提供入库流程骨架。',
    version: '1.0.0',
    capabilities: ['db.read'],
    aliases: ['基础'],
    workflowAliases: { inbound: ['入库'] },
    workflows: {
      base: {
        inbound: {
          states: [
            { id: 'created', label: '已创建' },
            { id: 'done', label: '完成' },
          ],
          transitions: [{ from: 'created', to: 'done', effect: 'increase' }],
        },
      },
    },
    settings: {
      schema: {
        type: 'object',
        properties: {
          warnDays: { type: 'integer', description: '提前多少天预警', default: 30 },
        },
      },
    },
  };
}

function expiryModule(): ModuleManifest {
  return {
    id: 'module.expiry',
    name: '保质期',
    description: '向入库流程加一道验收。',
    version: '1.0.0',
    capabilities: ['db.read'],
    dependencies: { modules: ['module.base'] },
    fields: {
      provides: [{ entity: 'sku', key: 'expiry_date', label: '保质期', type: 'date', description: '到期日' }],
    },
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'inspecting', label: '验收中' }],
          transitions: [
            { from: 'created', to: 'inspecting', when: 'module.expiry.enabled', effect: 'none' },
            { from: 'inspecting', to: 'done', effect: 'increase' },
          ],
        },
      },
    },
  };
}

function setup() {
  const core = OneCore.open(':memory:');
  const ws = core.workspace('ws-profile-query');
  const registry = core.exposeModuleRegistry();
  registry.registerManifest(baseModule());
  registry.registerManifest(expiryModule());
  ws.modules.install(baseModule());
  ws.modules.install(expiryModule());
  return { core, ws };
}

describe('profile 实况查询', () => {
  it('概况列出流程、已装模块和字段数量', async () => {
    const { core, ws } = setup();
    const before = ws.events.count();
    const overview = (await ws.tools.invoke('profile.overview', {}, 'ai:general')) as {
      workflows: { id: string; stateChain: string }[];
      modules: { id: string; enabled: boolean; installed: boolean; name: string }[];
      fields: { entity: string; visible: number; hidden: number }[];
    };
    expect(ws.events.count()).toBe(before);
    expect(overview.workflows.find((wf) => wf.id === 'inbound')?.stateChain).toContain('已创建');
    expect(overview.workflows.find((wf) => wf.id === 'inbound')?.stateChain).toContain('验收中');
    expect(overview.modules.find((mod) => mod.id === 'module.expiry')).toMatchObject({
      name: '保质期',
      installed: true,
      enabled: true,
    });
    expect(overview.fields).toEqual([{ entity: 'sku', visible: 1, hidden: 0 }]);
    core.close();
  });

  it('流程查询标出当前走得通的转移；停用模块后条件边关掉', async () => {
    const { core, ws } = setup();
    const open = (await ws.tools.invoke('profile.workflow.query', { workflowId: 'inbound' })) as {
      workflows: { transitions: { from: string; to: string; active: boolean; whenLabel: string; effectLabel: string }[] }[];
    };
    const gate = open.workflows[0].transitions.find((t) => t.to === 'inspecting');
    expect(gate).toMatchObject({
      from: 'created',
      active: true,
      whenLabel: '仅当「保质期」启用',
      effectLabel: '明确不改数量',
    });
    expect(open.workflows[0].transitions.find((t) => t.to === 'done' && t.from === 'created')?.effectLabel).toBe('增加数量');

    const { proposalId } = ws.profile.propose(
      'user',
      [{ op: 'replace', path: '/modules/module.expiry/enabled', value: false }],
      '停用保质期',
    );
    ws.profile.confirm(proposalId, 'user');

    const closed = (await ws.tools.invoke('profile.workflow.query', { workflowId: 'inbound' })) as {
      workflows: { transitions: { to: string; active: boolean }[] }[];
    };
    expect(closed.workflows[0].transitions.find((t) => t.to === 'inspecting')?.active).toBe(false);
    await expect(ws.tools.invoke('profile.workflow.query', { workflowId: 'nope' })).rejects.toThrow(ToolValidationError);
    const byName = (await ws.tools.invoke('profile.workflow.query', { workflowId: '入库' })) as {
      workflows: { id: string; label: string }[];
    };
    expect(byName.workflows[0]).toMatchObject({ id: 'inbound', label: '入库' });
    core.close();
  });

  it('模块查询给出可配置设置的当前值，未安装的模块也列出来', async () => {
    const { core, ws } = setup();
    const parked: ModuleManifest = {
      id: 'module.parked',
      name: '未安装功能',
      description: '代码在，项目还没装。',
      version: '1.0.0',
      capabilities: ['db.read'],
    };
    core.exposeModuleRegistry().registerManifest(parked);

    const listed = (await ws.tools.invoke('profile.module.query', {})) as {
      modules: { id: string; installed: boolean; settings: { key: string; value: unknown; description: string }[] }[];
    };
    expect(listed.modules.find((mod) => mod.id === 'module.parked')).toMatchObject({ installed: false });
    expect(listed.modules.find((mod) => mod.id === 'module.base')?.settings).toContainEqual(
      expect.objectContaining({ key: 'warnDays', value: 30, description: '提前多少天预警' }),
    );

    const detail = (await ws.tools.invoke('profile.module.query', { moduleId: 'module.expiry' })) as {
      modules: { contributions: { workflowId: string; states: { id: string }[] }[]; fields: { key: string }[]; tools: unknown[] }[];
    };
    expect(detail.modules[0].contributions[0]).toMatchObject({ workflowId: 'inbound' });
    expect(detail.modules[0].contributions[0].states.map((s) => s.id)).toEqual(['inspecting']);
    expect(detail.modules[0].fields.map((f) => f.key)).toEqual(['expiry_date']);
    expect(detail.modules[0].tools).toEqual([]);
    await expect(ws.tools.invoke('profile.module.query', { moduleId: 'module.missing' })).rejects.toThrow(/没有模块/);
    const byName = (await ws.tools.invoke('profile.module.query', { moduleId: '保质期' })) as {
      modules: { id: string }[];
    };
    expect(byName.modules[0].id).toBe('module.expiry');
    core.close();
  });

  it('概况分出现在生效的和还能改的', async () => {
    const { core, ws } = setup();
    const overview = (await ws.tools.invoke('profile.overview', {})) as {
      shape: {
        enabled: { id: string }[];
        disabled: { id: string }[];
        notInstalled: { id: string }[];
        canChange: { toggleModule: string; fields: string; notInstalled: string };
        objects: { entity: string; visibleExtensions: number; fixed: number }[];
      };
    };
    expect(overview.shape.enabled.map((item) => item.id)).toEqual(['module.base', 'module.expiry']);
    expect(overview.shape.disabled).toEqual([]);
    expect(overview.shape.notInstalled).toEqual([]);
    expect(overview.shape.canChange.toggleModule).toContain('/modules/');
    expect(overview.shape.canChange.fields).toContain('扩展字段');
    expect(overview.shape.canChange.notInstalled).toContain('不能安装');
    expect(overview.shape.objects).toEqual([
      expect.objectContaining({ entity: 'sku', visibleExtensions: 1, fixed: 0 }),
    ]);
    core.close();
  });

  it('字段查询返回类型和可见性', async () => {
    const { core, ws } = setup();
    const result = (await ws.tools.invoke('profile.field.query', { entity: 'sku' })) as {
      entities: { entity: string; fields: { key: string; label: string; type: string; visible: boolean }[] }[];
    };
    expect(result.entities).toEqual([
      {
        entity: 'sku',
        fields: [
          expect.objectContaining({ key: 'expiry_date', label: '保质期', type: 'date', visible: true }),
        ],
      },
    ]);
    await expect(ws.tools.invoke('profile.field.query', { entity: 'ghost' })).rejects.toThrow(/没有实体/);
    core.close();
  });

  it('固定列按中文别名能查到，未安装模块的列不出现', async () => {
    const { core, ws } = setup();
    const stock: ModuleManifest = {
      id: 'module.stock',
      name: '库存列',
      description: '声明库存固定列。',
      version: '1.0.0',
      capabilities: ['db.read'],
      records: [
        {
          id: 'inventory',
          label: '库存',
          aliases: ['stock'],
          note: '固定列',
          fields: [{ key: 'quantity', label: '当前余量', description: '实物数量' }],
        },
      ],
    };
    const parked: ModuleManifest = {
      id: 'module.parked',
      name: '未安装',
      description: '不该出现。',
      version: '1.0.0',
      capabilities: ['db.read'],
      records: [{ id: 'ghostrec', label: '幽灵', fields: [{ key: 'x', label: 'X' }] }],
    };
    const registry = core.exposeModuleRegistry();
    registry.registerManifest(stock);
    registry.registerManifest(parked);
    ws.modules.install(stock);

    const byAlias = (await ws.tools.invoke('profile.field.query', { entity: '库存' })) as {
      entities: { entity: string; label: string; note: string; fixed: { key: string }[]; fields: unknown[] }[];
    };
    expect(byAlias.entities).toEqual([
      {
        entity: 'inventory',
        label: '库存',
        note: '固定列',
        fixed: [{ key: 'quantity', label: '当前余量', description: '实物数量' }],
        fields: [],
      },
    ]);
    const byId = (await ws.tools.invoke('profile.field.query', { entity: 'Inventory' })) as {
      entities: { entity: string }[];
    };
    expect(byId.entities[0].entity).toBe('inventory');

    const all = (await ws.tools.invoke('profile.field.query', {})) as { entities: { entity: string }[] };
    expect(all.entities.map((item) => item.entity)).toEqual(['inventory', 'sku']);

    await expect(ws.tools.invoke('profile.field.query', { entity: '幽灵' })).rejects.toThrow(/没有实体/);
    await expect(ws.tools.invoke('profile.field.query', { entity: 'nope' })).rejects.toThrow(/inventory（库存）/);
    core.close();
  });
});
