import { describe, it, expect } from 'vitest';
import {
  OneCore,
  ModuleConflictError,
  ModuleDependencyError,
  ModuleNotFoundError,
  ModuleValidationError,
  compareSemver,
  validateManifest,
  type ModuleManifest,
  type WorkspaceFacade,
} from '../src/index.js';

/**
 * 模块系统（里程碑 6）：manifest 校验纯函数直测 + install/uninstall 受管管线。
 * 全部经 facade 公共 API（ModulesView）验证行为契约（服务层测试策略）。
 */

/** 造一个空内核 + 工作区 */
function setup(workspaceId = 'ws-modules') {
  const core = OneCore.open(':memory:');
  return { core, ws: core.workspace(workspaceId) };
}

/** 测试基线 manifest（按场景覆写分区） */
function makeManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'module.expiry',
    name: '保质期管理',
    description: 'SKU 保质期跟踪与预警',
    version: '1.0.0',
    capabilities: ['db.read'],
    fields: {
      provides: [{ entity: 'sku', key: 'expiry_date', label: '保质期', type: 'date' }],
    },
    ...overrides,
  };
}

/** 基础模块：提供 inbound 流程骨架 + 批次号字段（扩展模块的贡献目标） */
function baseModule(): ModuleManifest {
  return {
    id: 'module.base',
    name: '基础流程',
    description: '入库流程骨架与批次号字段',
    version: '1.0.0',
    capabilities: ['db.read'],
    fields: {
      provides: [{ entity: 'sku', key: 'batch_no', label: '批次号', type: 'string' }],
    },
    workflows: {
      base: {
        inbound: {
          states: [
            { id: 'created', label: '已创建' },
            { id: 'done', label: '完成' },
          ],
          transitions: [{ from: 'created', to: 'done' }],
        },
      },
    },
  };
}

/** 扩展模块：依赖批次号、提供保质期字段、向 inbound 贡献验收中状态 */
function expiryModule(): ModuleManifest {
  return {
    id: 'module.expiry',
    name: '保质期管理',
    description: 'SKU 保质期跟踪与预警',
    version: '1.0.0',
    capabilities: ['db.read'],
    fields: {
      provides: [{ entity: 'sku', key: 'expiry_date', label: '保质期', type: 'date' }],
      requires: [{ entity: 'sku', key: 'batch_no', expectType: 'string' }],
    },
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'inspecting', label: '验收中' }],
          transitions: [
            { from: 'created', to: 'inspecting' },
            { from: 'inspecting', to: 'done' },
          ],
        },
      },
    },
  };
}

/** 收集工作区内指定类型的全部事件 payload */
function eventsOf(ws: WorkspaceFacade, type: string): unknown[] {
  const payloads: unknown[] = [];
  ws.events.forEach((env) => {
    if (env.type === type) payloads.push(env.payload);
  });
  return payloads;
}

// ── 纯函数：manifest 结构校验 ─────────────────────────────

