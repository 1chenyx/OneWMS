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
    // core.wms + putaway + reversal + partial + reservation + return + asn + replenish + warehouse + serial + lpn + picking + qc + wave + pack + load + review + report
    expect(snapshot.version).toBe(19);
    const { inbound, outbound } = snapshot.workflows;
    expect(inbound.states[0].id).toBe('created'); // states[0] = 初始态约定
    // inbound = 基础转移（received→done 仅在上架关闭时）+ putaway 贡献
    expect(inbound.transitions).toEqual([
      ...ORDER_TRANSITIONS.in.map((t) =>
        t.from === 'received' && t.to === 'done'
          ? { from: t.from, to: t.to, when: '!module.putaway.enabled' }
          : { from: t.from, to: t.to },
      ),
      { from: 'received', to: 'putaway', when: 'module.putaway.enabled', providedBy: 'module.putaway' },
      { from: 'putaway', to: 'done', providedBy: 'module.putaway' },
      {
        from: 'received',
        to: 'canceled',
        when: 'module.reversal.enabled',
        effect: 'decrease',
        providedBy: 'module.reversal',
      },
      {
        from: 'created',
        to: 'announced',
        when: 'module.asn.enabled',
        effect: 'none',
        providedBy: 'module.asn',
      },
      { from: 'announced', to: 'received', effect: 'increase', providedBy: 'module.asn' },
      { from: 'announced', to: 'canceled', effect: 'none', providedBy: 'module.asn' },
      { from: 'received', to: 'inspected', when: 'module.qc.enabled', effect: 'none', providedBy: 'module.qc' },
      { from: 'inspected', to: 'putaway', when: 'module.putaway.enabled', providedBy: 'module.qc' },
      { from: 'inspected', to: 'done', when: '!module.putaway.enabled', providedBy: 'module.qc' },
    ]);
    expect(inbound.states.find((s) => s.id === 'putaway')?.providedBy).toBe('module.putaway');
    expect(outbound.transitions).toEqual([
      { from: 'created', to: 'picking', when: 'module.picking.enabled' },
      { from: 'picking', to: 'shipped' },
      { from: 'shipped', to: 'done' },
      { from: 'created', to: 'canceled' },
      { from: 'picking', to: 'canceled' },
      { from: 'created', to: 'shipped', when: '!module.picking.enabled' },
      {
        from: 'shipped',
        to: 'canceled',
        when: 'module.reversal.enabled',
        effect: 'increase',
        providedBy: 'module.reversal',
      },
      {
        from: 'picking',
        to: 'picked',
        when: 'module.picking.enabled',
        effect: 'none',
        providedBy: 'module.picking',
      },
      { from: 'picked', to: 'shipped', effect: 'none', providedBy: 'module.picking' },
      { from: 'created', to: 'waved', when: 'module.wave.enabled', effect: 'none', providedBy: 'module.wave' },
      { from: 'waved', to: 'picking', when: 'module.picking.enabled', effect: 'check', providedBy: 'module.wave' },
      { from: 'waved', to: 'canceled', effect: 'none', providedBy: 'module.wave' },
      { from: 'waved', to: 'shipped', when: '!module.picking.enabled', providedBy: 'module.wave' },
      { from: 'picked', to: 'packed', when: 'module.pack.enabled', effect: 'none', providedBy: 'module.pack' },
      { from: 'waved', to: 'packed', when: 'module.pack.enabled', effect: 'none', providedBy: 'module.pack' },
      { from: 'created', to: 'packed', when: 'module.pack.enabled', effect: 'none', providedBy: 'module.pack' },
      { from: 'packed', to: 'shipped', providedBy: 'module.pack' },
      { from: 'packed', to: 'loaded', when: 'module.load.enabled', effect: 'none', providedBy: 'module.load' },
      { from: 'picked', to: 'loaded', when: 'module.load.enabled', effect: 'none', providedBy: 'module.load' },
      { from: 'waved', to: 'loaded', when: 'module.load.enabled', effect: 'none', providedBy: 'module.load' },
      { from: 'created', to: 'loaded', when: 'module.load.enabled', effect: 'none', providedBy: 'module.load' },
      { from: 'loaded', to: 'shipped', providedBy: 'module.load' },
      { from: 'picked', to: 'reviewed', when: 'module.review.enabled', effect: 'none', providedBy: 'module.review' },
      { from: 'waved', to: 'reviewed', when: 'module.review.enabled', effect: 'none', providedBy: 'module.review' },
      { from: 'created', to: 'reviewed', when: 'module.review.enabled', effect: 'none', providedBy: 'module.review' },
      { from: 'reviewed', to: 'packed', when: 'module.pack.enabled', effect: 'none', providedBy: 'module.review' },
      { from: 'reviewed', to: 'loaded', when: 'module.load.enabled', effect: 'none', providedBy: 'module.review' },
      { from: 'reviewed', to: 'shipped', providedBy: 'module.review' },
    ]);
    expect(outbound.states.find((s) => s.id === 'picked')).toMatchObject({
      label: '已拣货',
      providedBy: 'module.picking',
    });
    // 上架模块默认启用（enabled=true → putaway 步骤立即可用）
    expect(snapshot.modules['module.putaway']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.reservation']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.return']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.asn']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.replenish']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.warehouse']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.zone']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.serial']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.lpn']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.picking']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.qc']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.wave']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.pack']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.load']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.review']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(snapshot.modules['module.report']).toMatchObject({ enabled: true, version: '0.1.0' });
    expect(inbound.states.find((s) => s.id === 'announced')?.providedBy).toBe('module.asn');
    expect(inbound.states.find((s) => s.id === 'inspected')).toMatchObject({ label: '已质检', providedBy: 'module.qc' });
    expect(outbound.states.find((s) => s.id === 'waved')).toMatchObject({ label: '已组波', providedBy: 'module.wave' });
    expect(outbound.states.find((s) => s.id === 'packed')).toMatchObject({ label: '已打包', providedBy: 'module.pack' });
    expect(outbound.states.find((s) => s.id === 'loaded')).toMatchObject({ label: '已装车', providedBy: 'module.load' });
    expect(outbound.states.find((s) => s.id === 'reviewed')).toMatchObject({ label: '已复核', providedBy: 'module.review' });
    core.close();
  });

  it('幂等：文件库重开（新进程）不重复装载种子，版本保持', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onewms-seed-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = OneCore.open(dbPath);
    const ws1 = WmsDomain.attach(first).workspace('ws-reopen');
    const events1 = ws1.events.count();
    expect(ws1.profile.getSnapshot().version).toBe(19);
    first.close();

    // 新进程打开同一库：种子事件已存在（hasHistory），不再装载
    const second = OneCore.open(dbPath);
    const ws2 = WmsDomain.attach(second).workspace('ws-reopen');
    expect(ws2.events.count()).toBe(events1);
    expect(ws2.profile.getSnapshot().version).toBe(19);
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
    expect(ws.profile.getSnapshot().version).toBe(19); // 十九个模块种子，未被慢通道改变
    core.close();
  });
});
