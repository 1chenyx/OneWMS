import { describe, expect, it, afterEach } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '@one/ai';
import {
  applyAttachment,
  composeUserText,
  readAttachment,
  takeAttachments,
  type StoredAttachment,
} from '../src/chat-attachments.js';

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

function sheet(rows: string[][], headers = ['单号', '方向', 'SKU编码', '数量']): StoredAttachment {
  return { id: 'sheet1', name: '入库.csv', kind: 'table', headers, rows, text: '', truncated: false };
}

describe('对话附件', () => {
  it('预览只带前几行，普通消息不被改写', () => {
    expect(composeUserText('查库存', [], [])).toBe('查库存');
    const rows = Array.from({ length: 12 }, (_, i) => [`IN-${i}`, '入库', `A-${i}`, '1']);
    rows[11] = ['IN-HIDDEN', '入库', 'SECRET-SKU', '9'];
    const text = composeUserText('按这张表入库', [sheet(rows)], [sheet(rows)]);
    expect(text).toContain('【附件 sheet1】入库.csv');
    expect(text).toContain('共 12 行');
    expect(text).toContain('用户说：按这张表入库');
    expect(text).not.toContain('SECRET-SKU');
  });

  it('非法附件被拒绝', () => {
    const bad = takeAttachments([{ id: '带空格', name: 'a.csv', kind: 'table', headers: ['编码'], rows: [] }]);
    expect(bad.ok).toBe(false);
  });

  it('商品：已有的更新，没有的新建，缺名称的行单独失败', async () => {
    ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-att' });
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '旧名' });
    const file = sheet(
      [
        ['A-1', '新名'],
        ['B-2', '轴承'],
        ['C-3', ''],
      ],
      ['编码', '名称'],
    );
    const result = (await applyAttachment(ctx.ws, 'ai:test', [file], {
      attachmentId: 'sheet1',
      action: 'sku',
      columns: { skuCode: '编码', name: '名称' },
    })) as { created: number; updated: number; failedCount: number; failed: { skuCode?: string }[] };
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failed[0]?.skuCode).toBe('C-3');
    expect(ctx.ws.skus.byCode('A-1')?.name).toBe('新名');
    expect(ctx.ws.skus.byCode('B-2')?.name).toBe('轴承');
  });

  it('出入库：按单号分组，坏行不影响另一张单', async () => {
    ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-att-order' });
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    const file = sheet([
      ['IN-1', '入库', 'A-1', '10'],
      ['IN-1', '入库', 'A-1', '5'],
      ['IN-2', '入库', 'NO-SUCH', '1'],
    ]);
    const result = (await applyAttachment(ctx.ws, 'ai:test', [file], {
      attachmentId: 'sheet1',
      action: 'orders',
      columns: { orderNo: '单号', direction: '方向', skuCode: 'SKU编码', quantity: '数量' },
    })) as { created: { orderNo: string; lineCount: number }[]; failedCount: number };
    expect(result.created.map((order) => order.orderNo)).toEqual(['IN-1']);
    expect(result.created[0]?.lineCount).toBe(1);
    expect(ctx.ws.orders.byNo('IN-1')?.id).toBeTruthy();
    const lines = ctx.ws.orders.lines(ctx.ws.orders.byNo('IN-1')!.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBe(15);
    expect(result.failedCount).toBe(1);
    expect(ctx.ws.orders.byNo('IN-2')).toBeUndefined();
  });

  it('没有方向列时用参数里的 direction', async () => {
    ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-att-dir' });
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    const file = sheet([['A-1', '3']], ['编码', '数量']);
    const result = (await applyAttachment(ctx.ws, 'ai:test', [file], {
      attachmentId: 'sheet1',
      action: 'orders',
      direction: 'out',
      columns: { skuCode: '编码', quantity: '数量' },
    })) as { created: { direction: string; orderNo: string }[] };
    expect(result.created[0]?.direction).toBe('out');
    expect(ctx.ws.orders.byNo(result.created[0]!.orderNo)?.direction).toBe('out');
  });

  it('翻页读取看不到预览之外的行', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`A-${i}`]);
    const page = readAttachment([sheet(rows, ['编码'])], { attachmentId: 'sheet1', offset: 20, limit: 5 }) as {
      rows: string[][];
      totalRows: number;
    };
    expect(page.totalRows).toBe(30);
    expect(page.rows).toEqual([['A-20'], ['A-21'], ['A-22'], ['A-23'], ['A-24']]);
  });
});

describe('POST /api/chat 带附件', () => {
  it('模型看到预览和落库工具，apply 会真的建档', async () => {
    const requests: LlmTurnRequest[] = [];
    let step = 0;
    const provider: LlmProvider = {
      async completeTurn(req) {
        if (req.system.includes('记忆提取器')) return { text: '{"save":[],"forget":[]}', toolCalls: [] };
        requests.push({ ...req, messages: [...req.messages] });
        const turns: LlmTurnResponse[] = [
          {
            text: '',
            toolCalls: [
              {
                callId: 'c1',
                toolId: 'chat.attachment.apply',
                args: {
                  attachmentId: 'sheet1',
                  action: 'sku',
                  mode: 'create',
                  columns: { skuCode: '编码', name: '名称' },
                },
              },
            ],
          },
          { text: '建好了两个商品。', toolCalls: [] },
        ];
        return turns[step++] ?? { text: '', toolCalls: [] };
      },
    };
    ctx = createAppContext({
      dbPath: ':memory:',
      workspaceId: 'ws-att-chat',
      provider,
      aiConfig: { baseUrl: 'http://127.0.0.1:11434', model: 'test-model' },
    });
    const app = createApp(ctx);
    const res = await app.request('/api/chat/sessions/s-file/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '这些是新商品，帮我建档',
        attachments: [
          {
            id: 'sheet1',
            name: 'sku.csv',
            kind: 'table',
            headers: ['编码', '名称'],
            rows: [
              ['A-9', '轴承'],
              ['A-10', '垫片'],
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('建好了两个商品');
    const user = requests[0].messages.find((m) => m.role === 'user');
    expect(user && user.role === 'user' ? user.text : '').toContain('A-9');
    expect(requests[0].tools.map((tool) => tool.id)).toContain('chat.attachment.apply');
    expect(ctx.ws.skus.byCode('A-9')?.name).toBe('轴承');
    expect(ctx.ws.skus.byCode('A-10')?.name).toBe('垫片');
  });

  it('只读助手看得到附件，但没有落库工具', async () => {
    const requests: LlmTurnRequest[] = [];
    const provider: LlmProvider = {
      async completeTurn(req) {
        if (req.system.includes('记忆提取器')) return { text: '{"save":[],"forget":[]}', toolCalls: [] };
        requests.push(req);
        return { text: '这张表有 1 行。', toolCalls: [] };
      },
    };
    ctx = createAppContext({
      dbPath: ':memory:',
      workspaceId: 'ws-att-ro',
      provider,
      aiConfig: { baseUrl: 'http://127.0.0.1:11434', model: 'test-model' },
    });
    const app = createApp(ctx);
    const res = await app.request('/api/chat/sessions/s-ro/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '看看这张表',
        agentId: 'readonly',
        attachments: [
          { id: 'sheet1', name: 'a.csv', kind: 'table', headers: ['编码'], rows: [['A-1']] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const ids = requests[0].tools.map((tool) => tool.id);
    expect(ids).toContain('chat.attachment.read');
    expect(ids).not.toContain('chat.attachment.apply');
    expect(ids).not.toContain('wms.sku.create');
  });
});
