import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OneCore,
  ModuleValidationError,
  ModuleConflictError,
  validateManifest,
  type ModuleManifest,
  type WorkspaceFacade,
} from '../src/index.js';

/**
 * B.1 声明式模块注册：proposeInstall（静态三关）→ 确认分派 → manifest 持久化。
 * 全部经 facade 公共 API 验证行为契约（服务层测试策略）。
 */

const dirs: string[] = [];
afterEach(() => {
  // Windows：better-sqlite3 句柄释放有延迟，清理临时目录需重试
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 清理失败不影响测试判定，留给系统临时目录回收
    }
  }
});

/** 文件库（重开验证持久化必须落盘；内存库无法跨实例） */
function openFileCore() {
  const dir = mkdtempSync(join(tmpdir(), `onewms-dyn-${randomUUID().slice(0, 8)}-`));
  dirs.push(dir);
  const core = OneCore.open(join(dir, 'wms.db'));
  return { core, ws: core.workspace('ws-dyn'), path: join(dir, 'wms.db') };
}

/** 声明式模块 manifest：实体 id 落在 dyn 命名空间 */
function dynManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'vendor.extra',
    name: '供应商扩展档案',
    description: '供应商资质等辅助档案（纯 JSON 声明，无本地代码）',
    version: '1.0.0',
    capabilities: ['db.read'],
    records: [
      {
        id: 'dyn.vendor.extra.qualification',
        label: '供应商资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string', queryable: true, description: '对外唯一编码' },
          { key: 'cert_level', label: '资质等级', type: 'string' },
          { key: 'valid_until', label: '有效期至', type: 'date' },
        ],
      },
    ],
    ...overrides,
  };
}

function countEvents(ws: WorkspaceFacade, type: string): number {
  let n = 0;
  ws.events.forEach((env) => { if (env.type === type) n++; });
  return n;
}

// ── 提案期静态三关（结构 / 命名空间 / 撞名）──────────────

describe('proposeInstall：提案期静态拒绝（零事件）', () => {
  it('records 列缺 type 被拒（声明式实体的类型是入参校验与 AI 描述的唯一依据）', () => {
    const { core, ws } = openFileCore();
    const bad = dynManifest({
      records: [{ id: 'dyn.vendor.extra.x', label: 'X', fields: [{ key: 'k', label: 'K' }] }],
    });
    expect(() => ws.modules.proposeInstall(bad)).toThrow(ModuleValidationError);
    expect(() => ws.modules.proposeInstall(bad)).toThrow(/缺少 type/);
    expect(ws.events.count()).toBe(0);
    core.close();
  });

  it('实体 id 逃逸命名空间被拒（裸 id / 冒用其他模块命名空间 / 前缀不完整）', () => {
    const { core, ws } = openFileCore();
    const bare = dynManifest({
      records: [{ id: 'inventory', label: '库存', fields: [{ key: 'qty', label: '数量', type: 'number' }] }],
    });
    expect(() => ws.modules.proposeInstall(bare)).toThrow(/命名空间/);

    const stolen = dynManifest({
      records: [{ id: 'dyn.other_module.thing', label: '别人的命名空间', fields: [{ key: 'k', label: 'K', type: 'string' }] }],
    });
    // 结构校验阶段就拒：id 只能落在本模块命名空间内
    expect(() => ws.modules.proposeInstall(stolen)).toThrow(/须为 dyn\.vendor\.extra|非法/);

    const half = dynManifest({
      records: [{ id: 'dyn.vendor.extra', label: '缺 recordId 段', fields: [{ key: 'k', label: 'K', type: 'string' }] }],
    });
    expect(() => ws.modules.proposeInstall(half)).toThrow(/须为 dyn\.vendor\.extra|非法/);
    expect(ws.events.count()).toBe(0);
    core.close();
  });

  it('与已声明实体撞名被拒（含未安装的内置模块，撞别名同样被拒）', () => {
    const { core, ws } = openFileCore();
    // 内置模块：注册进目录但**未安装**——撞名检查必须覆盖「还没装上」的目录条目
    core.exposeModuleRegistry().registerManifest({
      id: 'module.inventory',
      name: '库存',
      description: '内置库存',
      version: '1.0.0',
      capabilities: ['db.read'],
      records: [{ id: 'inventory', label: '库存', aliases: ['现存量'], fields: [{ key: 'qty', label: '数量' }] }],
    });

    const clashId = dynManifest({
      records: [{ id: 'dyn.vendor.extra.inventory', label: 'X', fields: [{ key: 'k', label: 'K', type: 'string' }], aliases: ['现存量'] }],
    });
    // id 在自己的命名空间内、结构合法——但别名「现存量」撞了内置实体
    expect(() => ws.modules.proposeInstall(clashId)).toThrow(/占用/);

    const clashAlias = dynManifest({
      records: [
        { id: 'dyn.vendor.extra.qualification', label: '供应商资质', aliases: ['inventory'], fields: [{ key: 'k', label: 'K', type: 'string' }] },
      ],
    });
    expect(() => ws.modules.proposeInstall(clashAlias)).toThrow(/占用/);
    expect(ws.events.count()).toBe(0);
    core.close();
  });

  it('重装自己模块的实体 id 放行（excludeModuleId：升级场景不自我撞名）', () => {
    const { core, ws } = openFileCore();
    const { proposalId } = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(proposalId, 'node-human');

    // 重装同 id：命中的全是自己的名字 → 不报撞名（后续由幂等/冲突预检判定）
    expect(() => ws.modules.proposeInstall(dynManifest())).not.toThrow();
    core.close();
  });
});

