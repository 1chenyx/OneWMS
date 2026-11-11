import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OneCore, type ModuleManifest, type ToolBus } from '../src/index.js';

/**
 * B.4 声明式实体的 AI 工具：注册时机、description 从 manifest 拼装、
 * 经总线的端到端读写、以及「不 unregister」这条红线（§A.4）。
 *
 * 全部经 facade / 总线公共 API 验证——工具是不是真的「AI 立刻可用」，
 * 只有站在 AI 的位置（bus.invoke）才看得出来。
 */

const MODULE_ID = 'vendor.extra';
const QUAL = 'dyn.vendor.extra.qualification';
const VERBS = ['create', 'delete', 'get', 'list', 'update'] as const;

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

/** 文件库：重启后 manifest 靠 config.change 重放回来，工具必须自己装回总线 */
function openCore(dir = mkdtemp()) {
  const path = join(dir, 'wms.db');
  const core = OneCore.open(path);
  return { core, ws: core.workspace('ws-dyn'), bus: core.exposeToolBus(), path, dir };
}

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), `onewms-dyntool-${randomUUID().slice(0, 8)}-`));
  dirs.push(dir);
  return dir;
}

/** 带 note 与列含义的 manifest：这些字符串必须原样出现在 description 里 */
function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: MODULE_ID,
    name: '供应商扩展档案',
    description: '供应商资质等辅助档案（纯 JSON 声明，无本地代码）',
    version: '1.0.0',
    capabilities: ['db.read'],
    records: [
      {
        id: QUAL,
        label: '供应商资质',
        note: '一供应商可有多条资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string', queryable: true, description: '对应供应商主档编码' },
          { key: 'cert_level', label: '资质等级', type: 'string' },
          { key: 'score', label: '评分', type: 'number', queryable: true },
          { key: 'active', label: '是否启用', type: 'boolean' },
        ],
      },
    ],
    ...overrides,
  };
}

/** dyn 工具自己经 DynStore 落 record.* 事件，不该用 ctx.appendEvent */
function callCtx(workspaceId = 'ws-dyn') {
  return {
    workspaceId,
    actor: 'user:local',
    appendEvent: () => {
      throw new Error('dyn 工具不应使用 appendEvent');
    },
  };
}