describe('validateManifest（结构校验纯函数）', () => {
  it('合法全景（全分区）零错误', () => {
    const { errors } = validateManifest({
      id: 'module.expiry',
      name: '保质期管理',
      description: 'SKU 保质期跟踪与预警',
      version: '1.2.3',
      minCoreVersion: '0.1.0',
      capabilities: ['db.read', 'events.subscribe'],
      slot: { name: 'expiry-policy' },
      dependencies: { modules: ['module.base'] },
      fields: {
        provides: [{ entity: 'sku', key: 'expiry_date', label: '保质期', type: 'date', sharing: 'shared', description: '到期日' }],
        requires: [{ entity: 'sku', key: 'batch_no', expectType: 'string' }],
      },
      tools: [{
        id: 'module.expiry.check',
        label: '保质期检查',
        description: '检查 SKU 保质期',
        parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
        permission: 'read',
      }],
      events: { subscribes: ['wms.sku.created'], publishes: ['module.expiry.warned'] },
      workflows: {
        base: {
          inbound: {
            states: [{ id: 'created', label: '已创建' }],
            transitions: [],
          },
        },
        contributes: {
          inbound: {
            states: [{ id: 'inspecting', label: '验收中' }],
            transitions: [{ from: 'created', to: 'inspecting' }],
          },
        },
      },
      settings: {
        schema: {
          type: 'object',
          properties: { warnDaysBefore: { type: 'number', default: 30 } },
        },
      },
    });
    expect(errors).toEqual([]);
  });

  it('逐项非法：身份段 / 能力词表 / 依赖自指', () => {
    const bad = makeManifest({
      id: 'module expiry!', // 空格非法
      name: '  ',
      version: '1.0',
      capabilities: ['db.drop', 'db.read', 'db.read'], // 词表外 + 重复
      signature: 'sha256:xxx', // v1 恒 null
      dependencies: { modules: ['module expiry!'] }, // 非空字符串检查 + 下面单独测自指
    });
    const { errors } = validateManifest(bad);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('MANIFEST_ID');
    expect(codes).toContain('MANIFEST_NAME');
    expect(codes).toContain('MANIFEST_VERSION');
    expect(codes.filter((c) => c === 'MANIFEST_CAPABILITY').length).toBeGreaterThanOrEqual(2); // 词表外 + 重复
    expect(codes).toContain('MANIFEST_SIGNATURE');
    expect(codes).toContain('MANIFEST_DEPENDENCIES');
  });

  it('依赖自指被拒；字段/工具/流程分区逐项非法', () => {
    const selfDep = makeManifest({ dependencies: { modules: ['module.expiry'] } });
    expect(validateManifest(selfDep).errors.map((e) => e.message).join()).toContain('依赖自己');

    const badFields = makeManifest({
      fields: {
        provides: [
          { entity: 'sku', key: 'expiry_date', label: '保质期', type: 'date' },
          { entity: 'sku', key: 'expiry_date', label: '重复', type: 'date' }, // 重复声明
          { entity: 'sku', key: 'temp', label: '温度', type: 'text' }, // 类型域外
        ],
        requires: [{ entity: 'sku', key: 'x', expectType: 'text' }], // expectType 域外
      },
    });
    const fieldErrors = validateManifest(badFields).errors.map((e) => e.message).join();
    expect(fieldErrors).toContain('重复');
    expect(fieldErrors).toContain('类型非法');

    const badTool = makeManifest({
      tools: [{
        id: 'no-namespace', // 无命名空间
        label: '工具',
        description: '',
        parameters: { type: 'object', properties: {} },
        permission: 'admin', // 域外
      }],
    });
    const toolErrors = validateManifest(badTool).errors.map((e) => e.message).join();
    expect(toolErrors).toContain('命名空间');
    expect(toolErrors).toContain('description');
    expect(toolErrors).toContain('permission');

    const badWorkflow = makeManifest({
      workflows: {
        base: { inbound: { states: [], transitions: [] } }, // 空状态
        contributes: {
          inbound: {
            states: [
              { id: 'a', label: 'A' },
              { id: 'a', label: '重复' }, // 贡献状态重复
            ],
            transitions: [{ from: '', to: 'a' }], // 缺 from
          },
        },
      },
    });
    const wfErrors = validateManifest(badWorkflow).errors.map((e) => e.message).join();
    expect(wfErrors).toContain('至少需要一个状态');
    expect(wfErrors).toContain('重复');
    expect(wfErrors).toContain('from/to');
  });

  it('compareSemver：数值三元组比较（非字典序）', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1); // 10 > 9，字典序会判反
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });
});

// ── install：受管安装管线 ─────────────────────────────────

