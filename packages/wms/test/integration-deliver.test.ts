import { afterEach, describe, expect, it } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';
import type { CodeEntity, CodeLookup, IntegrationSettings } from '../src/integration/types.js';
import { validateIntegrationSettings } from '../src/integration/validate.js';
import { IntegrationQueue } from '../src/integration/queue.js';
import { IntegrationSecretStore } from '../src/integration/secrets.js';
import { catchUpOutbound, pushDue, receiveWebhook, type IntegrationFetch } from '../src/integration/deliver.js';
import { allowDirectShip } from './direct-ship.js';

/**
 * Webhook 收单和出站推送。
 * 简仓样例：对方推销售出库，发货后把状态推回去。
 */

let core: OneCore | undefined;

afterEach(() => {
  core?.close();
  core = undefined;
});

const NOW = '2026-11-13T00:00:00.000Z';
const LATER = '2026-11-13T00:00:02.000Z';

function open() {
  core = OneCore.open(':memory:');
  const ws = WmsDomain.attach(core).workspace('ws-deliver');
  const db = core.exposeDb();
  return {
    ws,
    secrets: new IntegrationSecretStore(db, 'ws-deliver'),
    queue: new IntegrationQueue(db, 'ws-deliver'),
  };
}

function accept(input: unknown): IntegrationSettings {
  const result = validateIntegrationSettings(input);
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path} ${issue.code} ${issue.message}`).join('\n'));
  return result.settings;
}

function book(pairs: Array<[CodeEntity, string, string]>): CodeLookup {
  const inbound = new Map(pairs.map(([entity, external, internal]) => [`${entity}\0${external}`, internal]));
  const outbound = new Map(pairs.map(([entity, external, internal]) => [`${entity}\0${internal}`, external]));
  return {
    resolve(entity, code, direction) {
      return (direction === 'in' ? inbound : outbound).get(`${entity}\0${code}`);
    },
  };
}

const codes = book([
  ['partner', 'C08', 'CUS-0008'],
  ['sku', 'A1', 'SKU-00001'],
]);

function jiancang(enabled = true) {
  return accept({
    writers: { order: 'jiancang' },
    connectors: {
      jiancang: {
        id: 'jiancang',
        name: '简仓 ERP',
        enabled,
        direction: 'both',
        transport: { kind: 'http', baseUrl: 'https://erp.jiancang.example' },
        auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
        endpoints: [{ id: 'ship', method: 'POST', path: '/wms/ship/{orderNo}', shape: 'document' }],
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
          {
            id: 'ship-out',
            enabled: true,
            direction: 'out',
            endpointId: 'ship',
            outbound: { event: 'wms.order.state_changed', when: { path: 'to', eq: 'shipped' }, requireLink: true },
            canonical: 'order.snapshot',
            idempotency: { externalIdPath: 'externalId' },
            mapping: {
              fields: [
                { to: 'billNo', from: { op: 'path', path: 'externalId' } },
                { to: 'status', from: { op: 'const', value: 'SHIPPED' } },
              ],
            },
          },
        ],
      },
    },
  });
}

const salesOrder = {
  billNo: 'SO1001',
  customerCode: 'C08',
  lines: [{ itemCode: 'A1', qty: '2' }],
};

async function seedGoods(ws: ReturnType<typeof open>['ws'], skuCode = 'SKU-00001'): Promise<void> {
  await ws.tools.invoke('wms.sku.create', { skuCode, name: '零件' });
  await ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-0008', kind: 'customer', name: '客户' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode, delta: 10, reason: '期初' });
}

function receive(
  ctx: ReturnType<typeof open>,
  settings: IntegrationSettings,
  body: unknown,
  headers: Record<string, string | undefined>,
  invoke: (toolId: string, params: Record<string, unknown>) => Promise<unknown>,
  lookup: CodeLookup = codes,
) {
  return receiveWebhook({
    settings,
    connectorId: 'jiancang',
    routeId: 'sales-in',
    headers,
    body,
    secrets: ctx.secrets,
    queue: ctx.queue,
    codes: lookup,
    invoke,
    now: NOW,
  });
}

describe('简仓 webhook', () => {
  it('收下一张销售出库，重复推送不再建单', async () => {
    const ctx = open();
    await seedGoods(ctx.ws);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = jiancang();
    const tools: string[] = [];
    const invoke = async (toolId: string, params: Record<string, unknown>) => {
      tools.push(toolId);
      return ctx.ws.tools.invoke(toolId, params, 'integration:jiancang');
    };
    const bearer = { authorization: 'Bearer s3cret' };

    const created = await receive(ctx, settings, salesOrder, bearer, invoke);
    expect(created).toEqual({ status: 200, body: { ok: true, internalRef: 'SO1001' } });
    expect(ctx.ws.orders.byNo('SO1001')?.direction).toBe('out');
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);

    const again = await receive(ctx, settings, { ...salesOrder, lines: [{ itemCode: 'A1', qty: '9' }] }, bearer, invoke);
    expect(again).toEqual({ status: 200, body: { ok: true, internalRef: 'SO1001', duplicate: true } });
    expect(tools.filter((id) => id === 'wms.order.create')).toHaveLength(1);
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
  });

  it('密钥不对不建单，映射失败留拒绝记录，工具拒绝不留关联', async () => {
    const ctx = open();
    await seedGoods(ctx.ws);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = jiancang();
    const invoke = (toolId: string, params: Record<string, unknown>) => ctx.ws.tools.invoke(toolId, params, 'integration:jiancang');
    const bearer = { authorization: 'Bearer s3cret' };

    const denied = await receive(ctx, settings, salesOrder, { authorization: 'Bearer wrong' }, invoke);
    expect(denied.status).toBe(401);
    expect(ctx.ws.orders.byNo('SO1001')).toBeUndefined();
    expect(ctx.queue.listInbox('jiancang')).toHaveLength(0);

    const mapped = await receive(ctx, settings, { ...salesOrder, lines: [{ itemCode: 'A1', qty: 'nope' }] }, bearer, invoke);
    expect(mapped.status).toBe(422);
    expect(mapped.body.code).toBe('MAP_NUMBER');
    expect(ctx.queue.acceptedRef('jiancang', 'sales-in', 'SO1001')).toBeUndefined();
    expect(ctx.queue.listInbox('jiancang').some((row) => row.status === 'rejected')).toBe(true);

    const missingSku = book([
      ['partner', 'C08', 'CUS-0008'],
      ['sku', 'A1', 'SKU-NOPE'],
    ]);
    const rejected = await receive(ctx, settings, salesOrder, bearer, invoke, missingSku);
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('WMS_SKU_NOT_FOUND');
    expect(ctx.queue.acceptedRef('jiancang', 'sales-in', 'SO1001')).toBeUndefined();

    const fixed = await receive(ctx, settings, salesOrder, bearer, invoke);
    expect(fixed.status).toBe(200);
    expect(fixed.body.internalRef).toBe('SO1001');
    expect(ctx.queue.acceptedRef('jiancang', 'sales-in', 'SO1001')).toBe('SO1001');
  });

  it('停用的连接器不接收', async () => {
    const ctx = open();
    await seedGoods(ctx.ws);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const result = await receive(ctx, jiancang(false), salesOrder, { authorization: 'Bearer s3cret' }, async () => {
      throw new Error('不应该调用工具');
    });
    expect(result.status).toBe(404);
    expect(ctx.ws.orders.byNo('SO1001')).toBeUndefined();
  });
});

describe('出站推送', () => {
  it('发货后入队并推到简仓，地址带上单号', async () => {
    const ctx = open();
    await seedGoods(ctx.ws);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = jiancang();
    const invoke = (toolId: string, params: Record<string, unknown>) => ctx.ws.tools.invoke(toolId, params, 'integration:jiancang');
    const created = await receive(ctx, settings, salesOrder, { authorization: 'Bearer s3cret' }, invoke);
    expect(created.status).toBe(200);

    const beforeShip = catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW });
    expect(beforeShip.enqueued).toBe(0);

    allowDirectShip(ctx.ws);
    await ctx.ws.tools.invoke('wms.order.transition', { orderNo: 'SO1001', to: 'shipped' });
    const caught = catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW });
    expect(caught.enqueued).toBe(1);
    expect(caught.skipped).toEqual([]);

    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      calls.push(request);
      return { status: 200, body: '' };
    };
    const pushed = await pushDue({ ws: ctx.ws, settings, queue: ctx.queue, secrets: ctx.secrets, fetchImpl, now: NOW });
    expect(pushed).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://erp.jiancang.example/wms/ship/SO1001',
      method: 'POST',
      body: JSON.stringify({ billNo: 'SO1001', status: 'SHIPPED' }),
    });
    expect(calls[0]?.headers.authorization).toBe('Bearer s3cret');
    expect(ctx.queue.due(LATER)).toHaveLength(0);

    const again = await pushDue({ ws: ctx.ws, settings, queue: ctx.queue, secrets: ctx.secrets, fetchImpl, now: LATER });
    expect(again.sent).toBe(0);
    expect(calls).toHaveLength(1);

    const cursor = ctx.queue.cursor('jiancang');
    ctx.ws.replay();
    expect(ctx.queue.cursor('jiancang')).toBe(cursor);
    expect(ctx.queue.due(LATER)).toHaveLength(0);
  });

  it('对方失败后退避，到点再推；停用时不发', async () => {
    const ctx = open();
    await seedGoods(ctx.ws);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = jiancang();
    const invoke = (toolId: string, params: Record<string, unknown>) => ctx.ws.tools.invoke(toolId, params, 'integration:jiancang');
    await receive(ctx, settings, salesOrder, { authorization: 'Bearer s3cret' }, invoke);
    allowDirectShip(ctx.ws);
    await ctx.ws.tools.invoke('wms.order.transition', { orderNo: 'SO1001', to: 'shipped' });
    catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW });

    let status = 500;
    let calls = 0;
    const fetchImpl: IntegrationFetch = async () => {
      calls += 1;
      return { status, body: 'no' };
    };
    const paused = structuredClone(settings);
    paused.connectors.jiancang!.enabled = false;
    const skipped = await pushDue({ ws: ctx.ws, settings: paused, queue: ctx.queue, secrets: ctx.secrets, fetchImpl, now: NOW });
    expect(skipped).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(calls).toBe(0);

    const failed = await pushDue({ ws: ctx.ws, settings, queue: ctx.queue, secrets: ctx.secrets, fetchImpl, now: NOW });
    expect(failed.failed).toBe(1);
    expect(ctx.queue.due(NOW)).toHaveLength(0);
    expect(ctx.queue.due(LATER)[0]?.status).toBe('failed');
    expect(ctx.queue.due(LATER)[0]?.lastError).toBe('对方返回 500');

    status = 200;
    const retried = await pushDue({ ws: ctx.ws, settings, queue: ctx.queue, secrets: ctx.secrets, fetchImpl, now: LATER });
    expect(retried.sent).toBe(1);
    expect(calls).toBe(2);
  });

  it('编码还没对照上就停住，补上之后再入队', async () => {
    const ctx = open();
    const settings = accept({
      connectors: {
        codes: {
          id: 'codes',
          name: '编码',
          enabled: true,
          direction: 'outbound',
          transport: { kind: 'http', baseUrl: 'https://erp.example' },
          auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
          endpoints: [{ id: 'push', method: 'POST', path: '/partners', shape: 'document' }],
          routes: [
            {
              id: 'partner-out',
              enabled: true,
              direction: 'out',
              endpointId: 'push',
              outbound: { event: 'wms.partner.created', requireLink: false },
              canonical: 'partner.snapshot',
              idempotency: { externalIdPath: 'partnerCode' },
              mapping: {
                fields: [{ to: 'erpCode', from: { op: 'code', entity: 'partner', path: 'partnerCode' } }],
              },
            },
          ],
        },
      },
    });
    await ctx.ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });
    const empty = book([]);
    const held = catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes: empty, now: NOW });
    expect(held.enqueued).toBe(0);
    expect(held.skipped.map((skip) => skip.code)).toEqual(['MAP_CODE']);
    const cursor = ctx.queue.cursor('codes');

    const ready = catchUpOutbound({
      ws: ctx.ws,
      settings,
      queue: ctx.queue,
      codes: book([['partner', 'EXT', 'CUS-1']]),
      now: NOW,
    });
    expect(ready.enqueued).toBe(1);
    expect(ready.skipped).toEqual([]);
    expect(ctx.queue.cursor('codes')).toBeGreaterThan(cursor);
    expect(ctx.queue.due(NOW)[0]?.body).toEqual({ erpCode: 'EXT' });
  });

  it('hmac 还没接通时不发请求', async () => {
    const ctx = open();
    const settings = accept({
      connectors: {
        signed: {
          id: 'signed',
          name: '签名',
          enabled: true,
          direction: 'outbound',
          transport: { kind: 'http', baseUrl: 'https://erp.example' },
          auth: {
            adapter: 'hmac-sha256',
            secretRefs: { secret: 'secret' },
            hmac: { header: 'X-Signature', signedParts: ['body'] },
          },
          endpoints: [{ id: 'push', method: 'POST', path: '/hook', shape: 'document' }],
          routes: [
            {
              id: 'partner-out',
              enabled: true,
              direction: 'out',
              endpointId: 'push',
              outbound: { event: 'wms.partner.created', requireLink: false },
              canonical: 'partner.snapshot',
              idempotency: { externalIdPath: 'partnerCode' },
              mapping: { fields: [{ to: 'code', from: { op: 'path', path: 'partnerCode' } }] },
            },
          ],
        },
      },
    });
    await ctx.ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });
    expect(catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW }).enqueued).toBe(1);
    let calls = 0;
    const pushed = await pushDue({
      ws: ctx.ws,
      settings,
      queue: ctx.queue,
      secrets: ctx.secrets,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, body: '' };
      },
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(pushed.failed).toBe(1);
    expect(ctx.queue.due(LATER)[0]?.lastError).toContain('还没接通');
  });
});

describe('API Key 和 Basic', () => {
  it('对得上头才收单', async () => {
    const ctx = open();
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-1', name: '零件' });
    const settings = accept({
      writers: { order: 'inbound' },
      connectors: {
        inbound: {
          id: 'inbound',
          name: '入站',
          enabled: true,
          direction: 'inbound',
          transport: { kind: 'http', baseUrl: 'https://erp.example' },
          auth: { adapter: 'apiKey', secretRefs: { key: 'key' }, placement: { header: 'X-Api-Key', prefix: 'Key ' } },
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
        },
      },
    });
    ctx.secrets.put('inbound', 'key', 'k1');
    const invoke = (toolId: string, params: Record<string, unknown>) => ctx.ws.tools.invoke(toolId, params, 'integration:inbound');
    const body = { billNo: 'IN-1', lines: [{ sku: 'SKU-1', qty: '1' }] };
    const missing = await receiveWebhook({
      settings,
      connectorId: 'inbound',
      routeId: 'in',
      headers: {},
      body,
      secrets: ctx.secrets,
      queue: ctx.queue,
      codes,
      invoke,
      now: NOW,
    });
    expect(missing.status).toBe(401);
    const ok = await receiveWebhook({
      settings,
      connectorId: 'inbound',
      routeId: 'in',
      headers: { 'X-Api-Key': 'Key k1' },
      body,
      secrets: ctx.secrets,
      queue: ctx.queue,
      codes,
      invoke,
      now: NOW,
    });
    expect(ok).toEqual({ status: 200, body: { ok: true, internalRef: 'IN-1' } });
    expect(ctx.ws.orders.byNo('IN-1')?.direction).toBe('in');
  });

  it('Basic 用用户名和密码', async () => {
    const ctx = open();
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-1', name: '零件' });
    const settings = accept({
      writers: { order: 'basic' },
      connectors: {
        basic: {
          id: 'basic',
          name: '基本',
          enabled: true,
          direction: 'inbound',
          transport: { kind: 'http', baseUrl: 'https://erp.example' },
          auth: { adapter: 'basic', secretRefs: { username: 'username', password: 'password' } },
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
        },
      },
    });
    ctx.secrets.put('basic', 'username', 'erp');
    ctx.secrets.put('basic', 'password', 'pw');
    const token = Buffer.from('erp:pw', 'utf8').toString('base64');
    const result = await receiveWebhook({
      settings,
      connectorId: 'basic',
      routeId: 'in',
      headers: { authorization: `Basic ${token}` },
      body: { billNo: 'IN-2', lines: [{ sku: 'SKU-1', qty: 1 }] },
      secrets: ctx.secrets,
      queue: ctx.queue,
      codes,
      invoke: (toolId, params) => ctx.ws.tools.invoke(toolId, params, 'integration:basic'),
      now: NOW,
    });
    expect(result.status).toBe(200);
    expect(result.body.internalRef).toBe('IN-2');
  });
});
