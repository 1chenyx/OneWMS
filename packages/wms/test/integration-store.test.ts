import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';
import { IntegrationQueue, nextAttemptAt } from '../src/integration/queue.js';
import { IntegrationSecretStore } from '../src/integration/secrets.js';
import { IntegrationStoreError } from '../src/integration/store-error.js';

/**
 * 密钥库和收发队列写在本机表里。
 * 重放业务账本不会清掉它们，别的工作区也看不见。
 */

let core: OneCore;

beforeEach(() => {
  core = OneCore.open(':memory:');
  WmsDomain.attach(core);
});

afterEach(() => {
  core.close();
});

function open(workspaceId: string) {
  const db = core.exposeDb();
  return {
    secrets: new IntegrationSecretStore(db, workspaceId),
    queue: new IntegrationQueue(db, workspaceId),
  };
}

describe('密钥库', () => {
  it('按连接器和引用名存取，列表不带值，覆盖后来的为准', () => {
    const { secrets } = open('ws-a');
    secrets.put('jiancang', 'token', 'secret-1');
    secrets.put('jiancang', 'key', 'k');
    secrets.put('jiancang', 'token', 'secret-2');
    expect(secrets.get('jiancang', 'token')).toBe('secret-2');
    expect(secrets.names('jiancang')).toEqual(['key', 'token']);
    expect(secrets.delete('jiancang', 'key')).toBe(true);
    expect(secrets.delete('jiancang', 'key')).toBe(false);
    expect(secrets.names('jiancang')).toEqual(['token']);
  });

  it('别的工作区看不见，空密钥和坏引用名写不进去', () => {
    const here = open('ws-a').secrets;
    const there = open('ws-b').secrets;
    here.put('jiancang', 'token', 'secret-1');
    expect(there.get('jiancang', 'token')).toBeUndefined();
    expect(there.names('jiancang')).toEqual([]);
    expect(() => here.put('jiancang', 'token', '   ')).toThrow(IntegrationStoreError);
    expect(here.get('jiancang', 'token')).toBe('secret-1');
    expect(() => here.put('jiancang', 'Token', 'x')).toThrow(IntegrationStoreError);
    expect(() => here.put('JianCang', 'token', 'x')).toThrow(IntegrationStoreError);
  });
});

describe('收件', () => {
  const now = '2026-11-12T00:00:00.000Z';

  it('接受过的外部主键再来是重复，拒绝不挡住后来的接受', () => {
    const { queue } = open('ws-a');
    const first = queue.recordInbox({
      connectorId: 'jiancang',
      routeId: 'sales-in',
      externalId: 'SO1001',
      raw: { billNo: 'SO1001' },
      outcome: 'accepted',
      internalRef: 'SO1001',
      now,
    });
    expect(first).toMatchObject({ disposition: 'accepted', internalRef: 'SO1001' });
    const again = queue.recordInbox({
      connectorId: 'jiancang',
      routeId: 'sales-in',
      externalId: 'SO1001',
      raw: { billNo: 'SO1001', changed: true },
      outcome: 'accepted',
      internalRef: 'SO9999',
      now: '2026-11-12T00:00:01.000Z',
    });
    expect(again).toEqual({ disposition: 'duplicate', id: first.disposition === 'accepted' ? first.id : '', internalRef: 'SO1001' });

    const rejected = queue.recordInbox({
      connectorId: 'jiancang',
      routeId: 'sales-in',
      externalId: 'SO1002',
      raw: { billNo: 'SO1002' },
      outcome: 'rejected',
      error: '编码表没有这个客户',
      now: '2026-11-12T00:00:02.000Z',
    });
    expect(rejected.disposition).toBe('rejected');
    expect(queue.hasLink('jiancang', 'SO1002')).toBe(false);
    const accepted = queue.recordInbox({
      connectorId: 'jiancang',
      routeId: 'sales-in',
      externalId: 'SO1002',
      raw: { billNo: 'SO1002' },
      outcome: 'accepted',
      internalRef: 'IN-9',
      now: '2026-11-12T00:00:03.000Z',
    });
    expect(accepted).toMatchObject({ disposition: 'accepted', internalRef: 'IN-9' });
    expect(queue.hasLink('jiancang', 'IN-9')).toBe(true);
    expect(queue.externalIdFor('jiancang', 'IN-9')).toBe('SO1002');
    expect(queue.hasLink('other', 'IN-9')).toBe(false);

    const listed = queue.listInbox('jiancang');
    expect(listed.map((row) => row.status)).toEqual(['accepted', 'rejected', 'accepted']);
    expect(listed[0]?.raw).toEqual({ billNo: 'SO1002' });
    expect(() =>
      queue.recordInbox({
        connectorId: 'jiancang',
        routeId: 'sales-in',
        externalId: 'SO1003',
        raw: {},
        outcome: 'rejected',
        now,
      }),
    ).toThrow(IntegrationStoreError);
  });
});

