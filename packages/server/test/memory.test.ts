import { describe, it, expect, afterEach, vi } from 'vitest';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '@one/ai';
import { createApp, createAppContext, runMemoryExtraction, type AppContext } from '../src/index.js';

/**
 * 记忆功能路由级直测（app.request，不起端口、不碰真实 LLM）：
 *  - 管理端点读写分治：GET 直查投影；POST 经工具总线（actor user:local →
 *    source='manual'，落 oplog 可审计）；
 *  - 设置走慢通道：propose → confirm 后 GET 才反映新值；
 *  - 自动提取端到端：chat turn-done → 后台提取调用（system 含「记忆提取器」）
 *    → 落账 source='auto'、actor=ai:memory-auto@{nodeId}；
 *  - autoMemory 关闭 → 零提取调用；空 assistant 轮 → 零提取调用；
 *  - 记忆注入：已有记忆出现在 chat 的 System Prompt「记忆」段。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

function setup(provider?: LlmProvider): ReturnType<typeof createApp> {
  ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-memory-test',
    provider,
    aiConfig: provider ? { baseUrl: 'http://127.0.0.1:11434', model: 'test-model' } : undefined,
  });
  return createApp(ctx);
}

interface MemoryOut {
  memoryId: string;
  scope: 'personal' | 'project';
  content: string;
  source: 'auto' | 'ai' | 'manual';
  updatedAt: string;
}

interface MemoryListResponse {
  memories: MemoryOut[];
  settings: { autoMemory: boolean; maxMemoryItems: number };
}

/** chat 剧本 provider + 提取应答（按 system 是否含「记忆提取器」分流；extraction 延迟求值可变） */
function providerWithExtraction(
  chatTurns: LlmTurnResponse[],
  extraction: () => LlmTurnResponse,
): { provider: LlmProvider; requests: LlmTurnRequest[]; extractionCalled: Promise<void> } {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  let resolveExtraction!: () => void;
  const extractionCalled = new Promise<void>((r) => {
    resolveExtraction = r;
  });
  const provider: LlmProvider = {
    async completeTurn(req) {
      requests.push(req);
      if (req.system.includes('记忆提取器')) {
        resolveExtraction();
        return extraction();
      }
      return chatTurns[i++] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests, extractionCalled };
}

async function listMemories(app: ReturnType<typeof createApp>): Promise<MemoryListResponse> {
  const res = await app.request('/api/memory');
  expect(res.status).toBe(200);
  return (await res.json()) as MemoryListResponse;
}

describe('GET/POST /api/memory（读写分治）', () => {
  it('空库：清单空 + 默认设置（autoMemory=true, maxMemoryItems=200）', async () => {
    const app = setup();
    const data = await listMemories(app);
    expect(data.memories).toEqual([]);
    expect(data.settings).toEqual({ autoMemory: true, maxMemoryItems: 200 });
  });

  it('POST 保存（manual）→ 清单可见 → scope 过滤 → forget 删除', async () => {
    const app = setup();
    const res = await post(app, '/api/memory', { scope: 'project', content: 'A001 是易碎品' });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as MemoryOut;
    expect(saved.source).toBe('manual'); // actor=user:local → manual
    expect(saved.scope).toBe('project');

    let data = await listMemories(app);
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].content).toBe('A001 是易碎品');

    const filtered = await app.request('/api/memory?scope=personal');
    expect(((await filtered.json()) as MemoryListResponse).memories).toHaveLength(0);

    const forget = await post(app, `/api/memory/${saved.memoryId}/forget`, {});
    expect(forget.status).toBe(200);
    data = await listMemories(app);
    expect(data.memories).toHaveLength(0);
  });

  it('写走工具总线：事件落 oplog，actor=user:local（审计可辨）', async () => {
    const app = setup();
    await post(app, '/api/memory', { scope: 'personal', content: '用户习惯周日盘点' });
    let saved = 0;
    ctx!.ws.events.forEach((env) => {
      if (env.type === 'memory.item.saved') {
        saved++;
        expect(env.actor).toBe(`user:local@${ctx!.core.nodeId}`);
      }
    });
    expect(saved).toBe(1);
  });
});

describe('POST /api/memory/settings/propose（慢通道）', () => {
  it('非法值 400；合法提议 → confirm 后 GET 反映新值', async () => {
    const app = setup();
    const bad = await post(app, '/api/memory/settings/propose', { maxMemoryItems: 0 });
    expect(bad.status).toBe(400);

    const propose = await post(app, '/api/memory/settings/propose', { autoMemory: false, maxMemoryItems: 50 });
    expect(propose.status).toBe(201);
    const { proposalId } = (await propose.json()) as { proposalId: string };

    // 提议未确认前：设置仍是默认（生效面未变——确认权在人类）
    let data = await listMemories(app);
    expect(data.settings).toEqual({ autoMemory: true, maxMemoryItems: 200 });

    const confirm = await post(app, `/api/proposals/${proposalId}/confirm`, {});
    expect(confirm.status).toBe(200);

    data = await listMemories(app);
    expect(data.settings).toEqual({ autoMemory: false, maxMemoryItems: 50 });
  });
});

