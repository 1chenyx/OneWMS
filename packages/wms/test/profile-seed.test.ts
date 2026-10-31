import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';
import { ORDER_TRANSITIONS } from '../src/state/order-state-machine.js';

/**
 * 模块化种子（M4 默认 Profile 种子 → M6 manifest 驱动安装）：
 * core.wms manifest 声明基础扩展字段 + 默认流程骨架。
 * 验证：构造即安装、幂等（多进程/重开不重复）、配置面与 M2 状态机一致、
 * 慢通道在领域工作区端到端可用。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('默认 Profile 种子', () => {
  it('构造后：3 个基础字段 + inbound/outbound 流程（与 M2 转移表一致）', () => {
    const core = OneCore.open(':memory:');
    const ws = WmsDomain.attach(core).workspace('ws-seed');

    const snapshot = ws.profile.getSnapshot();
    // 基础扩展字段（spec/category/unit，按 key 排序）
    expect(snapshot.schema.entities.sku.extensions.map((f) => f.key).sort()).toEqual([
      'category',
      'spec',
      'unit',
    ]);
    // M6 起字段归属 core.wms（manifest 安装的 owner = manifest.id；M4 手写种子为 'core'）
    expect(snapshot.schema.entities.sku.extensions.every((f) => f.visible && f.providedBy === 'core.wms')).toBe(true);

    // 流程骨架与 M2 硬编码状态机逐条一致（已知临时状态：M6 前配置面≠行为权威）
    expect(snapshot.version).toBe(1);
    const { inbound, outbound } = snapshot.workflows;
    expect(inbound.states[0].id).toBe('created'); // states[0] = 初始态约定
    expect(inbound.transitions).toEqual(
      ORDER_TRANSITIONS.in.map((t) => ({ from: t.from, to: t.to })),
    );
    expect(outbound.transitions).toEqual(
      ORDER_TRANSITIONS.out.map((t) => ({ from: t.from, to: t.to })),
    );
    core.close();
  });

  it('幂等：文件库重开（新进程）不重复装载种子，版本保持', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onewms-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = OneCore.open(dbPath);
    const ws1 = WmsDomain.attach(first).workspace('ws-reopen');
    const events1 = ws1.events.count();
    expect(ws1.profile.getSnapshot().version).toBe(1);
    first.close();

    // 新进程打开同一库：种子事件已存在（hasHistory），不再装载
    const second = OneCore.open(dbPath);
    const ws2 = WmsDomain.attach(second).workspace('ws-reopen');
    expect(ws2.events.count()).toBe(events1);
    expect(ws2.profile.getSnapshot().version).toBe(1);
    second.close();
  });

  it('慢通道端到端（领域视角）：AI 提议隐藏字段 → 人工确认 → 注册表生效', async () => {
    const core = OneCore.open(':memory:');
    const ws = WmsDomain.attach(core).workspace('ws-slow');

    // AI 经工具总线提议（actor = ai:模型名，审计可追溯）
    const proposed = (await ws.tools.invoke(
      'profile.propose',
      {
        patch: [{ op: 'replace', path: '/schema/entities/sku/extensions/1/visible', value: false }],
        note: '用户不需要规格字段',
      },
      'ai:qwen3:8b',
    )) as { proposalId: string; report: { summary: string; items: { kind: string; target: string }[] } };

    // extensions 按字段键排序：0=category 1=spec 2=unit——提议目标是 spec
    expect(proposed.report.items.some((i) => i.kind === 'field.hidden' && i.target === 'sku.spec')).toBe(true);

    // 配置未变（提议不是事实）
    expect(ws.fields.get('sku', 'spec')!.visible).toBe(true);

    // 人工确认（确认权在人类，不经 AI）
    const eventsBefore = ws.events.count();
    ws.profile.confirm(proposed.proposalId, 'node-human');

    expect(ws.fields.get('sku', 'spec')!.visible).toBe(false);
    // 纯字段变更走注册表事件（1 条 visibility_changed），不落 config.change
    expect(ws.events.count()).toBe(eventsBefore + 1);
    expect(ws.profile.getSnapshot().version).toBe(1);
    core.close();
  });
});
