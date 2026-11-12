import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '@one/ai';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import { createChatThreadStore, type ChatThreadRecord } from '../src/chat-threads.js';

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
    expect(seen[0]?.messages.map((msg) => msg.role)).toEqual(['user', 'assistant', 'user']);
    expect(seen[0]?.messages[0]).toMatchObject({ text: 'A-1 还剩多少？' });
    expect(seen[0]?.messages[2]).toMatchObject({ text: '是这批新到的吗？' });
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
});
