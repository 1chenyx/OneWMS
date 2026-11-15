import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LlmProvider, type LlmTurnRequest, type LlmTurnResponse } from '@one/ai';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import { createChatThreadStore, mergeTurns, sanitizeTurns, type ChatThreadRecord } from '../src/chat-threads.js';

/**
 * 对话存档：成功的一轮落盘，重启后接着聊；列表、删除、清空和 50 条上限。
 */

let ctx: AppContext | undefined;
let dir: string | undefined;

afterEach(() => {
  ctx?.close();
  ctx = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'one-chat-'));
  return join(dir, 'chat-threads.json');
}

function scripted(turns: LlmTurnResponse[], seen?: LlmTurnRequest[]): LlmProvider {
  let i = 0;
  return {
    async completeTurn(req) {
      if (req.system.includes('记忆提取器')) return { text: '{"save":[],"forget":[]}', toolCalls: [] };
      seen?.push({ ...req, messages: [...req.messages] });
      return turns[i++] ?? { text: '', toolCalls: [] };
    },
  };
}

function setup(provider: LlmProvider | undefined, file: string) {
  ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-chat-threads',
    provider,
    aiConfig: provider ? { baseUrl: 'http://127.0.0.1:11434', model: 'test-model' } : undefined,
    chatThreadsPath: file,
  });
  return createApp(ctx);
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
    out.push({
      event: eventLine?.slice(6).trim() ?? '',
      data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>,
    });
  }
  return out;
}

function sample(id: string, updatedAt: number): ChatThreadRecord {
  return {
    id,
    agentId: 'general',
    title: id,
    createdAt: updatedAt,
    updatedAt,
    turns: [{ userText: id, invocations: [], assistantText: '好', done: true }],
    history: [
      { role: 'user', text: id },
      { role: 'assistant', text: '好' },
    ],
  };
}