describe('install：双轨落账 + 审计', () => {
  it('全流程：字段轨道 + config 轨道 + module.installed 审计事件', () => {
    const { core, ws } = setup();
    const before = ws.events.count();

    const result = ws.modules.install(makeManifest({
      settings: {
        schema: {
          type: 'object',
          properties: {
            warnDaysBefore: { type: 'number', default: 30 },
            frequency: { type: 'string', description: '无默认值不进 settings' },
          },
        },
      },
    }));
    expect(result.installed).toBe(true);

    // 轨道 A：字段（owner = 模块 id）
    expect(ws.fields.get('sku', 'expiry_date')).toMatchObject({
      owner: 'module.expiry',
      dataType: 'date',
      visible: true,
      usedBy: ['module.expiry'],
    });

    // 轨道 B：config（version 严格 +1、modules 段、settings 只含默认值）
    const snap = ws.profile.getSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.modules['module.expiry']).toEqual({
      enabled: true,
      version: '1.0.0',
      settings: { warnDaysBefore: 30 },
    });

    // 审计事件：payload 摘要 + actor 通道节点唯一（M5 约束）
    const installed = eventsOf(ws, 'module.installed');
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      id: 'module.expiry',
      name: '保质期管理',
      version: '1.0.0',
      capabilities: ['db.read'],
    });
    let actor = '';
    ws.events.forEach((env) => { if (env.type === 'module.installed') actor = env.actor; });
    expect(actor).toBe(`module:module.expiry@${core.nodeId}`);

    // 事件构成：registry.field.provided + config.change + module.installed
    expect(ws.events.count()).toBe(before + 3);
    core.close();
  });

  it('workflows.base 种子 + contributes 贡献（providedBy 标记 + 转移合并）', () => {
    const { core, ws } = setup();
    ws.modules.install(baseModule());
    ws.modules.install(expiryModule());

    const inbound = ws.profile.getSnapshot().workflows.inbound;
    expect(inbound.states.map((s) => s.id)).toEqual(['created', 'done', 'inspecting']);
    expect(inbound.states.find((s) => s.id === 'inspecting')?.providedBy).toBe('module.expiry');
    expect(inbound.states.find((s) => s.id === 'created')?.providedBy).toBeUndefined(); // 基础态无标记
    expect(inbound.transitions).toEqual([
      { from: 'created', to: 'done' },
      { from: 'created', to: 'inspecting' },
      { from: 'inspecting', to: 'done' },
    ]);
    core.close();
  });

  it('base 守卫：目标流程已存在则跳过（老库不覆盖既有配置）', () => {
    const { core, ws } = setup();
    // 老库：人工已配置 inbound（与 base 声明不同的形状）
    const { proposalId } = ws.profile.propose('ai:test', [
      {
        op: 'add',
        path: '/workflows/inbound',
        value: {
          states: [{ id: 'draft', label: '草稿' }, { id: 'archived', label: '归档' }],
          transitions: [{ from: 'draft', to: 'archived' }],
        },
      },
    ]);
    ws.profile.confirm(proposalId, 'node-human');

    ws.modules.install(baseModule());

    // 既有流程原样保留；modules 段照常登记
    const inbound = ws.profile.getSnapshot().workflows.inbound;
    expect(inbound.states.map((s) => s.id)).toEqual(['draft', 'archived']);
    expect(ws.profile.getSnapshot().modules['module.base'].enabled).toBe(true);
    core.close();
  });

  it('后装共享字段（老库收敛）：已存在且类型兼容 → owner 保持 + usedBy 追加', () => {
    const { core, ws } = setup();
    // M4 老库：core 已手工提供同名字段（同类型）
    ws.fields.provide('core', { entity: 'sku', key: 'expiry_date', label: '保质期', dataType: 'date', sharing: 'shared' });

    ws.modules.install(makeManifest());

    const field = ws.fields.get('sku', 'expiry_date');
    expect(field?.owner).toBe('core'); // 归属不篡改
    expect(field?.usedBy).toEqual(['core', 'module.expiry']);
    core.close();
  });

  it('幂等短路：同 id 同版本重装 → installed:false、零事件', () => {
    const { core, ws } = setup();
    ws.modules.install(makeManifest());
    const before = ws.events.count();
    const snapshotBefore = ws.profile.getSnapshot().version;

    const again = ws.modules.install(makeManifest());
    expect(again.installed).toBe(false);
    expect(ws.events.count()).toBe(before); // 文件库反复构造（WmsWorkspace 每次构造都装）零新事件
    expect(ws.profile.getSnapshot().version).toBe(snapshotBefore);
    core.close();
  });

  it('异版本重装被拒（v1 无原地升级——先卸载再装）', () => {
    const { core, ws } = setup();
    ws.modules.install(makeManifest());
    expect(() => ws.modules.install(makeManifest({ version: '1.1.0' }))).toThrow(ModuleConflictError);
    core.close();
  });
});

// ── install：预检逐项拒绝（「先证明后动手」）──────────────

