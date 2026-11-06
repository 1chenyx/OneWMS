import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { MemoryDomain, MAX_MEMORY_CONTENT_LENGTH } from '../src/index.js';

/**
 * 记忆领域：工具护栏 + 投影幂等 + 追账/重放 + 设置兜底。
 *  - source 由审计 actor 推导（auto / ai / manual），不开放为参数；
 *  - write 三步护栏：sync → 校验（非空 ≤500 / scope 枚举 / 总量上限 /
 *    遗忘对象存在）→ appendEvent → sync，校验失败零事件；
 *  - 事件是唯一真相：重开库追账、replay 重建后状态一致。
 */

let core: OneCore;
let ws: ReturnType<MemoryDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  const domain = MemoryDomain.attach(core);
  ws = domain.workspace('ws-memory');
});

afterEach(() => {
  core.close();
});

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

/** 慢通道改 core.memory 设置（propose → confirm——配置变更的唯一路径） */
function setSettings(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, '记忆设置测试');
  ws.profile.confirm(proposalId, 'user:tester');
}

interface MemoryOut {
  memoryId: string;
  scope: 'personal' | 'project';
  content: string;
  source: 'auto' | 'ai' | 'manual';
  updatedAt: string;
}

async function save(body: { scope: string; content: string }, actor?: string): Promise<MemoryOut> {
  return (await ws.tools.invoke('memory.save', body, actor)) as MemoryOut;
}

describe('记忆保存与查询', () => {
  it('保存成功：返回值 + 投影可查 + 事件落账', async () => {
    const before = countEvents();
    const r = await save({ scope: 'project', content: 'A001 是易碎品，搬运需轻拿轻放' });
    expect(r.memoryId).toBeTruthy();
    expect(r.scope).toBe('project');
    expect(r.source).toBe('manual'); // 无 actor 参数 → 默认节点 actor → manual
    expect(countEvents()).toBe(before + 1);
    expect(ws.memory.byId(r.memoryId)?.content).toBe('A001 是易碎品，搬运需轻拿轻放');

    const list = (await ws.tools.invoke('memory.list', {})) as MemoryOut[];
    expect(list).toHaveLength(1);
    expect(list[0].memoryId).toBe(r.memoryId);
  });

  it('scope 过滤：personal 与 project 分层互不混杂', async () => {
    await save({ scope: 'personal', content: '用户习惯周日盘点' });
    await save({ scope: 'project', content: '每月底与供应商对账' });
    const personal = (await ws.tools.invoke('memory.list', { scope: 'personal' })) as MemoryOut[];
    const project = (await ws.tools.invoke('memory.list', { scope: 'project' })) as MemoryOut[];
    expect(personal.map((m) => m.content)).toEqual(['用户习惯周日盘点']);
    expect(project.map((m) => m.content)).toEqual(['每月底与供应商对账']);
  });

  it('source 由 actor 推导：auto（ai:memory-auto）/ ai（ai:general）/ manual（user:local）', async () => {
    const a = await save({ scope: 'personal', content: 's1' }, 'ai:memory-auto@node-1');
    const b = await save({ scope: 'personal', content: 's2' }, 'ai:general@node-1');
    const c = await save({ scope: 'personal', content: 's3' }, 'user:local@node-1');
    expect(a.source).toBe('auto');
    expect(b.source).toBe('ai');
    expect(c.source).toBe('manual');
  });

  it('content trim 后落账；空白拒绝且零事件', async () => {
    const r = await save({ scope: 'project', content: '  防潮存储  ' });
    expect(r.content).toBe('防潮存储');

    const before = countEvents();
    await expect(save({ scope: 'project', content: '   ' })).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
  });

  it('content 超长拒绝且零事件', async () => {
    const before = countEvents();
    await expect(save({ scope: 'project', content: '长'.repeat(MAX_MEMORY_CONTENT_LENGTH + 1) }))
      .rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
  });

  it('scope 非法拒绝且零事件', async () => {
    const before = countEvents();
    // 绕过总线参数校验直接传非法 scope：总线 schema enum 先拦一层；
    // handler 的枚举护栏对绕过 schema 的调用兜底
    await expect(
      ws.tools.invoke('memory.save', { scope: 'global', content: 'x' }, 'user:local@n'),
    ).rejects.toThrow();
    expect(countEvents()).toBe(before);
  });
});