// ── 确认分派：kind 路由 ─────────────────────────────────

describe('proposeInstall → confirm：kind 分派与落账', () => {
  it('注册提议进待确认队列（kind=dyn.module.register），与配置补丁提议同列', () => {
    const { core, ws } = openFileCore();
    const { proposalId, report } = ws.modules.proposeInstall(dynManifest(), { proposedBy: 'ai:test', note: '客户要加资质档案' });
    const pending = ws.profile.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ proposalId, kind: 'dyn.module.register', proposedBy: 'ai:test' });
    expect(report.summary).toContain('vendor.extra');
    expect(report.items.some((item) => item.target === 'dyn.vendor.extra.qualification' && item.kind === 'record.added')).toBe(true);

    // 补丁提议同队列：先确认安装，再对已装模块提 patch（replace 需目标在场）
    ws.profile.confirm(proposalId, 'node-human');
    const { proposalId: patchId } = ws.profile.propose('ai:test', [{ op: 'replace', path: '/modules/vendor.extra/enabled', value: false }]);
    expect(ws.profile.listPending().map((p) => p.kind)).toEqual(['patch']);
    expect(() => ws.profile.getProposal(patchId)).not.toThrow();
    core.close();
  });

  it('确认 → install：字段/无（本例无字段）、config.change 携带 manifest、审计事件、AI 目录可见', () => {
    const { core, ws } = openFileCore();
    const { proposalId } = ws.modules.proposeInstall(dynManifest());
    const before = ws.events.count();

    const result = ws.profile.confirm(proposalId, 'node-human');
    expect(result.appliedOps).toBe(1);

    // 落账：module.installed 审计 + config.change（比提议期多 2 条事件）
    expect(countEvents(ws, 'module.installed')).toBe(1);
    expect(ws.events.count()).toBe(before + 2);

    // config 段：enabled + 整份 manifest 随 oplog 持久化
    const snap = ws.profile.getSnapshot();
    expect(snap.modules['vendor.extra']).toMatchObject({ enabled: true, version: '1.0.0' });
    expect(snap.modules['vendor.extra']?.manifest?.records?.[0]?.id).toBe('dyn.vendor.extra.qualification');

    // AI 目录：effectiveManifests 含声明式模块，实体与列类型可见
    const effective = ws.modules.effectiveManifests().find((m) => m.id === 'vendor.extra');
    expect(effective?.records?.[0]?.fields[0]).toMatchObject({ key: 'vendor_code', type: 'string', queryable: true });

    // 提议终态：重复确认被拒
    expect(() => ws.profile.confirm(proposalId, 'node-human')).toThrow();
    core.close();
  });

  it('确认时刻的动态拒绝：依赖缺失 → 提议仍留 pending（可修好依赖后重试，不静默丢弃）', () => {
    const { core, ws } = openFileCore();
    const needy = dynManifest({ dependencies: { modules: ['module.absent'] } });
    const { proposalId } = ws.modules.proposeInstall(needy);

    expect(() => ws.profile.confirm(proposalId, 'node-human')).toThrow(/依赖/);
    expect(ws.profile.getProposal(proposalId).status).toBe('pending');
    core.close();
  });

  it('同版本已装 → 幂等确认：零新事件、提议终态 applied', () => {
    const { core, ws } = openFileCore();
    const first = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(first.proposalId, 'node-human');
    const before = ws.events.count();

    const second = ws.modules.proposeInstall(dynManifest());
    const result = ws.profile.confirm(second.proposalId, 'node-human');
    expect(result.appliedOps).toBe(1);
    expect(ws.events.count()).toBe(before); // 幂等短路零事件
    expect(ws.profile.getProposal(second.proposalId).status).toBe('applied');
    core.close();
  });

  it('异版本重装 → 确认被冲突预检拒绝，提议留 pending（v1 无原地升级）', () => {
    const { core, ws } = openFileCore();
    const first = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(first.proposalId, 'node-human');

    const bumped = ws.modules.proposeInstall(dynManifest({ version: '1.1.0' }));
    expect(() => ws.profile.confirm(bumped.proposalId, 'node-human')).toThrow(ModuleConflictError);
    expect(ws.profile.getProposal(bumped.proposalId).status).toBe('pending');
    core.close();
  });
});

