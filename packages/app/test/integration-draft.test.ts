import { describe, expect, it } from 'vitest';
import {
  blankConnector,
  buildSettings,
  callerGuide,
  draftFromModule,
  externalApi,
  modulePatch,
  writerPreview,
} from '../src/lib/integration-draft';

/**
 * 对接草稿：表单盖住名称和鉴权，路由留在 JSON。密钥不进将要保存的配置。
 */

const inbound = {
  id: 'jiancang',
  name: '简仓',
  enabled: true,
  direction: 'inbound',
  transport: { kind: 'http', baseUrl: 'https://erp.example' },
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

describe('对接草稿', () => {
  it('启用的入站写账指向这一家，密钥不进配置', () => {
    const draft = draftFromModule(undefined);
    const connector = blankConnector('jiancang');
    connector.name = '简仓';
    connector.enabled = true;
    connector.json = JSON.stringify(inbound);
    connector.secrets = { token: 's3cret' };
    draft.connectors = [connector];

    const built = buildSettings(draft);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.settings.writers).toEqual({ order: 'jiancang', sku: null, partner: null });
    expect(built.settings.connectors.jiancang).toMatchObject({ name: '简仓', enabled: true });
    expect(JSON.stringify(built.settings)).not.toContain('s3cret');
    expect(writerPreview(draft)).toContain('订单入站：简仓');
  });

  it('两家同时收入库就标成不能一起写', () => {
    const draft = draftFromModule({
      enabled: true,
      settings: { connectors: { jiancang: inbound, other: { ...inbound, id: 'other', name: '另一家' } } },
    });
    expect(writerPreview(draft)).toContain('不能同时写');
    const built = buildSettings(draft);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.settings.writers.order).toBeNull();
  });

  it('没装过的模块用 add，装过的只替换配置', () => {
    const settings = {
      pollIntervalSec: 60,
      maxAttempts: 8,
      timeoutMs: 15_000,
      writers: { order: null, sku: null, partner: null },
      connectors: {},
    };
    expect(modulePatch({ installed: false, wasEnabled: false, hadSettings: false, enabled: true, settings })[0]?.op).toBe('add');
    const replace = modulePatch({ installed: true, wasEnabled: true, hadSettings: true, enabled: true, settings });
    expect(replace).toEqual([{ op: 'replace', path: '/modules/module.integration/settings', value: settings }]);
  });

  it('对外说明始终给出调用格式，不写密钥', () => {
    const text = callerGuide('http://192.168.1.8:3000/');
    expect(text).toContain('POST http://192.168.1.8:3000/api/integrations/{连接器 id}/{路由 id}');
    expect(text).toContain('Authorization: Bearer {令牌}');
    expect(text).toContain('同一主键再推仍是 200');
    expect(text).not.toContain('s3cret');
    expect(callerGuide(null)).toContain('POST {对方打得到的主机}/api/integrations/{连接器 id}/{路由 id}');
  });

  it('接收路由写出给对方的地址和示例，密钥不进说明', () => {
    const webhook = {
      ...inbound,
      routes: [
        {
          ...inbound.routes[0],
          endpointId: undefined,
          inbound: { mode: 'webhook', itemsPath: '' },
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
    };
    const item = draftFromModule({ enabled: true, settings: { connectors: { jiancang: webhook } } }).connectors[0];
    if (!item) throw new Error('没有连接器');
    item.secrets = { token: 's3cret' };
    const doc = externalApi(item, {
      moduleEnabled: true,
      origin: 'http://192.168.1.8:3000',
      writers: { order: 'jiancang', sku: null, partner: null },
    });
    expect(doc.routes).toHaveLength(1);
    expect(doc.routes[0]?.blocked).toBeNull();
    expect(doc.routes[0]?.text).toContain('POST http://192.168.1.8:3000/api/integrations/jiancang/sales-in');
    expect(doc.routes[0]?.text).toContain('Authorization: Bearer {令牌}');
    expect(doc.routes[0]?.text).toContain('"billNo": "SO1001"');
    expect(doc.routes[0]?.text).toContain('"customerCode": "C08"');
    expect(doc.routes[0]?.text).toContain('"itemCode": "A1"');
    expect(doc.routes[0]?.text).toContain('"qty": "2"');
    expect(doc.routes[0]?.text).not.toContain('s3cret');
    expect(doc.routes[0]?.text).toContain('同一主键再推仍是 200');
  });

  it('拉取不给调用地址，不鉴权的接收会标明还不能用', () => {
    const polled = draftFromModule({ enabled: true, settings: { connectors: { jiancang: inbound } } }).connectors[0];
    if (!polled) throw new Error('没有连接器');
    const pull = externalApi(polled, { moduleEnabled: true, origin: null, writers: { order: 'jiancang', sku: null, partner: null } });
    expect(pull.routes).toEqual([]);
    expect(pull.lead).toContain('拉取');

    const open = draftFromModule({
      enabled: true,
      settings: { connectors: { jiancang: { ...inbound, auth: { adapter: 'none' }, routes: [{ ...inbound.routes[0], endpointId: undefined, inbound: { mode: 'webhook', itemsPath: '' } }] } } },
    }).connectors[0];
    if (!open) throw new Error('没有连接器');
    const doc = externalApi(open, { moduleEnabled: true, origin: null, writers: { order: 'jiancang', sku: null, partner: null } });
    expect(doc.routes[0]?.blocked).toContain('必须带鉴权');
    expect(doc.routes[0]?.text).toContain('POST /api/integrations/jiancang/sales-in');
  });
});
