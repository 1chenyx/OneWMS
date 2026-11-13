import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';
import type { IntegrationSettings } from '../src/integration/types.js';
import { validateIntegrationSettings } from '../src/integration/validate.js';
import { IntegrationQueue } from '../src/integration/queue.js';
import { IntegrationSecretStore } from '../src/integration/secrets.js';
import { catchUpOutbound, pollInbound, type IntegrationFetch } from '../src/integration/deliver.js';

/**
 * 编码对照走账本。实拉和出站映射读投影，不注入对照表。
 */

let core: OneCore | undefined;
let dir: string | undefined;

afterEach(() => {
  core?.close();
  core = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const NOW = '2026-11-13T00:00:00.000Z';
const DUE = '2026-11-13T00:00:15.000Z';

function open(path = ':memory:') {
  core = OneCore.open(path);
  const ws = WmsDomain.attach(core).workspace('ws-code');
  const db = core.exposeDb();
  return {
    ws,
    secrets: new IntegrationSecretStore(db, 'ws-code'),
    queue: new IntegrationQueue(db, 'ws-code'),
  };
}

function accept(input: unknown): IntegrationSettings {
  const result = validateIntegrationSettings(input);
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path} ${issue.code} ${issue.message}`).join('\n'));
  return result.settings;
}

function inbound(): IntegrationSettings {
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
              cursor: { queryParam: 'updatedSince', from: 'iso8601' },
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

function outbound(): IntegrationSettings {
  return accept({
    connectors: {
      jiancang: {
        id: 'jiancang',
        name: '简仓 ERP',
        enabled: true,
        direction: 'outbound',
        transport: { kind: 'http', baseUrl: 'https://erp.jiancang.example' },
        auth: { adapter: 'none' },
        endpoints: [{ id: 'push', method: 'POST', path: '/skus', shape: 'document' }],
        routes: [
          {
            id: 'sku-out',
            enabled: true,
            direction: 'out',
            endpointId: 'push',
            outbound: { event: 'wms.sku.created', requireLink: false },
            canonical: 'sku.snapshot',
            idempotency: { externalIdPath: 'skuCode' },
            mapping: {
              fields: [
                { to: 'itemCode', from: { op: 'code', entity: 'sku', path: 'skuCode' } },
                { to: 'name', from: { op: 'path', path: 'name' } },
              ],
            },
          },
        ],
      },
    },
  });
}

function row(billNo: string, customerCode = 'C08') {
  return { billNo, customerCode, lines: [{ itemCode: 'A1', qty: '2' }] };
}

async function seed(ctx: ReturnType<typeof open>) {
  await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-00001', name: '零件' });
  await ctx.ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-0008', kind: 'customer', name: '客户' });
  await ctx.ws.tools.invoke('wms.inventory.adjust', { skuCode: 'SKU-00001', delta: 10, reason: '期初' });
}

function boundEvents(ctx: ReturnType<typeof open>): number {
  let count = 0;
  ctx.ws.events.forEach((env) => {
    if (env.type === 'wms.integration.code_bound') count += 1;
  });
  return count;
}

describe('编码对照', () => {
  it('绑定之后简仓拉取能建单，缺编码不推进水位', async () => {
    const ctx = open();
    await seed(ctx);
    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'partner',
      externalCode: 'C08',
      internalCode: 'CUS-0008',
    });
    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
      internalCode: 'SKU-00001',
    });
    ctx.secrets.put('jiancang', 'token', 's3cret');
    const settings = inbound();
    const fetchImpl: IntegrationFetch = async () => ({
      status: 200,
      body: JSON.stringify({ data: { rows: [row('SO1001')] } }),
    });

    const pulled = await pollInbound({
      settings,
      queue: ctx.queue,
      secrets: ctx.secrets,
      codes: (connectorId) => ctx.ws.codes.lookup(connectorId),
      invoke: (connectorId, toolId, params) => ctx.ws.tools.invoke(toolId, params, `integration:${connectorId}`),
      fetchImpl,
      now: NOW,
    });

    expect(pulled).toEqual({ fetched: 1, accepted: 1, failed: 0 });
    expect(ctx.ws.orders.byNo('SO1001')?.direction).toBe('out');
    expect(ctx.ws.orders.lines(ctx.ws.orders.byNo('SO1001')!.id)[0]?.quantity).toBe(2);
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe(NOW);

    const missed: IntegrationFetch = async () => ({
      status: 200,
      body: JSON.stringify({ data: { rows: [row('SO1002', 'C99')] } }),
    });
    const held = await pollInbound({
      settings,
      queue: ctx.queue,
      secrets: ctx.secrets,
      codes: (connectorId) => ctx.ws.codes.lookup(connectorId),
      invoke: (connectorId, toolId, params) => ctx.ws.tools.invoke(toolId, params, `integration:${connectorId}`),
      fetchImpl: missed,
      now: DUE,
    });
    expect(held).toEqual({ fetched: 1, accepted: 0, failed: 1 });
    expect(ctx.ws.orders.byNo('SO1002')).toBeUndefined();
    expect(ctx.queue.pollWatermark('jiancang', 'sales-in')?.watermark).toBe(NOW);
    expect(ctx.queue.listInbox('jiancang').some((item) => item.externalId === 'SO1002' && item.error?.includes('编码表没有 partner'))).toBe(
      true,
    );
  });

  it('同一对照不重复落账，占用和空编码会拒绝，重放后还在', async () => {
    dir = mkdtempSync(join(tmpdir(), 'one-code-'));
    const ctx = open(join(dir, 'one.db'));
    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: ' A1 ',
      internalCode: 'SKU-00001',
    });
    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
      internalCode: 'SKU-00001',
    });
    expect(boundEvents(ctx)).toBe(1);
    expect(await ctx.ws.tools.invoke('integration.code.list', { connectorId: 'jiancang' })).toEqual({
      rows: [{ entity: 'sku', externalCode: 'A1', internalCode: 'SKU-00001' }],
    });
    expect(ctx.ws.codes.lookup('jiancang').resolve('sku', 'SKU-00001', 'out')).toBe('A1');
    expect(ctx.ws.codes.lookup('other').resolve('sku', 'A1', 'in')).toBeUndefined();

    await expect(
      ctx.ws.tools.invoke('integration.code.bind', {
        connectorId: 'jiancang',
        entity: 'sku',
        externalCode: 'A2',
        internalCode: 'SKU-00001',
      }),
    ).rejects.toThrow(/已经对上对方编码 A1/);
    await expect(
      ctx.ws.tools.invoke('integration.code.bind', {
        connectorId: 'jiancang',
        entity: 'sku',
        externalCode: 'A 2',
        internalCode: 'SKU-00002',
      }),
    ).rejects.toThrow(/对方编码不合法/);
    await expect(
      ctx.ws.tools.invoke('integration.code.unbind', {
        connectorId: 'jiancang',
        entity: 'partner',
        externalCode: 'C08',
      }),
    ).rejects.toThrow(/没有 partner 的对方编码 C08/);

    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
      internalCode: 'SKU-00002',
    });
    expect(ctx.ws.codes.lookup('jiancang').resolve('sku', 'A1', 'in')).toBe('SKU-00002');
    expect(boundEvents(ctx)).toBe(2);

    const path = join(dir, 'one.db');
    core?.close();
    core = undefined;
    const again = open(path);
    expect(again.ws.codes.lookup('jiancang').resolve('sku', 'A1', 'in')).toBe('SKU-00002');
    again.ws.replay();
    expect(again.ws.codes.lookup('jiancang').resolve('sku', 'A1', 'in')).toBe('SKU-00002');
    expect(again.ws.codes.lookup('jiancang').resolve('sku', 'SKU-00001', 'out')).toBeUndefined();

    await again.ws.tools.invoke('integration.code.unbind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
    });
    expect(again.ws.codes.list('jiancang')).toEqual([]);
    again.ws.replay();
    expect(again.ws.codes.list('jiancang')).toEqual([]);
  });

  it('出站缺对照就停在那条事件，补上之后才翻出对方编码', async () => {
    const ctx = open();
    await ctx.ws.tools.invoke('wms.sku.create', { skuCode: 'SKU-00001', name: '零件' });
    const settings = outbound();
    const codes = (connectorId: string) => ctx.ws.codes.lookup(connectorId);

    const missed = catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW });
    expect(missed.enqueued).toBe(0);
    expect(missed.skipped[0]?.message).toContain('编码表没有 sku 的内部编码 SKU-00001');

    await ctx.ws.tools.invoke('integration.code.bind', {
      connectorId: 'jiancang',
      entity: 'sku',
      externalCode: 'A1',
      internalCode: 'SKU-00001',
    });
    const sent = catchUpOutbound({ ws: ctx.ws, settings, queue: ctx.queue, codes, now: NOW });
    expect(sent).toEqual({ enqueued: 1, skipped: [] });
    expect(ctx.queue.due(NOW)[0]?.body).toEqual({ itemCode: 'A1', name: '零件' });
  });
});