/** 只看声明式实体的工具，按动词排序便于断言 */
function dynTools(bus: ToolBus) {
  return bus
    .listTools()
    .filter((tool) => tool.id.startsWith(QUAL))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function toolOf(bus: ToolBus, verb: string) {
  const found = bus.listTools().find((tool) => tool.id === `${QUAL}.${verb}`);
  if (!found) throw new Error(`工具未注册：${QUAL}.${verb}`);
  return found;
}

describe('B.4 声明式实体的 AI 工具', () => {
  it('安装后五个工具挂上总线，读写权限分明', () => {
    const { core, ws, bus } = openCore();
    expect(dynTools(bus)).toEqual([]); // 装之前总线上一个都没有

    ws.modules.install(manifest());

    expect(dynTools(bus).map((tool) => tool.id)).toEqual(VERBS.map((verb) => `${QUAL}.${verb}`).sort());
    for (const verb of VERBS) {
      const expected = verb === 'list' || verb === 'get' ? 'read' : 'write';
      expect(toolOf(bus, verb).permission).toBe(expected);
      expect(toolOf(bus, verb).label).toContain('供应商资质'); // label 也从 manifest 来
    }
    core.close();
  });

  it('description 从 manifest 拼装：实体名、列名、列含义、可查询列全在里面', () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());

    const create = toolOf(bus, 'create').description;
    // 实体身份 + 来源模块 + note
    expect(create).toContain('供应商资质');
    expect(create).toContain(QUAL);
    expect(create).toContain(MODULE_ID);
    expect(create).toContain('一供应商可有多条资质');
    // 列名、中文标签、类型提示、列含义
    expect(create).toContain('vendor_code');
    expect(create).toContain('供应商编码');
    expect(create).toContain('对应供应商主档编码');
    expect(create).toContain('文本');
    expect(create).toContain('数字');
    expect(create).toContain('true/false');
    // 可查询标记只落在声明了 queryable 的列上
    expect(create).toContain('vendor_code（供应商编码，文本，可过滤/排序）');
    expect(create).not.toContain('cert_level（资质等级，文本，可过滤/排序）');

    // list 明说哪些列能过滤排序——AI 不用试错
    expect(toolOf(bus, 'list').description).toContain('只有这些列能过滤和排序：vendor_code、score');
    // get/delete 不需要照抄列清单（返回值自解释），避免五个工具各烧一遍 token
    expect(toolOf(bus, 'delete').description).not.toContain('cert_level');
    core.close();
  });

  it('list 的过滤/排序列用 enum 收窄到 queryable 白名单', () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());

    const props = toolOf(bus, 'list').parameters.properties!;
    expect(props.filterField!.enum).toEqual(['vendor_code', 'score']);
    expect(props.sortField!.enum).toEqual(['vendor_code', 'score']);
    expect(props.sortDir!.enum).toEqual(['asc', 'desc']);
    expect(props.limit!.maximum).toBe(200);
    expect(toolOf(bus, 'list').parameters.required).toEqual([]); // 列表查询可以零参数
    core.close();
  });

  it('实体没有可查询列时不给 enum，description 直说不能过滤', () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(
      manifest({
        records: [
          {
            id: QUAL,
            label: '供应商资质',
            fields: [{ key: 'vendor_code', label: '供应商编码', type: 'string' }],
          },
        ],
      }),
    );

    const list = toolOf(bus, 'list');
    expect(list.parameters.properties!.filterField!.enum).toBeUndefined();
    expect(list.description).toContain('没有声明可查询列');
    // 空 enum 会把任何值都判为非法，所以「没有可查询列」必须整个不给 enum
    core.close();
  });

  it('经总线端到端：create → list 过滤 → get → update → delete', async () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());
    const ctx = callCtx();

    const created = (await bus.invoke(`${QUAL}.create`, { recordId: 'Q1', data: { vendor_code: 'V-001', score: 90 } }, ctx)) as {
      version: number;
    };
    expect(created.version).toBe(1);
    await bus.invoke(`${QUAL}.create`, { recordId: 'Q2', data: { vendor_code: 'V-002', score: 70 } }, ctx);

    // 过滤值按列类型还原：数字列传 "90" 字符串也能命中（与 B.3 端点同一规则）
    const filtered = (await bus.invoke(`${QUAL}.list`, { filterField: 'score', filterValue: '90' }, ctx)) as {
      total: number;
      rows: { recordId: string }[];
    };
    expect(filtered.total).toBe(1);
    expect(filtered.rows.map((row) => row.recordId)).toEqual(['Q1']);

    // 排序 + 翻页文法与端点一致
    const sorted = (await bus.invoke(`${QUAL}.list`, { sortField: 'score', sortDir: 'desc', limit: 1 }, ctx)) as {
      total: number;
      nextOffset?: number;
      rows: { recordId: string }[];
    };
    expect(sorted.rows.map((row) => row.recordId)).toEqual(['Q1']);
    expect(sorted.nextOffset).toBe(1);

    const got = (await bus.invoke(`${QUAL}.get`, { recordId: 'Q1' }, ctx)) as { version: number; data: Record<string, unknown> };
    expect(got.data).toEqual({ vendor_code: 'V-001', score: 90 });

    const updated = (await bus.invoke(
      `${QUAL}.update`,
      { recordId: 'Q1', expectedVersion: got.version, data: { vendor_code: 'V-001', score: 95 } },
      ctx,
    )) as { version: number };
    expect(updated.version).toBe(2);

    expect(ws.dyn.get(QUAL, 'Q1')?.data).toEqual({ vendor_code: 'V-001', score: 95 });
    await bus.invoke(`${QUAL}.delete`, { recordId: 'Q1', expectedVersion: 2 }, ctx);
    expect(ws.dyn.get(QUAL, 'Q1')).toBeUndefined();
    core.close();
  });

  it('乐观并发不可绕过：写工具缺 expectedVersion 直接拒', async () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());
    const ctx = callCtx();
    await bus.invoke(`${QUAL}.create`, { recordId: 'Q1', data: { vendor_code: 'V-001' } }, ctx);

    await expect(
      bus.invoke(`${QUAL}.update`, { recordId: 'Q1', data: { vendor_code: 'V-002' } }, ctx),
    ).rejects.toThrow(/expectedVersion/);
    await expect(bus.invoke(`${QUAL}.delete`, { recordId: 'Q1' }, ctx)).rejects.toThrow(/expectedVersion/);
    // 版本不对也不能写（存储层的乐观并发照常生效）
    await expect(
      bus.invoke(`${QUAL}.update`, { recordId: 'Q1', expectedVersion: 99, data: { vendor_code: 'V-002' } }, ctx),
    ).rejects.toThrow(/版本冲突/);
    core.close();
  });

  it('入参不成对、列未声明、实体未声明都给出可行动的错误', async () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());
    const ctx = callCtx();

    await expect(bus.invoke(`${QUAL}.list`, { filterField: 'score' }, ctx)).rejects.toThrow(/成对出现/);
    // 白名单外的列由存储层按调用方 workspace 的 manifest 拒（不是注册期快照）
    await expect(bus.invoke(`${QUAL}.list`, { filterField: 'cert_level', filterValue: 'A' }, ctx)).rejects.toThrow(
      /cert_level/,
    );
    await expect(
      bus.invoke(`${QUAL}.create`, { recordId: 'Q1', data: { nope: 'x' } }, ctx),
    ).rejects.toThrow(/未声明/);
    await expect(bus.invoke(`${QUAL}.get`, { recordId: 'missing' }, ctx)).rejects.toThrow(/不存在/);
    // 另一个 workspace 没装这个模块：同一条总线上工具可见，但按 ctx.workspaceId 解析不到实体
    await expect(bus.invoke(`${QUAL}.list`, {}, callCtx('ws-other'))).rejects.toThrow(/qualification/);
    core.close();
  });

  it('重启后工具自己装回总线（manifest 经 config.change 重放，进程目录里没有代码）', async () => {
    const { core, ws, dir } = openCore();
    ws.modules.install(manifest());
    ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001', score: 90 });
    core.close();

    const reopened = openCore(dir);
    expect(dynTools(reopened.bus).map((tool) => tool.id)).toEqual(VERBS.map((verb) => `${QUAL}.${verb}`).sort());
    const rows = (await reopened.bus.invoke(`${QUAL}.list`, {}, callCtx())) as { total: number };
    expect(rows.total).toBe(1);
    reopened.core.close();
  });

  it('卸载后工具仍在总线上（红线：不 unregister），但调用失败', async () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());
    ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001' });

    ws.modules.uninstall(MODULE_ID);

    // §A.4：摘 handler 会让重装被预检 5 拒（工具必须在场），也会误伤别的 workspace，
    // 所以卸载什么都不做；「AI 看不见」交给授权/可见性层过滤
    expect(dynTools(bus)).toHaveLength(VERBS.length);
    await expect(bus.invoke(`${QUAL}.list`, {}, callCtx())).rejects.toThrow(/qualification/);

    // 重装即恢复：工具是覆盖注册，幂等
    ws.modules.install(manifest());
    const rows = (await bus.invoke(`${QUAL}.list`, {}, callCtx())) as { total: number };
    expect(rows.total).toBe(1);
    core.close();
  });

  it('重复同步幂等：同一实体不会在总线上留下两份工具', () => {
    const { core, ws, bus } = openCore();
    ws.modules.install(manifest());
    const first = dynTools(bus).map((tool) => `${tool.id}@${tool.description.length}`);
    // 再开一个同 workspace 的门面（构造期会全量同步一次）
    core.workspace('ws-dyn');
    expect(dynTools(bus).map((tool) => `${tool.id}@${tool.description.length}`)).toEqual(first);
    expect(bus.listTools().filter((tool) => tool.id === `${QUAL}.list`)).toHaveLength(1);
    core.close();
  });
});