// ── 持久化：manifest 随 config.change 重放后仍在场 ────────

describe('manifest 持久化（重启 / replay 后仍在场）', () => {
  it('关闭重开文件库：声明式模块经 config.change 重放，manifest 与实体目录在场', () => {
    const { core, ws, path } = openFileCore();
    const { proposalId } = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(proposalId, 'node-human');
    core.close();

    const core2 = OneCore.open(path);
    const ws2 = core2.workspace('ws-dyn');
    const installed = ws2.modules.listInstalled().find((m) => m.id === 'vendor.extra');
    expect(installed).toMatchObject({ id: 'vendor.extra', enabled: true, version: '1.0.0' });
    // 代码不在场 → manifest 只能从 config 投影里回来（进程目录里没有它）
    expect(ws2.modules.listManifests().map((m) => m.id)).not.toContain('vendor.extra');
    expect(installed?.manifest?.records?.[0]?.id).toBe('dyn.vendor.extra.qualification');
    expect(ws2.modules.effectiveManifests().find((m) => m.id === 'vendor.extra')?.records).toHaveLength(1);
    core2.close();
  });

  it('replay 全量重放：确认后的快照与重放后一致', () => {
    const { core, ws } = openFileCore();
    const { proposalId } = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(proposalId, 'node-human');
    const before = ws.profile.getSnapshot();

    ws.replay();
    expect(ws.profile.getSnapshot()).toEqual(before);
    core.close();
  });

  it('卸载声明式模块：manifest 随 modules 段移除，实体目录不再可见', () => {
    const { core, ws } = openFileCore();
    const { proposalId } = ws.modules.proposeInstall(dynManifest());
    ws.profile.confirm(proposalId, 'node-human');

    ws.modules.uninstall('vendor.extra');
    const snap = ws.profile.getSnapshot();
    expect(snap.modules['vendor.extra']).toBeUndefined();
    expect(ws.modules.effectiveManifests().find((m) => m.id === 'vendor.extra')).toBeUndefined();
    core.close();
  });
});

// ── 内置 manifest 的 dyn. 保留字 ─────────────────────────

describe('dyn. 前缀是声明式模块保留字', () => {
  it('内置 manifest 声明 dyn. 开头实体被 validateManifest 拒（对不上自己的模块 id）', () => {
    const { core } = openFileCore();
    const fake = dynManifest({ id: 'module.builtin' });
    // manifest.id = module.builtin 但实体 id 是 dyn.vendor.extra.* → 结构校验直接拒
    const { errors } = validateManifest(fake);
    expect(errors.some((e) => e.message.includes('dyn.module.builtin'))).toBe(true);
    core.close();
  });
});
