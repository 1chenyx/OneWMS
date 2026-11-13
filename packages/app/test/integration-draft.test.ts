import { describe, expect, it } from 'vitest';
import {
  blankConnector,
  buildSettings,
  draftFromModule,
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
});