describe('install：预检逐项拒绝（零事件）', () => {
  /** 统一模式：抛错类型 + 事件计数不变（预检失败不落任何事件） */
  function expectReject(ws: WorkspaceFacade, install: () => unknown, ErrorClass: new (...args: string[]) => Error): void {
    const before = ws.events.count();
    expect(install).toThrow(ErrorClass);
    expect(ws.events.count()).toBe(before);
  }

  it('manifest 结构非法 / minCoreVersion 高于当前内核', () => {
    const { core, ws } = setup();
    expectReject(ws, () => ws.modules.install(makeManifest({ version: 'bad' })), ModuleValidationError);
    expectReject(ws, () => ws.modules.install(makeManifest({ minCoreVersion: '999.0.0' })), ModuleValidationError);
    core.close();
  });

  it('依赖缺失 / 依赖已停用', () => {
    const { core, ws } = setup();
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({ dependencies: { modules: ['module.absent'] } })),
      ModuleDependencyError,
    );

    // 装依赖后经慢通道停用 → 依赖不在场（enabled:false）
    ws.modules.install(makeManifest({ id: 'module.dep', fields: undefined }));
    const { proposalId } = ws.profile.propose('ai:test', [
      { op: 'replace', path: '/modules/module.dep/enabled', value: false },
    ]);
    ws.profile.confirm(proposalId);
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({ id: 'module.need', fields: undefined, dependencies: { modules: ['module.dep'] } })),
      ModuleDependencyError,
    );
    core.close();
  });

  it('slot 择一型冲突（进程目录扫描占位者）', () => {
    const { core, ws } = setup();
    const a = makeManifest({ id: 'module.a', fields: undefined, slot: { name: 'pricing' } });
    core.exposeModuleRegistry().registerManifest(a);
    ws.modules.install(a);

    expectReject(
      ws,
      () => ws.modules.install(makeManifest({ id: 'module.b', fields: undefined, slot: { name: 'pricing' } })),
      ModuleConflictError,
    );
    core.close();
  });

  it('provides 字段类型冲突 / requires 字段不存在 / requires 类型不匹配', () => {
    const { core, ws } = setup();
    // 已存在 string，manifest 声明 date
    ws.fields.provide('core', { entity: 'sku', key: 'expiry_date', label: '保质期', dataType: 'string', sharing: 'shared' });
    expectReject(ws, () => ws.modules.install(makeManifest()), ModuleConflictError);

    expectReject(
      ws,
      () => ws.modules.install(makeManifest({ fields: { requires: [{ entity: 'sku', key: 'ghost' }] } })),
      ModuleDependencyError,
    );

    // 已存在 string，requires 期望 number
    ws.fields.provide('core', { entity: 'sku', key: 'batch_no', label: '批次号', dataType: 'string', sharing: 'shared' });
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({ fields: { requires: [{ entity: 'sku', key: 'batch_no', expectType: 'number' }] } })),
      ModuleConflictError,
    );
    core.close();
  });

  it('工具不在总线 / 工具 permission 与总线事实不一致', () => {
    const { core, ws } = setup();
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({
        tools: [{
          id: 'module.expiry.scan',
          label: '扫描保质期',
          description: '扫描录入',
          parameters: { type: 'object', properties: {} },
          permission: 'read',
        }],
      })),
      ModuleValidationError,
    );

    // 内核工具 profile.propose 事实为 write，声明为 read → 不一致
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({
        tools: [{
          id: 'profile.propose',
          label: '配置提议',
          description: '测试声明',
          parameters: { type: 'object', properties: {} },
          permission: 'read',
        }],
      })),
      ModuleValidationError,
    );
    core.close();
  });

  it('contributes 目标流程不存在 / 贡献状态 id 冲突', () => {
    const { core, ws } = setup();
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({
        fields: undefined,
        workflows: { contributes: { ghost_flow: { states: [{ id: 'x', label: 'X' }], transitions: [] } } },
      })),
      ModuleValidationError,
    );

    ws.modules.install(baseModule()); // inbound: created/done
    expectReject(
      ws,
      () => ws.modules.install(makeManifest({
        fields: undefined,
        workflows: { contributes: { inbound: { states: [{ id: 'created', label: '撞车' }], transitions: [] } } },
      })),
      ModuleConflictError,
    );
    core.close();
  });
});

// ── uninstall：逆操作（§6.2 表格）─────────────────────────

