import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('POST /api/chat/sessions/:id/message（SSE 流式）', () => {
  /** 解析 SSE 文本为事件数组（event 名 + data JSON） */
  function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
    const out: Array<{ event: string; data: Record<string, unknown> }> = [];
    for (const block of text.split('\n\n')) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
      out.push({
        event: eventLine?.slice(6).trim() ?? '',
        data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>,
      });
    }
    return out;
  }

  it('未配置 AI → 503（AI 可选，其余功能不受影响）', async () => {
    const app = setup();
    const res = await post(app, '/api/chat/sessions/s1/message', { message: '你好' });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('AI_NOT_CONFIGURED');
  });

  it('空 message → 400', async () => {
    const app = setup(scriptedProvider([{ text: '好的', toolCalls: [] }]));
    const res = await post(app, '/api/chat/sessions/s1/message', { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('mock provider 驱动：事件序（tool-call → tool-result → text-delta → turn-done）+ actor 审计', async () => {
    const app = setup(
      scriptedProvider([
        { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' } }] },
        { text: '已创建 SKU A-1。', toolCalls: [] },
      ]),
    );
    const res = await post(app, '/api/chat/sessions/s1/message', { message: '建个 SKU：A-1 螺丝' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['tool-call', 'tool-result', 'text-delta', 'turn-done']);
    expect(events[0].data).toMatchObject({ toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' } });
    expect(events[1].data).toMatchObject({ toolId: 'wms.sku.create', ok: true });
    expect(events[2].data).toEqual({ type: 'text-delta', text: '已创建 SKU A-1。' });
    expect(events[3].data).toEqual({ type: 'turn-done', steps: 2 });

    // 审计免费（§9.3）：AI 的操作以 actor='ai:test-model@nodeId' 落 oplog（通道节点唯一）
    expect(ctx!.ws.skus.byCode('A-1')!.name).toBe('螺丝');
    const actors = new Set<string>();
    ctx!.ws.events.forEach((e) => actors.add(e.actor));
    expect(actors.has(`ai:test-model@${ctx!.core.nodeId}`)).toBe(true);
  });

  it('同一会话多轮：turn-done 后历史提交，第二轮请求携带完整上下文', async () => {
    const requests: LlmTurnRequest[] = [];
    let i = 0;
    const turns: LlmTurnResponse[] = [
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'wms.inventory.query', args: {} }] },
      { text: 'A-1 还有 5 个。', toolCalls: [] },
      { text: '是的，同一批货。', toolCalls: [] },
    ];
    const provider: LlmProvider = {
      async completeTurn(req) {
        // 快照 messages：编排层传入的是同一数组引用，调用后会继续 push（终态 assistant）
        requests.push({ ...req, messages: [...req.messages] });
        return turns[i++] ?? { text: '', toolCalls: [] };
      },
    };
    const app = setup(provider);

    const first = await post(app, '/api/chat/sessions/s2/message', { message: 'A-1 还剩多少？' });
    expect(parseSse(await first.text()).at(-1)?.event).toBe('turn-done');
    const second = await post(app, '/api/chat/sessions/s2/message', { message: '是这批新到的吗？' });
    const events = parseSse(await second.text());
    expect(events.at(-1)?.event).toBe('turn-done');
    expect(events.map((e) => e.event)).toEqual(['text-delta', 'turn-done']);

    // 第一轮两次模型调用（工具→回复），第二轮一次——requests[2] 即第二轮请求：
    // user → tool-calls → tool-results → assistant → 新 user
    const msgs = requests[2].messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'tool-calls', 'tool-results', 'assistant', 'user']);
    expect((msgs[3] as { text: string }).text).toBe('A-1 还有 5 个。');
    expect((msgs[4] as { text: string }).text).toBe('是这批新到的吗？');
  });

  it('模型调用抛错 → error 事件；会话可继续（历史未提交，从上一轮重来）', async () => {
    let i = 0;
    const provider: LlmProvider = {
      async completeTurn() {
        if (i++ === 0) throw new Error('LLM_CONNECTION_REFUSED');
        return { text: '恢复了', toolCalls: [] };
      },
    };
    const app = setup(provider);

    const first = await post(app, '/api/chat/sessions/s3/message', { message: '你好' });
    const events = parseSse(await first.text());
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    expect(events[0].data.message).toContain('LLM_CONNECTION_REFUSED');

    // 会话未被卡死：下一条消息正常走完
    const second = await post(app, '/api/chat/sessions/s3/message', { message: '再试一次' });
    expect(parseSse(await second.text()).at(-1)?.event).toBe('turn-done');
  });

  it('同一会话并发第二条 → 409 CHAT_SESSION_BUSY', async () => {
    // 用挂起的 completeTurn 制造「正在处理中」的会话
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const provider: LlmProvider = {
      async completeTurn() {
        await gate;
        return { text: 'done', toolCalls: [] };
      },
    };
    const app = setup(provider);
    const first = post(app, '/api/chat/sessions/s4/message', { message: '慢一点' });
    // 等第一条真正进入 streaming 状态（事件循环一轮）
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, '/api/chat/sessions/s4/message', { message: '插队' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('CHAT_SESSION_BUSY');
    release();
    expect(parseSse(await (await first).text()).at(-1)?.event).toBe('turn-done');
  });
});

describe('POST /api/chat/sessions/:id/answer（ui.ask 挂起/唤醒，M12 步骤3）', () => {
  /** 增量读取 SSE 流：next() 逐事件返回——ask 挂起用例必须在流未结束时读 */
  class SseReader {
    private reader = {} as ReturnType<Response['body']['getReader']>;
    private decoder = new TextDecoder();
    private buffer = '';
    private closed = false;

    constructor(res: Response) {
      this.reader = res.body!.getReader();
    }

    async next(): Promise<{ event: string; data: Record<string, unknown> } | undefined> {
      for (;;) {
        const sep = this.buffer.indexOf('\n\n');
        if (sep !== -1) {
          const block = this.buffer.slice(0, sep);
          this.buffer = this.buffer.slice(sep + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
          return {
            event: eventLine?.slice(6).trim() ?? '',
            data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>,
          };
        }
        if (this.closed) return undefined;
        const { done, value } = await this.reader.read();
        if (done) {
          this.closed = true;
          continue;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
      }
    }

    /** 读完剩余事件（流关闭后返回） */
    async rest(): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
      const out: Array<{ event: string; data: Record<string, unknown> }> = [];
      for (;;) {
        const ev = await this.next();
        if (!ev) return out;
        out.push(ev);
      }
    }
  }

  it('ask 事件 → answer 注入回答续流 → 回答回传模型；挂起期间新消息 409；ui.ask 不落 oplog', async () => {
    const requests: LlmTurnRequest[] = [];
    let i = 0;
    const turns: LlmTurnResponse[] = [
      { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '要入多少个？' } }] },
      { text: '好的，入库 20 个完成。', toolCalls: [] },
    ];
    const provider: LlmProvider = {
      async completeTurn(req) {
        requests.push({ ...req, messages: [...req.messages] });
        return turns[i++] ?? { text: '', toolCalls: [] };
      },
    };
    const app = setup(provider);

    const res = await post(app, '/api/chat/sessions/s5/message', { message: '入库 A-1' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = new SseReader(res);

    const ask = await reader.next();
    expect(ask?.event).toBe('ask');
    expect(ask?.data).toMatchObject({ callId: 'c1', question: '要入多少个？' });

    // 挂起期间该会话仍处 streaming：新消息 409（ask 属于在途轮次）
    const busy = await post(app, '/api/chat/sessions/s5/message', { message: '插队' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { code: string }).code).toBe('CHAT_SESSION_BUSY');

    const ans = await post(app, '/api/chat/sessions/s5/answer', { callId: 'c1', answer: '20 个' });
    expect(ans.status).toBe(200);

    const rest = await reader.rest();
    expect(rest.map((e) => e.event)).toEqual(['tool-result', 'text-delta', 'turn-done']);
    expect(rest[0].data).toMatchObject({ toolId: 'ui.ask', ok: true, payload: { answer: '20 个' } });

    // 回答回传模型：第二轮请求的 tool-results 携带 answer
    const msgs = requests[1].messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'tool-calls', 'tool-results']);
    const results = (msgs[2] as { results: Array<{ payload: Record<string, string> }> }).results;
    expect(results[0].payload).toEqual({ answer: '20 个' });

    // 审计豁免：ui.ask 不穿工具总线——本轮无任何 ai:* actor 事件落 oplog
    const actors: string[] = [];
    ctx!.ws.events.forEach((e: { actor: string }) => actors.push(e.actor));
    expect(actors.filter((a) => a.startsWith('ai:'))).toEqual([]);
  });

  it('answer 空回答 → 按 declined 回传模型，流继续到 turn-done', async () => {
    const app = setup(
      scriptedProvider([
        { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '哪个库位？' } }] },
        { text: '好，放默认库位。', toolCalls: [] },
      ]),
    );
    const res = await post(app, '/api/chat/sessions/s6/message', { message: '入库 A-2' });
    const reader = new SseReader(res);
    expect((await reader.next())?.event).toBe('ask');
    // 等挂起真正登记（writeSSE 与读侧是微任务竞争——事件循环一轮即可）
    await new Promise((r) => setTimeout(r, 20));

    const ans = await post(app, '/api/chat/sessions/s6/answer', { callId: 'c1', answer: '   ' });
    expect(ans.status).toBe(200);

    const rest = await reader.rest();
    expect(rest[0].data).toMatchObject({ type: 'tool-result', payload: { declined: true } });
    expect(rest.at(-1)?.event).toBe('turn-done');
  });

  it('5 分钟无应答 → 超时按 declined 回传，流继续到 turn-done', async () => {
    vi.useFakeTimers();
    try {
      const app = setup(
        scriptedProvider([
          { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '要多少个？' } }] },
          { text: '好的，先不入了。', toolCalls: [] },
        ]),
      );
      const res = await post(app, '/api/chat/sessions/s7/message', { message: '入库 A-3' });
      const reader = new SseReader(res);
      expect((await reader.next())?.event).toBe('ask');

      // 无应答快进 5 分钟（挂起的 timer 按 declined 结算）
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      const rest = await reader.rest();
      expect(rest.map((e) => e.event)).toEqual(['tool-result', 'text-delta', 'turn-done']);
      expect(rest[0].data).toMatchObject({ payload: { declined: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answer 端点分支：未知会话 404 / 无挂起 409 / callId 不匹配 409 后仍可正确回答', async () => {
    const app = setup(
      scriptedProvider([
        { text: '你好', toolCalls: [] },
        { text: '', toolCalls: [{ callId: 'c1', toolId: 'ui.ask', args: { question: '数量？' } }] },
        { text: 'ok', toolCalls: [] },
      ]),
    );

    const notFound = await post(app, '/api/chat/sessions/nope/answer', { answer: 'x' });
    expect(notFound.status).toBe(404);

    // 会话 s8 跑完一轮（无挂起）→ answer 409
    await (await post(app, '/api/chat/sessions/s8/message', { message: '你好' })).text();
    const noPending = await post(app, '/api/chat/sessions/s8/answer', { answer: 'x' });
    expect(noPending.status).toBe(409);
    expect(((await noPending.json()) as { code: string }).code).toBe('NO_PENDING_ASK');

    // 会话 s9 挂起中：callId 不匹配 → 409，原挂起仍可被正确回答
    const res = await post(app, '/api/chat/sessions/s9/message', { message: '入库' });
    const reader = new SseReader(res);
    expect((await reader.next())?.event).toBe('ask');
    await new Promise((r) => setTimeout(r, 20)); // 等挂起真正登记（同上）
    const wrong = await post(app, '/api/chat/sessions/s9/answer', { callId: 'c0', answer: '5' });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { code: string }).code).toBe('ASK_MISMATCH');
    const right = await post(app, '/api/chat/sessions/s9/answer', { callId: 'c1', answer: '5' });
    expect(right.status).toBe(200);
    expect((await reader.rest()).at(-1)?.event).toBe('turn-done');
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
