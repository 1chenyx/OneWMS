import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type EventEnvelope } from '@one/core';
import { WmsDomain } from '@one/wms';
import { createAgentFromDef, readAgentDefs } from '../src/index.js';
import type { AgentDefinition, LlmProvider, LlmTurnRequest, LlmTurnResponse } from '../src/index.js';

/**
 * 端到端：mock provider 驱动 createAgentFromDef 的完整链路（M16 多实例装配）。
 * 验证：actor='ai:{助手id}' 落审计、业务护栏在 AI 通道照常生效、
 * System Prompt = 人设前缀 + 全局纪律/数据快照、工具授权按定义过滤。
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

/** 取内置助手定义（未配置 core.ai 时 readAgentDefs = 内置三件套） */
const defOf = (id: string): AgentDefinition => {
  const def = readAgentDefs(ws).find((d) => d.id === id);
  if (!def) throw new Error(`内置助手 ${id} 缺失`);
  return def;
};

const EVENTS = () => {
  const all: EventEnvelope[] = [];
  ws.events.forEach((env) => all.push(env));
  return all;
};

describe('createAgentFromDef：端到端（快通道全链路）', () => {
  it('自然语言入库：工具执行 + actor 落审计 + 最终回复', async () => {
    const { provider } = scriptedProvider([
      { text: '好的，马上入库', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: 10, reason: 'AI 入库' } }] },
      { text: '已为 A-1 入库 10 个，当前库存 15 个。', toolCalls: [] },
    ]);
    const agent = createAgentFromDef(ws, provider, defOf('general'));

    const result = await agent.run('A-1 入库 10 个');

    expect(result.text).toBe('已为 A-1 入库 10 个，当前库存 15 个。');
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0].ok).toBe(true);

    // 库存投影：5 + 10 = 15（事件 → 投影链路完整）
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(15);

    // 审计免费（§9.3）：AI 的操作以 actor='ai:general' 落 oplog（M16：助手 id 替代模型名）
    const adjusted = EVENTS().filter((e) => e.type === 'wms.inventory.adjusted');
    expect(adjusted).toHaveLength(2); // beforeEach 期初 1 条 + AI 1 条
    expect(adjusted[1].actor).toBe('ai:general');
    expect(adjusted[1].payload).toMatchObject({ skuCode: 'A-1', delta: 10 });
  });

  it('护栏照常生效：出库超量被拒、错误回传模型、零事件落账', async () => {
    const before = EVENTS().length;
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.adjust', args: { skuCode: 'A-1', delta: -999 } }] },
      { text: '出库失败：A-1 库存不足（当前只有 5 个）', toolCalls: [] },
    ]);
    const agent = createAgentFromDef(ws, provider, defOf('general'));

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

  it('System Prompt = 人设前缀 + 全局纪律与数据快照；general 工具不含 profile.propose', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createAgentFromDef(ws, provider, defOf('general'));

    await agent.run('现在库存怎么样？');

    const req = requests[0];
    // 人设前缀在前（M16），全局纪律 + 数据快照在后（不因人设删减）
    expect(req.system.startsWith('你是通用仓库助手')).toBe(true);
    expect(req.system).toContain('行为规则：');
    expect(req.system).toContain('A-1');
    expect(req.system).toContain('螺丝');
    expect(req.system).toContain('SKU 总数：1');
    expect(req.system).toContain('库存总量：5');
    // 工具授权按定义过滤：general = 全量 − profile.propose（改配置是高权限，M16 移出默认）
    expect(req.tools.map((t) => t.id)).not.toContain('profile.propose');
    expect(req.tools.map((t) => t.id).sort()).toEqual([
      'core.oplog.query',
      'profile.field.query',
      'profile.module.query',
      'profile.overview',
      'profile.workflow.query',
      'tools.load',
      'wms.inventory.adjust',
      'wms.inventory.expiring',
      'wms.inventory.hold',
      'wms.inventory.holds',
      'wms.inventory.lowstock',
      'wms.inventory.move',
      'wms.inventory.query',
      'wms.inventory.release',
      'wms.ledger.query',
      'wms.location.create',
      'wms.location.list',
      'wms.location.update',
      'wms.order.conflict.accept',
      'wms.order.conflict.dismiss',
      'wms.order.conflict.list',
      'wms.order.create',
      'wms.order.putaway',
      'wms.order.query',
      'wms.order.transition',
      'wms.partner.create',
      'wms.partner.list',
      'wms.partner.update',
      'wms.picking.cancel',
      'wms.picking.close',
      'wms.picking.create',
      'wms.picking.pick',
      'wms.picking.query',
      'wms.replenish.create',
      'wms.sku.archive',
      'wms.sku.create',
      'wms.sku.resolve',
      'wms.sku.unarchive',
      'wms.sku.update',
      'wms.stocktake.cancel',
      'wms.stocktake.close',
      'wms.stocktake.count',
      'wms.stocktake.create',
      'wms.stocktake.query',
    ]);
    // 常驻是一行摘要；高频查询保持完整说明。长规则等 tools.load 之后再附上
    const orderCreate = req.tools.find((t) => t.id === 'wms.order.create');
    expect(orderCreate?.description).toBe('创建一张入库单或出库单');
    expect(orderCreate?.parameters.properties?.direction?.description).toBeUndefined();
    expect(orderCreate?.parameters.properties?.lines?.description).toContain('skuCode');
    expect(req.tools.find((t) => t.id === 'wms.inventory.query')?.description).toContain('byLocation');
    // 默认 actor（无 nodeId 后缀）
    expect(agent.actor).toBe('ai:general');
  });

  it('System Prompt v2：携带 Profile 摘要（扩展字段 / 流程 / 模块）与慢通道规则', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createAgentFromDef(ws, provider, defOf('readonly'));

    await agent.run('现在的配置是什么样？');

    const system = requests[0].system;
    // 慢通道行为规则（§4.1：确认权在人类，AI 只提议 + 转述报告）
    expect(system).toContain('profile.propose');
    expect(system).toContain('无权代替用户确认');
    expect(system).toContain('chat.attachment.apply');
    // Profile 摘要：wms 种子的三个基础扩展字段与两条默认流程
    expect(system).toContain('当前配置（Profile）：');
    expect(system).toContain('sku.spec（规格');
    expect(system).toContain('sku.category（分类');
    expect(system).toContain('流程 inbound');
    expect(system).toContain('流程 outbound');
    // readonly 只装配 read 工具（写工具不在 function calling 清单里）
    expect(
      requests[0].tools.every(
        (t) =>
          t.id === 'ui.ask' ||
          t.id === 'tools.load' ||
          ws.tools.list().find((x) => x.id === t.id)?.permission === 'read',
      ),
    ).toBe(true);
  });

  it('记忆注入：memories 选项 → System Prompt「记忆」段（行为规则后、Profile 前，每条带 id）', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createAgentFromDef(ws, provider, defOf('general'), {
      memories: [
        { id: 'm1', scope: 'personal', content: '用户习惯周日盘点' },
        { id: 'm2', scope: 'project', content: 'A001 是易碎品' },
      ],
    });

    await agent.run('注意易碎品');

    const system = requests[0].system;
    expect(system).toContain('记忆（2 条');
    expect(system).toContain('m1 [personal] 用户习惯周日盘点');
    expect(system).toContain('m2 [project] A001 是易碎品');
    // 段序：记忆在行为规则之后、Profile 摘要之前
    expect(system.indexOf('记忆（2 条')).toBeGreaterThan(system.indexOf('行为规则：'));
    expect(system.indexOf('记忆（2 条')).toBeLessThan(system.indexOf('当前配置（Profile）：'));
    // 行为规则含记忆使用规则（对所有助手生效，不受 memories 传不传影响）
    expect(system).toContain('memory.save');
    expect(system).toContain('memory.forget');
  });

  it('记忆超上限截断：仅注 MAX_PROMPT_MEMORIES 条并提示 memory.list', async () => {
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const memories = Array.from({ length: 55 }, (_, i) => ({
      id: `m${i}`,
      scope: 'personal' as const,
      content: `记忆条目 ${i}`,
    }));
    const agent = createAgentFromDef(ws, provider, defOf('general'), { memories });

    await agent.run('你好');

    const system = requests[0].system;
    expect(system).toContain('记忆（55 条');
    expect(system).toContain('仅列前 50 条');
    expect(system).toContain('memory.list');
    expect(system).not.toContain('记忆条目 54'); // 第 55 条被截断
  });

  it('慢通道端到端：config 助手经 profile.propose 提议 → 人工确认后生效', async () => {
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
    const agent = createAgentFromDef(ws, provider, defOf('config'));

    const before = EVENTS().length;
    const result = await agent.run('帮我把规格字段隐藏了');

    // ① 提议成功，返回影响报告并等待确认——但零事件落账（提议不是事实）
    expect(result.invocations[0].ok).toBe(true);
    expect(EVENTS().length).toBe(before);

    // ② 提议登记为 pending，actor 是 AI（可审计：哪个助手提的）
    const pending = ws.profile.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].proposedBy).toBe('ai:config');
    expect(pending[0].note).toBe('用户要求隐藏规格字段');

    // ③ 人工确认（不走工具总线——确认权不可委托）→ 纯字段轨道：
    //    version 不变（无 config.change），落 1 条 registry.field.visibility_changed。
    //    基线版本随构造期模块安装而变（base=1 + M21 putaway=2），断言「不变」而非硬编码
    const baseVersion = ws.profile.getSnapshot().version;
    const confirmed = ws.profile.confirm(pending[0].proposalId, 'user:human');
    expect(confirmed.newVersion).toBe(baseVersion); // 字段轨道不动版本
    expect(ws.fields.get('sku', 'spec')!.visible).toBe(false);
    const visibilityEvents = EVENTS().filter((e) => e.type === 'registry.field.visibility_changed');
    expect(visibilityEvents).toHaveLength(1);
    expect(visibilityEvents[0].actor).toBe('user:human');

    // ④ 确认后 pending 清空；再来一次 System Prompt 已反映新状态（快照新鲜度以任务为粒度）
    expect(ws.profile.listPending()).toHaveLength(0);
  });
});

