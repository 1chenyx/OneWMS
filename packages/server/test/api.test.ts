import { describe, it, expect, afterEach } from 'vitest';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '@one/ai';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * 路由级直测：hono 内建 app.request()——不起端口、不碰真实 LLM。
 * 覆盖：health / profile 快照 / proposals 全流程（含 409 新鲜度、409 终态、404 未知）
 * / chat（mock provider、无 AI 503、空消息 400）。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

function scriptedProvider(turns: LlmTurnResponse[]): LlmProvider {
  let i = 0;
  return {
    async completeTurn(_req: LlmTurnRequest) {
      return turns[i++] ?? { text: '', toolCalls: [] };
    },
  };
}

function setup(provider?: LlmProvider): ReturnType<typeof createApp> {
  ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-server-test', provider, model: 'test-model' });
  return createApp(ctx);
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

describe('GET /api/health 与 /api/profile/snapshot', () => {
  it('health 返回 nodeId', async () => {
    const app = setup();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; nodeId: string };
    expect(data.ok).toBe(true);
    expect(data.nodeId).toBeTruthy();
  });

  it('快照携带 wms 种子（扩展字段 + 默认流程）', async () => {
    const app = setup();
    const res = await app.request('/api/profile/snapshot');
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      version: number;
      schema: { entities: Record<string, { extensions: Array<{ key: string }> }> };
      workflows: Record<string, unknown>;
    };
    expect(snap.version).toBe(1); // 种子 config.change
    const keys = snap.schema.entities.sku!.extensions.map((f) => f.key).sort();
    expect(keys).toEqual(['category', 'spec', 'unit']);
    expect(Object.keys(snap.workflows).sort()).toEqual(['inbound', 'outbound']);
  });
});

describe('POST /api/chat', () => {
  it('未配置 AI → 503（AI 可选，其余功能不受影响）', async () => {
    const app = setup();
    const res = await post(app, '/api/chat', { message: '你好' });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('AI_NOT_CONFIGURED');
  });

  it('空 message → 400', async () => {
    const app = setup(scriptedProvider([{ text: '好的', toolCalls: [] }]));
    const res = await post(app, '/api/chat', { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('mock provider 驱动：工具执行 + 最终回复 + actor 审计', async () => {
    const app = setup(
      scriptedProvider([
        { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' } }] },
        { text: '已创建 SKU A-1。', toolCalls: [] },
      ]),
    );
    const res = await post(app, '/api/chat', { message: '建个 SKU：A-1 螺丝' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { text: string; invocations: Array<{ ok: boolean }> };
    expect(data.text).toBe('已创建 SKU A-1。');
    expect(data.invocations[0].ok).toBe(true);
    // 审计免费（§9.3）：AI 的操作以 actor='ai:test-model@nodeId' 落 oplog（通道节点唯一）
    expect(ctx!.ws.skus.byCode('A-1')!.name).toBe('螺丝');
    const actors = new Set<string>();
    ctx!.ws.events.forEach((e) => actors.add(e.actor));
    expect(actors.has(`ai:test-model@${ctx!.core.nodeId}`)).toBe(true);
  });
});

describe('提议确认端点（人类专属，§4.1）', () => {
  /** 经真工具总线提交一份「隐藏 sku.spec」提议（模拟 AI 慢通道动作） */
  async function proposeHideSpec(c: AppContext): Promise<string> {
    const exts = c.ws.profile.getSnapshot().schema.entities.sku!.extensions;
    const idx = exts.findIndex((f) => f.key === 'spec');
    const r = (await c.ws.tools.invoke(
      'profile.propose',
      {
        patch: [{ op: 'replace', path: `/schema/entities/sku/extensions/${idx}/visible`, value: false }],
        note: '隐藏规格字段',
      },
      'ai:test-model',
    )) as { proposalId: string };
    return r.proposalId;
  }

  it('全流程：propose（工具通道）→ list → confirm → 生效 → 列表清空', async () => {
    const app = setup();
    expect(await (await app.request('/api/proposals')).json()).toEqual([]);

    const id = await proposeHideSpec(ctx!);
    const list = (await (await app.request('/api/proposals')).json()) as Array<{ proposalId: string; proposedBy: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ proposalId: id, proposedBy: 'ai:test-model' });

    // 详情端点：确认界面的数据源（patch 全文 + 影响报告）
    const detail = (await (await app.request(`/api/proposals/${id}`)).json()) as {
      note?: string;
      patch: Array<{ op: string; path: string }>;
      report: { summary: string; items: unknown[] };
    };
    expect(detail.note).toBe('隐藏规格字段');
    expect(detail.patch[0]).toMatchObject({ op: 'replace', path: expect.stringContaining('/visible') });
    expect(detail.report.items.length).toBeGreaterThan(0);

    const res = await post(app, `/api/proposals/${id}/confirm`, { by: 'user:human' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { newVersion: number; appliedOps: number };
    expect(data.appliedOps).toBe(1);

    expect(ctx!.ws.fields.get('sku', 'spec')!.visible).toBe(false);
    expect(await (await app.request('/api/proposals')).json()).toEqual([]);

    // 终态不可逆：再 confirm 同一提议 → 409。注意此时 spec 已被首次 confirm 改为
    // 隐藏 → 字段指纹失配先行触发 STALE（新鲜度检查先于终态检查，语义同样成立）
    const again = await post(app, `/api/proposals/${id}/confirm`, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('PROPOSAL_STALE');
  });

  it('新鲜度：propose 后配置变化 → confirm 409 PROPOSAL_STALE', async () => {
    const app = setup();
    const id = await proposeHideSpec(ctx!);
    // 提议与确认之间，有人直接隐藏了同一字段（真变化；设为相同值会被注册表短路）
    ctx!.ws.fields.setVisibility('user:other', 'sku', 'spec', false);
    const res = await post(app, `/api/proposals/${id}/confirm`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PROPOSAL_STALE');
  });

  it('不存在的提议 → 404；reject → 列表清空', async () => {
    const app = setup();
    const missing = await post(app, '/api/proposals/ghost/confirm', {});
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('PROPOSAL_NOT_FOUND');

    const id = await proposeHideSpec(ctx!);
    const res = await post(app, `/api/proposals/${id}/reject`, {});
    expect(res.status).toBe(200);
    expect(await (await app.request('/api/proposals')).json()).toEqual([]);
  });
});
