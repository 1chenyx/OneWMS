import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type EventEnvelope } from '@one/core';
import { WmsDomain } from '@one/wms';
import { createWmsAgent } from '../src/index.js';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '../src/index.js';

/**
 * 端到端：mock provider 驱动 createWmsAgent 的完整链路。
 * 验证三件事：actor='ai:模型名' 落审计、业务护栏在 AI 通道照常生效、
 * System Prompt 携带真实数据快照。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-ai-test');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, reason: '期初' });
});

afterEach(() => {
  core.close();
});

function scriptedProvider(turns: LlmTurnResponse[]) {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async completeTurn(req) {
      requests.push(req);
      return turns[i++] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests };
}

const EVENTS = () => {
  const all: EventEnvelope[] = [];
  ws.events.forEach((env) => all.push(env));
  return all;
};

describe('createWmsAgent：端到端（快通道全链路）', () => {
  it('自然语言入库：工具执行 + actor 落审计 + 最终回复', async () => {
    const { provider } = scriptedProvider([
      { text: '好的，马上入库', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 10, reason: 'AI 入库' } }] },
      { text: '已为 A-1 入库 10 个，当前库存 15 个。', toolCalls: [] },
    ]);
    const agent = createWmsAgent(ws, provider, { model: 'test-model' });

    const result = await agent.run('A-1 入库 10 个');

    expect(result.text).toBe('已为 A-1 入库 10 个，当前库存 15 个。');
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0].ok).toBe(true);

    // 库存投影：5 + 10 = 15（事件 → 投影链路完整）
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(15);

    // 审计免费（§9.3）：AI 的操作以 actor='ai:test-model' 落 oplog
    const adjusted = EVENTS().filter((e) => e.type === 'wms.inventory.adjusted');
    expect(adjusted).toHaveLength(2); // beforeEach 期初 1 条 + AI 1 条
    expect(adjusted[1].actor).toBe('ai:test-model');
    expect(adjusted[1].payload).toMatchObject({ skuCode: 'A-1', delta: 10 });
  });

  it('护栏照常生效：出库超量被拒、错误回传模型、零事件落账', async () => {
    const before = EVENTS().length;
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -999 } }] },
      { text: '出库失败：A-1 库存不足（当前只有 5 个）', toolCalls: [] },
    ]);
    const agent = createWmsAgent(ws, provider, { model: 'test-model' });

    const result = await agent.run('A-1 出库 999 个');

    // 模型收到的是结构化错误，且循环未中断
    expect(result.text).toBe('出库失败：A-1 库存不足（当前只有 5 个）');
    expect(result.invocations[0].ok).toBe(false);
    const results = requests[1].messages[2] as { results: Array<{ payload: { error: string } }> };
    expect(results.results[0].payload.error).toContain('InsufficientStockError');

    // 校验失败绝不落事件（§4.3 命令失败 ≠ 事实）
    expect(EVENTS().length).toBe(before);
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(5);
  });

  it('System Prompt 携带数据快照；工具清单来自工具总线', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createWmsAgent(ws, provider);

    await agent.run('现在库存怎么样？');

    const req = requests[0];
    expect(req.system).toContain('A-1');
    expect(req.system).toContain('螺丝');
    expect(req.system).toContain('SKU 总数：1');
    expect(req.system).toContain('库存总量：5');
    // 工具元数据全部注入 function calling 通道：内核慢通道入口 + wms 六件套
    expect(req.tools.map((t) => t.id).sort()).toEqual([
      'profile.propose',
      'wms.inventory.adjust',
      'wms.inventory.query',
      'wms.order.create',
      'wms.order.transition',
      'wms.sku.create',
      'wms.sku.update',
    ]);
    // 默认 actor
    expect(agent.actor).toBe('ai:assistant');
  });

  it('System Prompt v2：携带 Profile 摘要（扩展字段 / 流程 / 模块）与慢通道规则', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createWmsAgent(ws, provider);

    await agent.run('现在的配置是什么样？');

    const system = requests[0].system;
    // 慢通道行为规则（§4.1：确认权在人类，AI 只提议 + 转述报告）
    expect(system).toContain('profile.propose');
    expect(system).toContain('无权代替用户确认');
    // Profile 摘要：wms 种子的三个基础扩展字段与两条默认流程
    expect(system).toContain('当前配置（Profile）：');
    expect(system).toContain('sku.spec（规格');
    expect(system).toContain('sku.category（分类');
    expect(system).toContain('流程 inbound');
    expect(system).toContain('流程 outbound');
  });

  it('慢通道端到端：AI 经 profile.propose 提议 → 转述报告 → 人工确认后生效', async () => {
    // spec 在快照扩展字段中的索引（listFields 按 key 排序，动态取避免脆断言）
    const extensions = ws.profile.getSnapshot().schema.entities.sku!.extensions;
    const specIdx = extensions.findIndex((f) => f.key === 'spec');
    expect(specIdx).toBeGreaterThanOrEqual(0);

    const { provider } = scriptedProvider([
      {
        text: '',
        toolCalls: [
          {
            callId: 'c1',
            toolId: 'profile.propose',
            args: {
              patch: [{ op: 'replace', path: `/schema/entities/sku/extensions/${specIdx}/visible`, value: false }],
              note: '用户要求隐藏规格字段',
            },
          },
        ],
      },
      { text: '已提交隐藏「规格」字段的提议：字段将从界面隐藏，数据保留。等你确认后生效。', toolCalls: [] },
    ]);
    const agent = createWmsAgent(ws, provider, { model: 'test-model' });

    const before = EVENTS().length;
    const result = await agent.run('帮我把规格字段隐藏了');

    // ① 提议成功，返回影响报告并等待确认——但零事件落账（提议不是事实）
    expect(result.invocations[0].ok).toBe(true);
    expect(EVENTS().length).toBe(before);

    // ② 提议登记为 pending，actor 是 AI（可审计）
    const pending = ws.profile.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].proposedBy).toBe('ai:test-model');
    expect(pending[0].note).toBe('用户要求隐藏规格字段');

    // ③ 人工确认（不走工具总线——确认权不可委托）→ 纯字段轨道：
    //    version 不变（无 config.change），落 1 条 registry.field.visibility_changed
    const confirmed = ws.profile.confirm(pending[0].proposalId, 'user:human');
    expect(confirmed.newVersion).toBe(1); // 种子 workflows 的版本，字段轨道不动版本
    expect(ws.fields.get('sku', 'spec')!.visible).toBe(false);
    const visibilityEvents = EVENTS().filter((e) => e.type === 'registry.field.visibility_changed');
    expect(visibilityEvents).toHaveLength(1);
    expect(visibilityEvents[0].actor).toBe('user:human');

    // ④ 确认后 pending 清空；再来一次 System Prompt 已反映新状态（快照新鲜度以任务为粒度）
    expect(ws.profile.listPending()).toHaveLength(0);
  });
});
