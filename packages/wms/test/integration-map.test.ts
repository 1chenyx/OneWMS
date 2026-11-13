import { describe, expect, it } from 'vitest';
import { applyMapping, outboundMatches } from '../src/integration/map.js';
import type { CodeEntity, CodeLookup, Connector, IntegrationSettings, Route } from '../src/integration/types.js';
import { validateConnector, validateIntegrationSettings } from '../src/integration/validate.js';

/**
 * 对接配置的校验和映射。纯函数，不发请求。
 * 样例是「简仓」：对方推销售出库，我们发货后再把状态推回去。
 */

const jiancang = {
  id: 'jiancang',
  name: '简仓 ERP',
  enabled: false,
  direction: 'both',
  transport: { kind: 'http', baseUrl: 'https://erp.jiancang.example' },
  auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
  endpoints: [{ id: 'ship', method: 'POST', path: '/wms/ship', shape: 'document' }],
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
      outbound: {
        event: 'wms.order.state_changed',
        when: { path: 'to', eq: 'shipped' },
        requireLink: true,
      },
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
};

const salesOrder = {
  billNo: 'SO1001',
  customerCode: 'C08',
  lines: [{ itemCode: 'A1', qty: '2' }],
};

const shippedSnapshot = {
  orderNo: 'SO1001',
  direction: 'out',
  state: 'shipped',
  from: 'created',
  to: 'shipped',
  partnerCode: 'CUS-0008',
  note: '加急',
  externalId: 'SO1001',
  occurredAt: '2026-11-12T00:00:00.000Z',
  lines: [{ skuCode: 'SKU-00001', quantity: 2, locationCode: 'DEFAULT' }],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function accept(input: unknown): IntegrationSettings {
  const result = validateIntegrationSettings(input);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => `${issue.path} ${issue.code} ${issue.message}`).join('\n'));
  }
  return result.settings;
}