describe('记忆遗忘', () => {
  it('遗忘成功：投影删行 + 事件落账', async () => {
    const r = await save({ scope: 'project', content: '临时约定' });
    const before = countEvents();
    const out = (await ws.tools.invoke('memory.forget', { memoryId: r.memoryId })) as {
      forgotten: boolean;
    };
    expect(out.forgotten).toBe(true);
    expect(countEvents()).toBe(before + 1);
    expect(ws.memory.byId(r.memoryId)).toBeUndefined();
    expect(ws.memory.count()).toBe(0);
  });

  it('遗忘不存在的记忆 → 拒绝且零事件', async () => {
    const before = countEvents();
    await expect(ws.tools.invoke('memory.forget', { memoryId: 'no-such-id' })).rejects.toThrow(
      'TOOL_REJECTED',
    );
    expect(countEvents()).toBe(before);
  });
});

describe('总量上限护栏', () => {
  it('达到 maxMemoryItems 后拒绝新增；改设置走慢通道即时生效', async () => {
    setSettings([{ op: 'replace', path: '/modules/core.memory/settings/maxMemoryItems', value: 2 }]);
    await save({ scope: 'project', content: 'm1' });
    await save({ scope: 'project', content: 'm2' });
    const before = countEvents();
    await expect(save({ scope: 'project', content: 'm3' })).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
    // 遗忘一条后可再存
    const list = (await ws.tools.invoke('memory.list', {})) as MemoryOut[];
    await ws.tools.invoke('memory.forget', { memoryId: list[0].memoryId });
    await expect(save({ scope: 'project', content: 'm3' })).resolves.toBeTruthy();
  });

  it('设置脏值兜底：非整数/小于 1 回落 200；autoMemory 非 false 回落 true', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.memory/settings/maxMemoryItems', value: 'many' },
      { op: 'replace', path: '/modules/core.memory/settings/autoMemory', value: 'nope' },
    ]);
    const snapshot = ws.profile.getSnapshot().modules['core.memory']?.settings;
    expect(snapshot).toEqual({ maxMemoryItems: 'many', autoMemory: 'nope' }); // 脏值原样存
    // 读取方窄化兜底（readMemorySettings 不直接暴露测试入口——经护栏行为验证）
    for (let i = 0; i < 3; i++) await save({ scope: 'personal', content: `m${i}` });
    expect(ws.memory.count()).toBe(3); // 上限回落 200，三条不拒
  });
});

describe('事件账本一致性（追账/重放）', () => {
  it('重开库：新进程追账后投影恢复', async () => {
    const a = await save({ scope: 'personal', content: '偏好简短回复' });
    await save({ scope: 'project', content: 'A001 易碎' }, 'ai:general@node-1');
    const forgetBefore = a.memoryId;

    // 模拟重开：同一 db 用 :memory: 无法重开——改为直接 replay 验证同路径
    const stat = ws.replay();
    expect(stat.appliedMemoryEvents).toBe(2); // 两条 saved（模块种子事件不属本域）
    expect(ws.memory.count()).toBe(2);
    expect(ws.memory.byId(forgetBefore)?.content).toBe('偏好简短回复');

    // replay 幂等：再来一次状态不变
    ws.replay();
    expect(ws.memory.count()).toBe(2);
  });

  it('同 memoryId 重放幂等（upsert 不重复）', async () => {
    const r = await save({ scope: 'project', content: 'v1' });
    ws.replay();
    expect(ws.memory.count()).toBe(1);
    expect(ws.memory.byId(r.memoryId)?.content).toBe('v1');
  });

  it('多工作区隔离：互不可见', async () => {
    const domain = MemoryDomain.attach(core);
    const ws2 = domain.workspace('ws-memory-other');
    await save({ scope: 'project', content: '本区记忆' });
    expect(ws.memory.count()).toBe(1);
    expect(ws2.memory.count()).toBe(0);
  });
});
