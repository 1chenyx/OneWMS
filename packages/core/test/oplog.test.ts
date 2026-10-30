import { describe, it, expect, beforeEach } from 'vitest';
import { OneCore } from '../src/index.js';
import { EventError } from '../src/index.js';

let core: OneCore;
let ws: ReturnType<OneCore['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = core.workspace('ws-test');
});

describe('oplog：事件信封与账本', () => {
  it('append 分配 uuid / 递增 seq 与 lamport / 记录 actor 与 workspace', () => {
    const e1 = ws.events.append('wms.sku.created', { skuCode: 'A-1' });
    const e2 = ws.events.append('wms.inventory.adjusted', { delta: 5 });

    expect(e1.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e2.lamport).toBeGreaterThan(e1.lamport);
    expect(e1.workspaceId).toBe('ws-test');
    expect(e1.actor).toBe(core.nodeId);
    expect(e1.payload).toEqual({ skuCode: 'A-1' });
    expect(e1.createdAt).toBeTruthy();
  });

  it('事件类型必须带命名空间', () => {
    expect(() => ws.events.append('no-namespace', {})).toThrow(EventError);
  });

  it('工作区隔离：事件互不可见', () => {
    const other = core.workspace('ws-other');
    ws.events.append('wms.sku.created', {});
    other.events.append('wms.sku.created', {});

    expect(ws.events.count()).toBe(1);
    expect(other.events.count()).toBe(1);
    expect(ws.events.watermarks()[core.nodeId].seq).toBe(1);
  });

  it('byActor 分通道拉取 + 水位', () => {
    ws.events.append('wms.a.created', {});
    ws.events.append('wms.b.adjusted', {});
    ws.events.append('wms.c.done', {});

    const afterFirst = ws.events.byActor(core.nodeId, 1);
    expect(afterFirst.map((e) => e.type)).toEqual(['wms.b.adjusted', 'wms.c.done']);

    const marks = ws.events.watermarks();
    expect(marks[core.nodeId]).toEqual({ seq: 3, lamport: 3 });
  });
});

describe('oplog：摄入与全序', () => {
  it('ingest 幂等：重复 eventId 跳过', () => {
    const foreign = {
      eventId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'ws-test',
      actor: 'node-foreign',
      lamport: 10,
      seq: 1,
      type: 'wms.sku.created',
      payload: { skuCode: 'F-1' },
      createdAt: new Date().toISOString(),
    };

    const first = ws.events.ingest([foreign]);
    const second = ws.events.ingest([foreign]);
    expect(first).toEqual({ accepted: 1, skipped: 0 });
    expect(second).toEqual({ accepted: 0, skipped: 1 });
    expect(ws.events.count()).toBe(1);
  });

  it('全序遍历恒为 (lamport, actor)——本地与远端混合', () => {
    // 本地 lamport 1..3
    ws.events.append('wms.local.one', {});
    ws.events.append('wms.local.two', {});
    ws.events.append('wms.local.three', {});

    // 摄入远端：lamport 2（插进本地 1 和 3 之间）。
    // actor 用 node-zzz：本地 nodeId 是 node-{hex}，'z' 恒大于任何 hex 字符，
    // 同 lamport 2 的字典序裁决因此确定（nodeId 随机，若用 node-aaa 会 flaky）。
    ws.events.ingest([
      {
        eventId: '22222222-2222-4222-8222-222222222222',
        workspaceId: 'ws-test',
        actor: 'node-zzz',
        lamport: 2,
        seq: 99,
        type: 'wms.remote.mid',
        payload: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    // 下一条本地事件的 lamport 应越过远端视界（≥3 之后）
    const next = ws.events.append('wms.local.four', {});
    expect(next.lamport).toBeGreaterThanOrEqual(4);

    const order: string[] = [];
    ws.events.forEach((e) => {
      order.push(`${e.lamport}:${e.actor}:${e.type}`);
    });
    // 全序：lamport 优先，同 lamport 按 actor 字典序
    expect(order.map((o) => o.split(':')[2])).toEqual([
      'wms.local.one',
      'wms.local.two',
      'wms.remote.mid',
      'wms.local.three',
      'wms.local.four',
    ]);
  });

  it('fromLamport 续传', () => {
    ws.events.append('wms.a.one', {});
    const e2 = ws.events.append('wms.b.two', {});
    ws.events.append('wms.c.three', {});

    const after: string[] = [];
    ws.events.forEach((e) => after.push(e.type), { fromLamport: e2.lamport });
    expect(after).toEqual(['wms.c.three']);
  });
});