describe('uninstall：逆操作', () => {
  it('完整摘除：贡献状态/转移 + 字段处置 + modules 段移除 + 审计事件', () => {
    const { core, ws } = setup();
    ws.modules.install(baseModule());
    ws.modules.install(expiryModule());

    const report = ws.modules.uninstall('module.expiry');

    // 字段处置报告：释放 usage（batch_no）+ 自有字段软删除（expiry_date 无人接手）
    expect(report.fields.releasedUsages).toContainEqual({ entity: 'sku', qualifiedKey: 'batch_no' });
    expect(report.fields.ownedFields).toContainEqual({
      entity: 'sku',
      qualifiedKey: 'expiry_date',
      resolution: 'hidden',
    });

    // 注册表事实：expiry_date 软删除保留（数据永不丢）、batch_no 完好
    expect(ws.fields.get('sku', 'expiry_date')).toMatchObject({ visible: false, owner: 'module.expiry' });
    expect(ws.fields.get('sku', 'batch_no')).toMatchObject({ visible: true, owner: 'module.base', usedBy: ['module.base'] });

    // 流程摘除：providedBy 的状态 + 两端引用的转移（基础图不动）
    const inbound = ws.profile.getSnapshot().workflows.inbound;
    expect(inbound.states.map((s) => s.id)).toEqual(['created', 'done']);
    expect(inbound.transitions).toEqual([{ from: 'created', to: 'done' }]);

    // modules 段移除 + version 前进（装×2 + 卸×1 = 3）
    expect(ws.profile.getSnapshot().modules['module.expiry']).toBeUndefined();
    expect(report.newVersion).toBe(3);

    // 审计事件
    const uninstalled = eventsOf(ws, 'module.uninstalled');
    expect(uninstalled).toHaveLength(1);
    expect(uninstalled[0]).toMatchObject({ id: 'module.expiry', version: '1.0.0' });
    core.close();
  });

  it('字段移交：owner 卸载且仍有使用者 → transferred（字段跟随下一位使用者）', () => {
    const { core, ws } = setup();
    ws.modules.install(baseModule());
    ws.modules.install(expiryModule());

    const report = ws.modules.uninstall('module.base');

    expect(report.fields.ownedFields).toContainEqual({
      entity: 'sku',
      qualifiedKey: 'batch_no',
      resolution: 'transferred',
      newOwner: 'module.expiry',
    });
    expect(ws.fields.get('sku', 'batch_no')?.owner).toBe('module.expiry');
    expect(ws.fields.get('sku', 'batch_no')?.visible).toBe(true);

    // base 流程种子无 providedBy 标记 → 基础图不动（用户可见资产不随卸载破坏）
    expect(ws.profile.getSnapshot().workflows.inbound.states.map((s) => s.id)).toEqual(['created', 'done', 'inspecting']);
    expect(ws.profile.getSnapshot().modules['module.base']).toBeUndefined();
    core.close();
  });

  it('未安装的模块卸载被拒', () => {
    const { core, ws } = setup();
    expect(() => ws.modules.uninstall('module.ghost')).toThrow(ModuleNotFoundError);
    core.close();
  });
});

// ── 查询与重放 ───────────────────────────────────────────

describe('listInstalled / listManifests（聚合查询）', () => {
  it('已装模块聚合进程目录 manifest 元数据；无本地代码的安装记录 manifest 缺席', () => {
    const { core, ws } = setup();
    // 先落远端同步来的安装记录（seedDefaults 只在空配置时生效——M4 语义），再本地安装
    ws.profile.seedDefaults('module:core.wms', {
      modules: { 'module.remote': { enabled: true, version: '2.0.0' } },
    });

    const manifest = makeManifest();
    core.exposeModuleRegistry().registerManifest(manifest);
    ws.modules.install(manifest);

    const installed = ws.modules.listInstalled();
    expect(installed).toHaveLength(2);
    expect(installed.find((m) => m.id === 'module.expiry')).toMatchObject({ id: 'module.expiry', enabled: true, version: '1.0.0' });
    expect(installed.find((m) => m.id === 'module.expiry')?.manifest?.description).toBe('SKU 保质期跟踪与预警');

    // 进程目录（「可安装模块目录」）
    expect(ws.modules.listManifests().map((m) => m.id)).toEqual(['module.expiry']);
    expect(ws.modules.getManifest('module.expiry')?.name).toBe('保质期管理');

    // 远端同步来的安装记录（无本地代码）：只有 config 段，manifest 缺席
    ws.profile.seedDefaults('module:core.wms', {
      modules: { 'module.remote': { enabled: true, version: '2.0.0' } },
    });
    const remote = ws.modules.listInstalled().find((m) => m.id === 'module.remote');
    expect(remote).toMatchObject({ id: 'module.remote', version: '2.0.0' });
    expect(remote?.manifest).toBeUndefined();
    core.close();
  });
});

describe('replay：投影 = 事件重放（唯一真相）', () => {
  it('安装 + 卸载后重放，config / 注册表投影与重放前一致', () => {
    const { core, ws } = setup();
    ws.modules.install(baseModule());
    ws.modules.install(expiryModule());
    ws.modules.uninstall('module.expiry');
    const before = ws.profile.getSnapshot();

    ws.replay();

    expect(ws.profile.getSnapshot()).toEqual(before);
    core.close();
  });
});