describe('出站队列', () => {
  const t0 = '2026-11-12T00:00:00.000Z';

  it('同一事件只入队一次，失败按次数推迟，到次数进死信', () => {
    const { queue } = open('ws-a');
    const first = queue.enqueue({
      connectorId: 'jiancang',
      routeId: 'ship-out',
      eventId: 'evt-1',
      body: { billNo: 'SO1001', status: 'SHIPPED' },
      now: t0,
    });
    expect(first.created).toBe(true);
    expect(queue.due(t0).map((row) => row.id)).toEqual([first.row.id]);

    const again = queue.enqueue({
      connectorId: 'jiancang',
      routeId: 'ship-out',
      eventId: 'evt-1',
      body: { billNo: 'OTHER' },
      now: t0,
    });
    expect(again).toMatchObject({ created: false, row: { id: first.row.id, body: { billNo: 'SO1001', status: 'SHIPPED' } } });

    const otherRoute = queue.enqueue({
      connectorId: 'jiancang',
      routeId: 'stock-out',
      eventId: 'evt-1',
      body: { sku: 'A1' },
      now: t0,
    });
    expect(otherRoute.created).toBe(true);

    const failed = queue.markFailed(first.row.id, '超时', { maxAttempts: 3, now: t0 });
    expect(failed.changed).toBe(true);
    expect(failed.row).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: '2026-11-12T00:00:01.000Z',
      lastError: '超时',
    });
    expect(queue.due(t0).map((row) => row.id)).toEqual([otherRoute.row.id]);
    expect(queue.due('2026-11-12T00:00:01.000Z').map((row) => row.eventId)).toEqual(['evt-1', 'evt-1']);

    queue.markFailed(first.row.id, '超时', { maxAttempts: 3, now: '2026-11-12T00:00:01.000Z' });
    const dead = queue.markFailed(first.row.id, '还是超时', { maxAttempts: 3, now: '2026-11-12T00:00:03.000Z' });
    expect(dead.row.status).toBe('dead');
    expect(dead.row.attempts).toBe(3);
    expect(queue.due('2099-01-01T00:00:00.000Z').map((row) => row.id)).toEqual([otherRoute.row.id]);
    expect(queue.markSent(first.row.id, t0)).toMatchObject({ changed: false, row: { status: 'dead' } });
    expect(queue.markFailed(first.row.id, '再来', { maxAttempts: 3, now: t0 }).changed).toBe(false);
  });

  it('发送之后不再重试', () => {
    const { queue } = open('ws-a');
    const queued = queue.enqueue({
      connectorId: 'jiancang',
      routeId: 'ship-out',
      eventId: 'evt-2',
      body: { ok: true },
      now: t0,
    });
    const sent = queue.markSent(queued.row.id, t0);
    expect(sent).toMatchObject({ changed: true, row: { status: 'sent', lastError: null } });
    expect(queue.due('2099-01-01T00:00:00.000Z')).toEqual([]);
    expect(queue.markFailed(queued.row.id, '迟到的失败', { maxAttempts: 8, now: t0 })).toMatchObject({
      changed: false,
      row: { status: 'sent' },
    });
  });

  it('重试间隔从 1 秒翻倍，最长 1 小时', () => {
    expect(nextAttemptAt(t0, 1)).toBe('2026-11-12T00:00:01.000Z');
    expect(nextAttemptAt(t0, 2)).toBe('2026-11-12T00:00:02.000Z');
    expect(nextAttemptAt(t0, 13)).toBe('2026-11-12T01:00:00.000Z');
    expect(() => nextAttemptAt('不是时间', 1)).toThrow(IntegrationStoreError);
  });
});

describe('重放', () => {
  it('重放业务账本留下密钥、收件和出站记录', () => {
    const ws = WmsDomain.attach(core).workspace('ws-a');
    const { secrets, queue } = open('ws-a');
    secrets.put('jiancang', 'token', 'secret-1');
    queue.recordInbox({
      connectorId: 'jiancang',
      routeId: 'sales-in',
      externalId: 'SO1001',
      raw: { billNo: 'SO1001' },
      outcome: 'accepted',
      internalRef: 'SO1001',
      now: '2026-11-12T00:00:00.000Z',
    });
    queue.enqueue({
      connectorId: 'jiancang',
      routeId: 'ship-out',
      eventId: 'evt-1',
      body: { billNo: 'SO1001' },
      now: '2026-11-12T00:00:00.000Z',
    });
    ws.replay();
    expect(secrets.get('jiancang', 'token')).toBe('secret-1');
    expect(queue.hasLink('jiancang', 'SO1001')).toBe(true);
    expect(queue.due('2026-11-12T00:00:00.000Z')).toHaveLength(1);
  });
});