function codesOf(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

function routeNamed(settings: IntegrationSettings, connectorId: string, routeId: string): Route {
  const route = settings.connectors[connectorId]?.routes.find((item) => item.id === routeId);
  if (!route) throw new Error(`没有路由 ${connectorId}/${routeId}`);
  return route;
}

function orderInbound(id: string, enabled = true): Connector {
  return {
    id,
    name: id,
    enabled,
    direction: 'inbound',
    transport: { kind: 'http', baseUrl: 'https://example.com' },
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
            { to: 'direction', from: { op: 'const', value: 'out' } },
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
}

describe('简仓往返', () => {
  it('停用的草稿能通过校验，间隔和次数用缺省', () => {
    const settings = accept({ connectors: { jiancang } });
    expect(settings.pollIntervalSec).toBe(60);
    expect(settings.maxAttempts).toBe(8);
    expect(settings.timeoutMs).toBe(15_000);
    expect(settings.writers).toEqual({ order: null, sku: null, partner: null });
    expect(validateConnector(jiancang).ok).toBe(true);
  });

  it('启用后必须把 order 入站写到这个连接器', () => {
    const enabled = clone(jiancang);
    enabled.enabled = true;
    const missing = validateIntegrationSettings({ connectors: { jiancang: enabled } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(codesOf(missing.issues)).toContain('WRITER');

    const settings = accept({ connectors: { jiancang: enabled }, writers: { order: 'jiancang' } });
    const inbound = applyMapping(routeNamed(settings, 'jiancang', 'sales-in'), salesOrder, codes);
    expect(inbound).toEqual({
      ok: true,
      value: {
        direction: 'out',
        orderNo: 'SO1001',
        partnerCode: 'CUS-0008',
        lines: [{ skuCode: 'SKU-00001', quantity: 2, locationCode: 'DEFAULT' }],
      },
    });

    const outboundRoute = routeNamed(settings, 'jiancang', 'ship-out');
    expect(outboundMatches(outboundRoute, shippedSnapshot, { hasLink: true })).toBe(true);
    expect(outboundMatches(outboundRoute, { ...shippedSnapshot, to: 'created' }, { hasLink: true })).toBe(false);
    expect(outboundMatches(outboundRoute, shippedSnapshot, { hasLink: false })).toBe(false);
    const outbound = applyMapping(outboundRoute, shippedSnapshot, codes);
    expect(outbound).toEqual({ ok: true, value: { billNo: 'SO1001', status: 'SHIPPED' } });
  });
});

describe('校验', () => {
  it('webhook 不能没有鉴权，密钥引用不能塞进密钥本身', () => {
    const open = clone(jiancang);
    open.auth = { adapter: 'none' };
    const openResult = validateIntegrationSettings({ connectors: { jiancang: open } });
    expect(openResult.ok).toBe(false);
    if (!openResult.ok) expect(codesOf(openResult.issues)).toContain('AUTH');

    const leaked = clone(jiancang);
    leaked.auth.secretRefs.token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const leakedResult = validateIntegrationSettings({ connectors: { jiancang: leaked } });
    expect(leakedResult.ok).toBe(false);
    if (!leakedResult.ok) expect(codesOf(leakedResult.issues)).toContain('SECRET_REF');
  });

  it('自然键必须读外部主键，工具参数以外的字段写不进去', () => {
    const drifted = clone(jiancang);
    const orderNo = drifted.routes[0].mapping.fields.find((field: { to: string }) => field.to === 'orderNo');
    orderNo.from.path = 'other';
    const driftedResult = validateIntegrationSettings({ connectors: { jiancang: drifted } });
    expect(driftedResult.ok).toBe(false);
    if (!driftedResult.ok) expect(codesOf(driftedResult.issues)).toContain('IDEMPOTENCY');

    const extra = clone(jiancang);
    extra.routes[0].mapping.fields.push({ to: 'allocation', from: { op: 'const', value: 'fifo' } });
    const extraResult = validateIntegrationSettings({ connectors: { jiancang: extra } });
    expect(extraResult.ok).toBe(false);
    if (!extraResult.ok) expect(codesOf(extraResult.issues)).toContain('ALLOWLIST');
  });

  it('地址只收 http 和 https，拉取间隔有下限', () => {
    const ftp = clone(jiancang);
    ftp.transport.baseUrl = 'ftp://erp.jiancang.example';
    const ftpResult = validateIntegrationSettings({ connectors: { jiancang: ftp } });
    expect(ftpResult.ok).toBe(false);
    if (!ftpResult.ok) expect(codesOf(ftpResult.issues)).toContain('URL');

    const userinfo = clone(jiancang);
    userinfo.transport.baseUrl = 'https://user:pass@erp.jiancang.example';
    const userinfoResult = validateIntegrationSettings({ connectors: { jiancang: userinfo } });
    expect(userinfoResult.ok).toBe(false);
    if (!userinfoResult.ok) expect(codesOf(userinfoResult.issues)).toContain('URL');

    const fast = validateIntegrationSettings({ connectors: { jiancang }, pollIntervalSec: 5 });
    expect(fast.ok).toBe(false);
    if (!fast.ok) expect(codesOf(fast.issues)).toContain('RANGE');
  });

  it('同一类单据启用后只能有一个入站连接器', () => {
    const result = validateIntegrationSettings({
      connectors: { a: orderInbound('a'), b: orderInbound('b') },
      writers: { order: 'a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.issues)).toContain('WRITER');
  });

  it('同一个连接器可以同时接建单和状态', () => {
    const connector = orderInbound('jiancang');
    connector.direction = 'both';
    connector.routes.push({
      id: 'status-in',
      enabled: true,
      direction: 'in',
      inbound: { mode: 'webhook', itemsPath: '' },
      canonical: 'order.transition',
      idempotency: { externalIdPath: 'billNo' },
      mapping: {
        fields: [
          { to: 'orderNo', from: { op: 'path', path: 'billNo' } },
          { to: 'to', from: { op: 'enum', path: 'status', map: { SHIPPED: 'shipped' }, fallback: 'reject' } },
        ],
      },
    });
    const settings = accept({ connectors: { jiancang: connector }, writers: { order: 'jiancang' } });
    const mapped = applyMapping(routeNamed(settings, 'jiancang', 'status-in'), { billNo: 'SO1001', status: 'SHIPPED' }, codes);
    expect(mapped).toEqual({ ok: true, value: { orderNo: 'SO1001', to: 'shipped' } });
    const unknown = applyMapping(routeNamed(settings, 'jiancang', 'status-in'), { billNo: 'SO1001', status: 'HOLD' }, codes);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('MAP_ENUM');
  });

  it('出站事件和快照必须成对，连接器方向要罩得住路由', () => {
    const mismatched = clone(jiancang);
    mismatched.routes[1].canonical = 'sku.snapshot';
    const mismatchedResult = validateIntegrationSettings({ connectors: { jiancang: mismatched } });
    expect(mismatchedResult.ok).toBe(false);
    if (!mismatchedResult.ok) expect(codesOf(mismatchedResult.issues)).toContain('CANONICAL');

    const inboundOnly = orderInbound('only');
    inboundOnly.direction = 'outbound';
    const direction = validateIntegrationSettings({ connectors: { only: inboundOnly } });
    expect(direction.ok).toBe(false);
    if (!direction.ok) expect(codesOf(direction.issues)).toContain('DIRECTION');
  });

  it('拉取要有水位和端点', () => {
    const polled = clone(jiancang);
    polled.endpoints.push({ id: 'pull', method: 'GET', path: '/orders', shape: 'document' });
    polled.routes[0].endpointId = 'pull';
    polled.routes[0].inbound = {
      mode: 'poll',
      itemsPath: 'data.rows',
      cursor: { queryParam: 'updatedSince', from: 'iso8601' },
    };
    expect(accept({ connectors: { jiancang: polled } }).connectors.jiancang.routes[0]?.inbound?.mode).toBe('poll');

    delete polled.routes[0].inbound.cursor;
    const missingCursor = validateIntegrationSettings({ connectors: { jiancang: polled } });
    expect(missingCursor.ok).toBe(false);
  });
});

describe('映射', () => {
  function salesRoute(): Route {
    const enabled = clone(jiancang);
    enabled.enabled = true;
    return routeNamed(accept({ connectors: { jiancang: enabled }, writers: { order: 'jiancang' } }), 'jiancang', 'sales-in');
  }

  it('编码对不上、数量不是数字、主键缺失都会拒绝这一笔', () => {
    const route = salesRoute();
    const unknownPartner = applyMapping(route, { ...salesOrder, customerCode: 'NOPE' }, codes);
    expect(unknownPartner.ok).toBe(false);
    if (!unknownPartner.ok) expect(unknownPartner.code).toBe('MAP_CODE');

    const badQty = applyMapping(route, { ...salesOrder, lines: [{ itemCode: 'A1', qty: 'abc' }] }, codes);
    expect(badQty.ok).toBe(false);
    if (!badQty.ok) expect(badQty.code).toBe('MAP_NUMBER');

    const missingKey = applyMapping(route, { customerCode: 'C08', lines: salesOrder.lines }, codes);
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.code).toBe('MAP_MISSING');
  });

  it('效期、模板和反向编码按算子转换', () => {
    const dated = clone(jiancang);
    dated.routes[0].mapping.lines.item.push({
      to: 'batchExpiryDate',
      from: { op: 'date', path: 'exp', from: 'yyyyMMdd', to: 'date' },
    });
    dated.routes[1].mapping.fields.push(
      { to: 'title', from: { op: 'template', template: '发货 {orderNo}' } },
      { to: 'customerCode', from: { op: 'code', entity: 'partner', path: 'partnerCode' } },
    );
    const settings = accept({ connectors: { jiancang: dated } });
    const inbound = applyMapping(
      routeNamed(settings, 'jiancang', 'sales-in'),
      { ...salesOrder, lines: [{ itemCode: 'A1', qty: '2', exp: '20261231' }] },
      codes,
    );
    expect(inbound.ok).toBe(true);
    if (inbound.ok) {
      expect(inbound.value.lines).toEqual([
        { skuCode: 'SKU-00001', quantity: 2, batchExpiryDate: '2026-12-31', locationCode: 'DEFAULT' },
      ]);
    }
    const outbound = applyMapping(routeNamed(settings, 'jiancang', 'ship-out'), shippedSnapshot, codes);
    expect(outbound).toEqual({
      ok: true,
      value: { billNo: 'SO1001', status: 'SHIPPED', title: '发货 SO1001', customerCode: 'C08' },
    });
  });

  it('安全库存只收整数', () => {
    const connector = {
      id: 'sku-src',
      name: '商品',
      enabled: false,
      direction: 'inbound',
      transport: { kind: 'http', baseUrl: 'https://example.com' },
      auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
      endpoints: [],
      routes: [
        {
          id: 'sku-in',
          enabled: true,
          direction: 'in',
          inbound: { mode: 'webhook', itemsPath: '' },
          canonical: 'sku.create',
          idempotency: { externalIdPath: 'code' },
          mapping: {
            fields: [
              { to: 'skuCode', from: { op: 'path', path: 'code' } },
              { to: 'name', from: { op: 'path', path: 'name' } },
              { to: 'reorderPoint', from: { op: 'number', path: 'safe' } },
            ],
          },
        },
      ],
    };
    const settings = accept({ connectors: { 'sku-src': connector } });
    const mapped = applyMapping(routeNamed(settings, 'sku-src', 'sku-in'), { code: 'A1', name: '苹果', safe: 1.5 }, codes);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.code).toBe('MAP_NUMBER');
  });
});
