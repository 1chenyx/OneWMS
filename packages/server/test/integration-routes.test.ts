import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationSecretStore } from '@one/wms';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * Webhook 挂在 /api/integrations。配置走 Profile，密钥在本机库，建单走工具总线。
 */

let ctx: AppContext | undefined;

afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

function setup() {
  ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-integration' });
  return createApp(ctx);
}

const connector = {
  id: 'demo',
  name: '演示',
  enabled: true,
  direction: 'inbound',
  transport: { kind: 'http', baseUrl: 'https://erp.example' },
  auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
  endpoints: [],
  routes: [
    {
      id: 'in',
      enabled: true,
      direction: 'in',
      inbound: { mode: 'webhook', itemsPath: '' },
      canonical: 'order.create',
      idempotency: { externalIdPath: 'billNo' },
      mapping: {
        fields: [
          { to: 'direction', from: { op: 'const', value: 'in' } },
          { to: 'orderNo', from: { op: 'path', path: 'billNo' } },
        ],
        lines: {
          to: 'lines',
          from: 'lines',
          item: [
            { to: 'skuCode', from: { op: 'path', path: 'sku' } },
            { to: 'quantity', from: { op: 'number', path: 'qty' } },
          ],
        },
      },
    },
  ],
};

function install(): void {
  if (!ctx) throw new Error('没有上下文');
  const proposed = ctx.ws.profile.propose(
    'user:tester',
    [
      {
        op: 'add',
        path: '/modules/module.integration',
        value: { enabled: true, settings: { writers: { order: 'demo' }, connectors: { demo: connector } } },
      },
    ],
    '接上演示连接器',
  );
  ctx.ws.profile.confirm(proposed.proposalId, 'user:tester');
  new IntegrationSecretStore(ctx.core.exposeDb(), ctx.workspaceId).put('demo', 'token', 'secret');
}

const body = JSON.stringify({ billNo: 'IN-1', lines: [{ sku: 'SKU-1', qty: '3' }] });

function post(app: ReturnType<typeof createApp>, authorization?: string, payload = body) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization) headers.authorization = authorization;
  return app.request('/api/integrations/demo/in', { method: 'POST', headers, body: payload });
}

describe('对接 webhook', () => {
  it('没装配置时没有入口；装上之后建单，重复推送返回原单号', async () => {
    const app = setup();
    expect((await post(app, 'Bearer secret')).status).toBe(404);

    await ctx!.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-1', name: '零件' });
    install();

    const created = await post(app, 'Bearer secret');
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, internalRef: 'IN-1' });
    expect(ctx!.ws.orders.byNo('IN-1')?.direction).toBe('in');

    const again = await post(app, 'Bearer secret', JSON.stringify({ billNo: 'IN-1', lines: [{ sku: 'SKU-1', qty: '9' }] }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, internalRef: 'IN-1', duplicate: true });
    expect(ctx!.ws.orders.lines(ctx!.ws.orders.byNo('IN-1')!.id)[0]?.quantity).toBe(3);

    const denied = await post(app, 'Bearer wrong');
    expect(denied.status).toBe(401);
    const bad = await post(app, 'Bearer secret', '{');
    expect(bad.status).toBe(422);
  });

  it('简仓编码对照写上之后，webhook 才能把对方编码翻成我们的单', async () => {
    const app = setup();
    await ctx!.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-00001', name: '零件' });
    await ctx!.ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-0008', kind: 'customer', name: '客户' });
    await ctx!.ws.tools.invoke('wms.inventory.adjust', { skuCode: 'SKU-00001', delta: 10, reason: '期初' });
    const proposed = ctx!.ws.profile.propose(
      'user:tester',
      [
        {
          op: 'add',
          path: '/modules/module.integration',
          value: {
            enabled: true,
            settings: {
              writers: { order: 'jiancang' },
              connectors: {
                jiancang: {
                  id: 'jiancang',
                  name: '简仓',
                  enabled: true,
                  direction: 'inbound',
                  transport: { kind: 'http', baseUrl: 'https://erp.jiancang.example' },
                  auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
                  endpoints: [],
                  routes: [
                    {
                      id: 'sales-in',
                      enabled: true,
                      direction: 'in',
                      inbound: { mode: 'webhook', itemsPath: '' },
                      canonical: 'order.create',
                      idempotency: { externalIdPath: 'billNo' },
                      mapping: {
                        fields: [
                          { to: 'direction', from: { op: 'const', value: 'out' } },
                          { to: 'orderNo', from: { op: 'path', path: 'billNo' } },
                          { to: 'partnerCode', from: { op: 'code', entity: 'partner', path: 'customerCode' } },
                        ],
                        lines: {
                          to: 'lines',
                          from: 'lines',
                          item: [
                            { to: 'skuCode', from: { op: 'code', entity: 'sku', path: 'itemCode' } },
                            { to: 'quantity', from: { op: 'number', path: 'qty' } },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      '接上简仓',
    );
    ctx!.ws.profile.confirm(proposed.proposalId, 'user:tester');
    new IntegrationSecretStore(ctx!.core.exposeDb(), ctx!.workspaceId).put('jiancang', 'token', 'secret');

    const payload = JSON.stringify({ billNo: 'SO1001', customerCode: 'C08', lines: [{ itemCode: 'A1', qty: '2' }] });
    const missing = await app.request('/api/integrations/jiancang/sales-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: payload,
    });
    expect(missing.status).toBe(422);
    expect(JSON.stringify(await missing.json())).toContain('编码表没有');
    expect(ctx!.ws.orders.byNo('SO1001')).toBeUndefined();

    await ctx!.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'partner',
      externalCode: 'C08',
      internalCode: 'CUS-0008',
    });
    await ctx!.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
      internalCode: 'SKU-00001',
    });
    const created = await app.request('/api/integrations/jiancang/sales-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: payload,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, internalRef: 'SO1001' });
    expect(ctx!.ws.orders.byNo('SO1001')?.direction).toBe('out');
    expect(ctx!.ws.orders.lines(ctx!.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
  });
});

describe('对接配置', () => {
  it('校验配置，密钥只留名字', async () => {
    const app = setup();
    const empty = await app.request('/api/integrations/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectors: {} }),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true });

    const bad = await app.request('/api/integrations/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectors: { demo: { id: 'nope' } } }),
    });
    expect(bad.status).toBe(200);
    const issues = (await bad.json()) as { ok: boolean; issues: { message: string }[] };
    expect(issues.ok).toBe(false);
    expect(issues.issues.length).toBeGreaterThan(0);

    const put = await app.request('/api/integrations/secrets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'demo', name: 'token', value: 's3cret' }),
    });
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(putText).toBe('{"ok":true}');
    expect(putText).not.toContain('s3cret');

    const listed = await app.request('/api/integrations/secrets?connectorId=demo');
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(JSON.parse(listedText)).toEqual({ names: ['token'] });
    expect(listedText).not.toContain('s3cret');

    const removed = await app.request('/api/integrations/secrets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'demo', name: 'token' }),
    });
    expect(removed.status).toBe(200);
    const after = await app.request('/api/integrations/secrets?connectorId=demo');
    expect(await after.json()).toEqual({ names: [] });

    const denied = await app.request('/api/integrations/secrets?connectorId=Bad');
    expect(denied.status).toBe(400);
  });
});
