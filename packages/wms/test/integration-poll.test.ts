import { afterEach, describe, expect, it } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';
import type { CodeEntity, CodeLookup, IntegrationSettings } from '../src/integration/types.js';
import { validateIntegrationSettings } from '../src/integration/validate.js';
import { IntegrationQueue } from '../src/integration/queue.js';
import { IntegrationSecretStore } from '../src/integration/secrets.js';
import { pollInbound, type IntegrationFetch, type IntegrationRequest } from '../src/integration/deliver.js';

/**
 * 入站拉取。简仓销售单从列表里拉下来，水位和间隔都在本机。
 */

let core: OneCore | undefined;

afterEach(() => {
  core?.close();
  core = undefined;
});

const NOW = '2026-11-13T00:00:00.000Z';
const SOON = '2026-11-13T00:00:14.000Z';
const DUE = '2026-11-13T00:00:15.000Z';

function open() {
  core = OneCore.open(':memory:');
  const ws = WmsDomain.attach(core).workspace('ws-poll');
  const db = core.exposeDb();
  return {
    ws,
    secrets: new IntegrationSecretStore(db, 'ws-poll'),
    queue: new IntegrationQueue(db, 'ws-poll'),
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

function polled(cursorFrom: 'iso8601' | 'unixMs' | 'watermark' = 'iso8601') {
  return accept({
    pollIntervalSec: 15,
    writers: { order: 'jiancang' },
    connectors: {
      jiancang: {
        id: 'jiancang',
        name: '简仓 ERP',
        enabled: true,
        direction: 'inbound',
        transport: { kind: 'http', baseUrl: 'https://erp.jiancang.example' },
        auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
        endpoints: [{ id: 'pull', method: 'GET', path: '/orders', shape: 'document' }],
        routes: [
          {
            id: 'sales-in',
            enabled: true,
            direction: 'in',
            endpointId: 'pull',
            inbound: {
              mode: 'poll',
              itemsPath: 'data.rows',
              cursor: { queryParam: 'updatedSince', from: cursorFrom },
            },
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
  });
}

function row(billNo: string, qty: string) {
  return { billNo, customerCode: 'C08', lines: [{ itemCode: 'A1', qty }] };
}

function page(rows: unknown[], status = 200) {
  return { status, body: JSON.stringify({ data: { rows } }) };
}

async function seed(ctx: ReturnType<typeof open>) {
  await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-00001', name: '零件' });
  await ctx.ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-0008', kind: 'customer', name: '客户' });
  await ctx.ws.tools.invoke('wms.inventory.adjust', { skuCode: 'SKU-00001', delta: 10, reason: '期初' });
}

function pull(
  ctx: ReturnType<typeof open>,
  settings: IntegrationSettings,
  fetchImpl: IntegrationFetch,
  now: string,
  lookup: CodeLookup = codes,
) {
  return pollInbound({
    settings,
    queue: ctx.queue,
    secrets: ctx.secrets,
    codes: lookup,
    invoke: (connectorId, toolId, params) => ctx.ws.tools.invoke(toolId, params, `integration:${connectorId}`),
    fetchImpl,
    now,
  });
}

describe('入站拉取', () => {
  it('按更新时间拉下一页，间隔未到不打，到点用上次请求时间接着拉', async () => {
    const ctx = open();
    await seed(ctx);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const calls: IntegrationRequest[] = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      calls.push(request);
      return page([row('SO1001', '2')]);
    };

    const first = await pull(ctx, polled(), fetchImpl, NOW);
    expect(first).toEqual({ fetched: 1, accepted: 1, failed: 0 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBe('');
    expect(calls[0]?.headers.authorization).toBe('Bearer s3cret');
    expect(new URL(calls[0]!.url).searchParams.get('updatedSince')).toBe('1970-01-01T00:00:00.000Z');
    expect(ctx.ws.orders.byNo('SO1001')?.direction).toBe('out');
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')).toEqual({ watermark: NOW, lastAttemptAt: NOW });

    await pull(ctx, polled(), fetchImpl, SOON);
    expect(calls).toHaveLength(1);

    const again = await pull(ctx, polled(), fetchImpl, DUE);
    expect(again.accepted).toBe(0);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('updatedSince')).toBe(NOW);
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe(DUE);
  });

  it('对方失败或这一页有一笔没接住时水位不动，修好后才往前', async () => {
    const ctx = open();
    await seed(ctx);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    let body = page([], 500);
    const calls: string[] = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      calls.push(new URL(request.url).searchParams.get('updatedSince') ?? '');
      return body;
    };
    const settings = polled();

    const down = await pull(ctx, settings, fetchImpl, NOW);
    expect(down).toEqual({ fetched: 1, accepted: 0, failed: 1 });
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')).toEqual({ watermark: null, lastAttemptAt: NOW });
    expect(ctx.ws.orders.byNo('SO1001')).toBeUndefined();

    await pull(ctx, settings, fetchImpl, SOON);
    expect(calls).toHaveLength(1);

    body = page([row('SO1001', '2'), row('SO1002', 'nope')]);
    const mixed = await pull(ctx, settings, fetchImpl, DUE);
    expect(mixed.accepted).toBe(1);
    expect(mixed.failed).toBe(1);
    expect(ctx.ws.orders.byNo('SO1001')).toBeDefined();
    expect(ctx.ws.orders.byNo('SO1002')).toBeUndefined();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBeNull();
    expect(ctx.queue.listInbox('jiancang').some((item) => item.status === 'rejected' && item.externalId === 'SO1002')).toBe(true);

    const later = '2026-11-13T00:00:30.000Z';
    body = page([row('SO1001', '9'), row('SO1002', '1')]);
    const fixed = await pull(ctx, settings, fetchImpl, later);
    expect(fixed).toEqual({ fetched: 1, accepted: 1, failed: 0 });
    expect(calls[2]).toBe('1970-01-01T00:00:00.000Z');
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
    expect(ctx.ws.orders.byNo('SO1002')).toBeDefined();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe(later);
  });

  it('主键水位第一次不带参数，空页不发明主键，有单据才记下最后一笔', async () => {
    const ctx = open();
    await seed(ctx);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const urls: string[] = [];
    let rows: unknown[] = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      urls.push(request.url);
      return page(rows);
    };
    const settings = polled('watermark');

    await pull(ctx, settings, fetchImpl, NOW);
    expect(new URL(urls[0]!).searchParams.get('updatedSince')).toBeNull();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBeNull();

    rows = [row('SO1001', '2'), row('SO1002', '1')];
    await pull(ctx, settings, fetchImpl, DUE);
    expect(new URL(urls[1]!).searchParams.get('updatedSince')).toBeNull();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe('SO1002');

    await pull(ctx, settings, fetchImpl, '2026-11-13T00:00:30.000Z');
    expect(new URL(urls[2]!).searchParams.get('updatedSince')).toBe('SO1002');
  });

  it('单笔响应用空路径，列表包在对象里才算一页', async () => {
    const ctx = open();
    await seed(ctx);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = polled();
    const route = settings.connectors.jiancang.routes[0];
    if (!route?.inbound) throw new Error('没有入站路由');
    route.inbound = { mode: 'poll', itemsPath: '', cursor: route.inbound.cursor! };
    let body: unknown = row('SO1001', '2');
    const fetchImpl: IntegrationFetch = async () => ({ status: 200, body: JSON.stringify(body) });

    const one = await pull(ctx, settings, fetchImpl, NOW);
    expect(one).toEqual({ fetched: 1, accepted: 1, failed: 0 });
    expect(ctx.ws.orders.byNo('SO1001')).toBeDefined();

    body = [row('SO1002', '1')];
    const list = await pull(ctx, settings, fetchImpl, DUE);
    expect(list.failed).toBe(1);
    expect(ctx.ws.orders.byNo('SO1002')).toBeUndefined();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe(NOW);
  });

  it('毫秒水位从 0 开始，成功后改记请求时间', async () => {
    const ctx = open();
    await seed(ctx);
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const seen: Array<string | null> = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      seen.push(new URL(request.url).searchParams.get('updatedSince'));
      return page([]);
    };
    await pull(ctx, polled('unixMs'), fetchImpl, NOW);
    await pull(ctx, polled('unixMs'), fetchImpl, DUE);
    expect(seen).toEqual(['0', String(Date.parse(NOW))]);
  });

  it('密钥没有、鉴权没接通、写账人不是这家，都不发请求', async () => {
    const ctx = open();
    const calls: IntegrationRequest[] = [];
    const fetchImpl: IntegrationFetch = async (request) => {
      calls.push(request);
      return page([]);
    };

    const missing = await pull(ctx, polled(), fetchImpl, NOW);
    expect(missing.failed).toBe(1);
    expect(calls).toHaveLength(0);
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.lastAttemptAt).toBe(NOW);

    const hmac = polled();
    hmac.connectors.jiancang.auth = {
      adapter: 'hmac-sha256',
      secretRefs: { secret: 'secret' },
      hmac: { header: 'X-Signature', signedParts: ['body'] },
    };
    await pull(ctx, hmac, fetchImpl, DUE);
    expect(calls).toHaveLength(0);

    ctx.secrets.put('jiancang', 'token', 's3cret');
    const unowned = polled();
    unowned.writers.order = null;
    const later = '2026-11-13T00:00:30.000Z';
    const skipped = await pull(ctx, unowned, fetchImpl, later);
    expect(skipped).toEqual({ fetched: 0, accepted: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.lastAttemptAt).toBe(DUE);

    const off = polled();
    off.connectors.jiancang.enabled = false;
    await pull(ctx, off, fetchImpl, '2026-11-13T00:01:00.000Z');
    expect(calls).toHaveLength(0);
  });
});