describe('自动提取端到端（chat turn-done → 后台落账）', () => {
  it('对话后提取：save 落账 source=auto、actor=ai:memory-auto；forget 生效', async () => {
    let seedMemoryId = '';
    const { provider } = providerWithExtraction(
      [{ text: '好的，我会注意易碎品。', toolCalls: [] }],
      () => ({
        text: JSON.stringify({
          save: [{ scope: 'project', content: 'A001 是易碎品，轻拿轻放' }],
          forget: [{ memoryId: seedMemoryId }],
        }),
        toolCalls: [],
      }),
    );
    const app = setup(provider);

    // 预置一条将被遗忘的记忆（提取时已注入清单 → forget 决策的判据）
    const seed = (await (await post(app, '/api/memory', { scope: 'personal', content: '旧偏好' })).json()) as MemoryOut;
    seedMemoryId = seed.memoryId;

    const res = await post(app, '/api/chat/sessions/s1/message', {
      message: '记住 A001 是易碎品，另外忘掉我的旧偏好',
    });
    expect(res.status).toBe(200);
    await res.text(); // 消费 SSE 流（streamSSE 惰性执行——读到 EOF turn-done 才触发提取）

    await vi.waitFor(
      async () => {
        const data = await listMemories(app);
        expect(data.memories.some((m) => m.content === 'A001 是易碎品，轻拿轻放' && m.source === 'auto')).toBe(true);
        expect(data.memories.some((m) => m.memoryId === seedMemoryId)).toBe(false); // forget 已生效
      },
      { timeout: 5000 },
    );

    // 审计：memory.item.saved(auto) 的 actor = ai:memory-auto@{nodeId}
    let autoSaved = 0;
    ctx!.ws.events.forEach((env) => {
      if (env.type === 'memory.item.saved' && (env.payload as { source: string }).source === 'auto') {
        autoSaved++;
        expect(env.actor).toBe(`ai:memory-auto@${ctx!.core.nodeId}`);
      }
    });
    expect(autoSaved).toBe(1);
  });

  it('提取输出非法 JSON → 静默跳过（聊天不受影响）', async () => {
    const { provider, extractionCalled } = providerWithExtraction(
      [{ text: '好的', toolCalls: [] }],
      () => ({ text: '抱歉，我不明白', toolCalls: [] }),
    );
    const app = setup(provider);
    const res = await post(app, '/api/chat/sessions/s2/message', { message: '随便聊聊' });
    expect(res.status).toBe(200);
    await res.text(); // 消费 SSE 流（触发 turn-done → 排队提取）
    await extractionCalled;
    const data = await listMemories(app);
    expect(data.memories).toHaveLength(0); // 非法输出零落账
  });

  it('autoMemory 关闭 → 不发起提取调用', async () => {
    const { provider } = providerWithExtraction(
      [{ text: '好的', toolCalls: [] }],
      () => ({ text: '{}', toolCalls: [] }),
    );
    const app = setup(provider);
    const propose = await post(app, '/api/memory/settings/propose', { autoMemory: false });
    const { proposalId } = (await propose.json()) as { proposalId: string };
    await post(app, `/api/proposals/${proposalId}/confirm`, {});

    const chat = await post(app, '/api/chat/sessions/s3/message', { message: '记住我喜欢蓝色' });
    await chat.text(); // 消费 SSE 流（触发 turn-done；autoMemory 关闭 → 提取零成本跳过）
    // 提取通道不应被调用（给一个短暂窗口后断言零记忆）
    await new Promise((r) => setTimeout(r, 150));
    const data = await listMemories(app);
    expect(data.memories).toHaveLength(0);
  });

  it('runMemoryExtraction：空 assistant 轮直接跳过（纯工具轮无记忆价值）', async () => {
    const { provider } = providerWithExtraction([], () => ({ text: '{}', toolCalls: [] }));
    const app = setup(provider);
    await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: '查库存' },
      { role: 'tool-calls', calls: [] },
      { role: 'tool-results', results: [] },
    ]);
    const data = await listMemories(app);
    expect(data.memories).toHaveLength(0);
  });
});

describe('记忆注入 chat System Prompt', () => {
  it('已有记忆 → 下一轮对话 System Prompt 含记忆段', async () => {
    const requests: LlmTurnRequest[] = [];
    let i = 0;
    const provider: LlmProvider = {
      async completeTurn(req) {
        requests.push(req);
        return [{ text: '好的', toolCalls: [] }][i++] ?? { text: '', toolCalls: [] };
      },
    };
    const app = setup(provider);
    await post(app, '/api/memory', { scope: 'project', content: 'A001 是易碎品' });
    await post(app, '/api/memory', { scope: 'personal', content: '用户习惯周日盘点' });

    const chat = await post(app, '/api/chat/sessions/s4/message', { message: '注意易碎品' });
    await chat.text(); // 消费 SSE 流（驱动模型调用）

    expect(requests[0].system).toContain('记忆（2 条');
    expect(requests[0].system).toContain('A001 是易碎品');
    expect(requests[0].system).toContain('用户习惯周日盘点');
  });
});