describe('createAgentFromDef：授权过滤与委托口子（M16）', () => {
  it('按定义过滤：只授权的工具进 function calling 清单', async () => {
    const def: AgentDefinition = {
      id: 'spot',
      name: '现货查询',
      description: '',
      systemPrompt: '你是现货查询员。',
      tools: ['wms.sku.create', 'wms.inventory.query'],
    };
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createAgentFromDef(ws, provider, def);

    expect(agent.tools.map((t) => t.id)).toEqual(['wms.sku.create', 'wms.inventory.query']);
    expect(agent.actor).toBe('ai:spot');
    await agent.run('查一下');
    expect(requests[0].tools.map((t) => t.id)).toEqual(['wms.sku.create', 'wms.inventory.query', 'tools.load']);
  });

  it('会话工具只进 stream：run 看不到，调用走注入的 invoke', async () => {
    const meta = {
      id: 'chat.attachment.read',
      label: '查看附件',
      description: '读附件',
      parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      permission: 'read' as const,
    };
    let seenActor = '';
    const { provider, requests } = scriptedProvider([{ text: '好的', toolCalls: [] }]);
    const agent = createAgentFromDef(ws, provider, defOf('general'), {
      sessionTools: [{ meta, invoke: async () => ({ ok: true }) }],
    });
    await agent.run('普通问题');
    expect(requests[0].tools.map((t) => t.id)).not.toContain('chat.attachment.read');

    const streamed = scriptedProvider([
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'chat.attachment.read', args: { attachmentId: 'a1' } }] },
      { text: '看过了', toolCalls: [] },
    ]);
    const streaming = createAgentFromDef(ws, streamed.provider, defOf('general'), {
      sessionTools: [
        {
          meta,
          invoke: async (_args, actor) => {
            seenActor = actor;
            return { name: '入库.csv' };
          },
        },
      ],
    });
    const events = [];
    for await (const ev of streaming.stream('看看附件')) events.push(ev);
    expect(streamed.requests[0].tools.map((t) => t.id)).toContain('chat.attachment.read');
    expect(streamed.requests[0].tools.map((t) => t.id)).toContain('ui.ask');
    expect(seenActor).toBe('ai:general');
    expect(events.some((ev) => ev.type === 'tool-result' && ev.ok === true)).toBe(true);
  });

  it('授权了不在场的工具：静默丢弃（定义是脏面，不炸装配）', () => {
    const def: AgentDefinition = {
      id: 'x',
      name: 'X',
      description: '',
      systemPrompt: 'S',
      tools: ['wms.inventory.query', 'wms.gone.tool'],
    };
    const { provider } = scriptedProvider([]);
    const agent = createAgentFromDef(ws, provider, def);
    expect(agent.tools.map((t) => t.id)).toEqual(['wms.inventory.query']);
  });

  it("'agent:<id>' 委托形态（多 AI 协作 v2 预留）→ 装配直接抛错", () => {
    const def: AgentDefinition = {
      id: 'lead',
      name: '主管',
      description: '',
      systemPrompt: 'S',
      tools: ['agent:worker'],
    };
    const { provider } = scriptedProvider([]);
    expect(() => createAgentFromDef(ws, provider, def)).toThrow(/AGENT_DELEGATION_UNSUPPORTED/);
  });
});