describe('对话存档', () => {
  it('一轮成功后出现在列表里；重启后下一条仍带上前文', async () => {
    const file = tempFile();
    const app = setup(scripted([{ text: '还有 5 个', toolCalls: [] }]), file);
    const first = await post(app, '/api/chat/sessions/s-keep/message', { message: 'A-1 还剩多少？' });
    expect(parseSse(await first.text()).at(-1)?.event).toBe('turn-done');

    const listed = await app.request('/api/chat/threads');
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { threads: Array<{ id: string; title: string; turns?: unknown }> };
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]).toMatchObject({ id: 's-keep', title: 'A-1 还剩多少？', agentId: 'general' });
    expect(list.threads[0]?.turns).toBeUndefined();

    ctx?.close();
    ctx = undefined;

    const seen: LlmTurnRequest[] = [];
    const again = setup(scripted([{ text: '是的', toolCalls: [] }], seen), file);
    const second = await post(again, '/api/chat/sessions/s-keep/message', { message: '是这批新到的吗？' });
    expect(parseSse(await second.text()).at(-1)?.event).toBe('turn-done');
    expect(seen[0]?.messages).toHaveLength(1);
    const text = seen[0]?.messages[0]?.role === 'user' ? seen[0].messages[0].text : '';
    expect(text).toContain('上一句回复：\n还有 5 个');
    expect(text).toContain('是这批新到的吗？');
    expect(text).not.toContain('A-1 还剩多少？');
  });

  it('气泡写回后标题用用户原文；resume 带回气泡，不把整表存进去', async () => {
    const file = tempFile();
    const app = setup(scripted([{ text: '看到了', toolCalls: [] }]), file);
    const sent = await post(app, '/api/chat/sessions/s-file/message', { message: '按这张表入库' });
    expect(parseSse(await sent.text()).at(-1)?.event).toBe('turn-done');

    const saved = await app.request('/api/chat/threads/s-file', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        agentId: 'general',
        turns: [
          {
            userText: '按这张表入库',
            attachments: [{ id: 'f1', name: '入库.xlsx', kind: 'table', rows: 3 }],
            invocations: [],
            assistantText: '看到了',
            done: true,
          },
        ],
      }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { thread: { title: string } }).thread.title).toBe('按这张表入库');

    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('入库.xlsx');
    expect(raw).not.toContain('headers');

    const opened = await post(app, '/api/chat/sessions/s-file/resume', {});
    expect(opened.status).toBe(200);
    const thread = ((await opened.json()) as { thread: { turns: Array<{ attachments?: Array<{ rows?: number }> }> } }).thread;
    expect(thread.turns[0]?.attachments?.[0]?.rows).toBe(3);
  });

  it('同一段再保存不改时间；说了新的话才更新；打开不改时间', async () => {
    const file = tempFile();
    const store = createChatThreadStore(file);
    store.upsert(sample('s-time', 1_700_000_000_000));
    const app = setup(undefined, file);
    const same = {
      agentId: 'general',
      turns: [
        {
          userText: 's-time',
          invocations: [{ callId: 'c1', toolId: 'wms.order.query', args: { orderNo: 'IN-1' }, ok: true, payload: { ok: true } }],
          assistantText: '好',
          stopped: true,
          done: true,
          elapsedMs: 12_000,
        },
      ],
    };
    const first = await app.request('/api/chat/threads/s-time', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(same),
    });
    expect(first.status).toBe(200);
    const kept = ((await first.json()) as { thread: { updatedAt: number; title: string } }).thread;
    expect(kept.updatedAt).toBe(1_700_000_000_000);
    expect(kept.title).toBe('s-time');

    const second = await app.request('/api/chat/threads/s-time', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(same),
    });
    expect(((await second.json()) as { thread: { updatedAt: number } }).thread.updatedAt).toBe(1_700_000_000_000);

    const retimed = await app.request('/api/chat/threads/s-time', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        agentId: 'general',
        turns: [{ ...same.turns[0], elapsedMs: 99_000 }],
      }),
    });
    expect(((await retimed.json()) as { thread: { updatedAt: number } }).thread.updatedAt).toBe(1_700_000_000_000);
    const mid = JSON.parse(readFileSync(file, 'utf8')) as {
      threads: Array<{ id: string; turns: Array<{ elapsedMs?: number }> }>;
    };
    expect(mid.threads.find((item) => item.id === 's-time')?.turns[0]?.elapsedMs).toBe(99_000);

    const changed = await app.request('/api/chat/threads/s-time', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        agentId: 'general',
        turns: [{ userText: '新的一句', invocations: [], assistantText: '好', done: true }],
      }),
    });
    const moved = ((await changed.json()) as { thread: { updatedAt: number } }).thread.updatedAt;
    expect(moved).toBeGreaterThan(1_700_000_000_000);

    const opened = await post(app, '/api/chat/sessions/s-time/resume', {});
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { thread: { updatedAt: number } }).thread.updatedAt).toBe(moved);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { threads: Array<{ id: string; updatedAt: number }> };
    expect(raw.threads.find((item) => item.id === 's-time')?.updatedAt).toBe(moved);
  });

  it('删除一条，清空时留下指定的那一段', async () => {
    const file = tempFile();
    const store = createChatThreadStore(file);
    store.upsert(sample('keep', 2));
    store.upsert(sample('drop', 1));
    const app = setup(undefined, file);

    const removed = await app.request('/api/chat/threads/drop', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const missing = await post(app, '/api/chat/sessions/drop/resume', {});
    expect(missing.status).toBe(404);

    const cleared = await post(app, '/api/chat/threads/clear', { exceptId: 'keep' });
    expect(cleared.status).toBe(200);
    const left = (await (await app.request('/api/chat/threads')).json()) as { threads: Array<{ id: string }> };
    expect(left.threads.map((item) => item.id)).toEqual(['keep']);

    const bad = await app.request('/api/chat/threads/!!!', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ turns: [{ userText: 'x', invocations: [], assistantText: '', done: true }] }),
    });
    expect(bad.status).toBe(400);
  });

  it('只留最近 50 段；坏文件按没有存档处理', () => {
    const file = tempFile();
    const store = createChatThreadStore(file);
    for (let i = 0; i < 55; i += 1) store.upsert(sample(`t${i}`, i));
    expect(store.list()).toHaveLength(50);
    expect(store.get('t54')).toBeDefined();
    expect(store.get('t4')).toBeUndefined();

    writeFileSync(file, '{ "version": 1 }', 'utf-8');
    const reopened = createChatThreadStore(file);
    expect(reopened.list()).toEqual([]);
    reopened.upsert(sample('again', 1));
    expect(createChatThreadStore(file).get('again')?.title).toBe('again');
  });

  it('模型回报的 token 随 turn-done 送出，并写进存档', async () => {
    const file = tempFile();
    const app = setup(
      scripted([{ text: '还有 5 个', toolCalls: [], usage: { inputTokens: 80, outputTokens: 12 } }]),
      file,
    );
    const sent = await post(app, '/api/chat/sessions/s-use/message', { message: 'A-1 还剩多少？' });
    const events = parseSse(await sent.text());
    expect(events.at(-1)?.data).toMatchObject({
      type: 'turn-done',
      usage: { inputTokens: 80, outputTokens: 12 },
    });

    const opened = await post(app, '/api/chat/sessions/s-use/resume', {});
    const thread = (await opened.json()) as {
      thread: { turns: Array<{ usage?: { inputTokens: number; outputTokens: number } }> };
    };
    expect(thread.thread.turns[0]?.usage).toEqual({ inputTokens: 80, outputTokens: 12 });
  });
});

describe('对话用量', () => {
  it('存档保留每轮 token；用模型上下文补气泡时不丢掉已有用量', () => {
    const turns = sanitizeTurns([
      {
        userText: '查库存',
        invocations: [],
        assistantText: '5 个',
        done: true,
        usage: { inputTokens: 10.9, outputTokens: 2 },
        elapsedMs: 12.9,
      },
      {
        userText: '坏的',
        invocations: [],
        assistantText: '',
        done: true,
        usage: { inputTokens: -1, outputTokens: 1 },
        elapsedMs: -5,
      },
    ]);
    expect(turns?.[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(turns?.[0]?.elapsedMs).toBe(12);
    expect(turns?.[1]?.usage).toBeUndefined();
    expect(turns?.[1]?.elapsedMs).toBeUndefined();
    expect(
      sanitizeTurns([{ userText: '久', invocations: [], assistantText: '', done: true, elapsedMs: 9e15 }])?.[0]?.elapsedMs,
    ).toBe(7 * 24 * 60 * 60 * 1000);

    const merged = mergeTurns(
      [
        { role: 'user', text: '查库存' },
        { role: 'assistant', text: '5 个' },
        { role: 'user', text: '再查' },
        { role: 'assistant', text: '还是 5' },
      ],
      turns?.slice(0, 1),
      { inputTokens: 20, outputTokens: 3 },
    );
    expect(merged.map((turn) => turn.usage)).toEqual([
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 20, outputTokens: 3 },
    ]);
    expect(merged.map((turn) => turn.elapsedMs)).toEqual([12, undefined]);
  });
});
