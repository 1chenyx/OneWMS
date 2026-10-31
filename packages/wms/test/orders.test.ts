import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  InvalidTransitionError,
  OrderNotFoundError,
  OrderStateConflictError,
  SkuNotFoundError,
} from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
});

afterEach(() => {
  core.close();
});

describe('单据：创建', () => {
  it('创建入库单（自动单号）→ state=created + lines 落投影', async () => {
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [
        { skuCode: 'A-1', quantity: 100 },
        { skuCode: 'B-2', quantity: 50 },
      ],
      note: '首单',
    })) as { orderId: string; orderNo: string };

    expect(r.orderNo).toMatch(/^IN-\d{8}-/);
    const order = ws.orders.byNo(r.orderNo)!;
    expect(order.state).toBe('created');
    expect(order.direction).toBe('in');
    expect(order.note).toBe('首单');
    expect(ws.orders.lines(order.id)).toEqual([
      { skuId: ws.skus.byCode('A-1')!.id, quantity: 100 },
      { skuId: ws.skus.byCode('B-2')!.id, quantity: 50 },
    ]);
  });

  it('出库单自动单号 OUT- 前缀；按方向列出', async () => {
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    expect(r.orderNo).toMatch(/^OUT-/);
    expect(ws.orders.list('out')).toHaveLength(1);
    expect(ws.orders.list('in')).toHaveLength(0);
  });

  it('引用不存在的 SKU → 拒绝且不落事件', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'ghost', quantity: 1 }],
      }),
    ).rejects.toThrow(SkuNotFoundError);
    expect(ws.orders.list()).toHaveLength(0);
  });

  it('明细行校验：空数组 / 非正整数数量 → 拒绝', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', { direction: 'in', lines: [] }),
    ).rejects.toThrow(/lines 不能为空/);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 0 }],
      }),
    ).rejects.toThrow(/正整数/);
  });

  it('手动单号重复 → OrderAlreadyExists', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-1',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        orderNo: 'IN-1',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/单据号已存在/);
  });
});

describe('单据：状态机', () => {
  async function createIn(direction: 'in' | 'out' = 'in'): Promise<string> {
    const r = (await ws.tools.invoke('wms.order.create', {
      direction,
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })) as { orderNo: string };
    return r.orderNo;
  }

  it('入库单全程 created → received → done，每步落 state_changed 事件', async () => {
    const no = await createIn();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    expect(ws.orders.byNo(no)!.state).toBe('received');
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' });
    expect(ws.orders.byNo(no)!.state).toBe('done');

    const changes: string[] = [];
    ws.events.forEach((e) => {
      if (e.type === 'wms.order.state_changed') {
        changes.push(`${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`);
      }
    });
    expect(changes).toEqual(['created→received', 'received→done']);
  });

  it('跳步非法：created → done 直接拒绝（InvalidTransitionError，不落事件）', async () => {
    const baseline = ws.events.count(); // 构造期种子事件之后
    const no = await createIn();
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' }),
    ).rejects.toThrow(InvalidTransitionError);
    expect(ws.orders.byNo(no)!.state).toBe('created');
    expect(ws.events.count()).toBe(baseline + 1); // 1 单据创建（2 SKU 在 beforeEach 已计入 baseline），无状态事件
  });

  it('入库单 received 后不可取消；出库单 picking 可取消', async () => {
    const inNo = await createIn('in');
    await ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'received' });
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'canceled' }),
    ).rejects.toThrow(InvalidTransitionError);

    const outNo = await createIn('out');
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'canceled' });
    expect(ws.orders.byNo(outNo)!.state).toBe('canceled');
  });

  it('不存在的单据 → OrderNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: 'ghost', to: 'done' }),
    ).rejects.toThrow(OrderNotFoundError);
  });

  it('并发状态转移：第二条事件的 from 与当前态不符 → OrderStateConflictError（v1 停下等人）', async () => {
    const no = await createIn();
    const orderId = ws.orders.byNo(no)!.id;
    const mk = (eventId: string, actor: string, to: string) => ({
      eventId,
      workspaceId: 'ws-test',
      actor,
      lamport: 100,
      seq: 1,
      type: 'wms.order.state_changed',
      payload: { orderId, orderNo: no, direction: 'in', from: 'created', to },
      createdAt: new Date().toISOString(),
    });
    // 两个节点并发：一个 received，一个 canceled——同 from=created。
    // 同 lamport 按 actor 字典序：node-peer-a 先应用（成功），node-peer-b 后到（冲突）
    ws.events.ingest([
      mk('33333333-3333-4333-8333-333333333331', 'node-peer-a', 'received'),
      mk('33333333-3333-4333-8333-333333333332', 'node-peer-b', 'canceled'),
    ]);
    // 全序应用：第一条 created→received 成功；第二条 from=created 但实际已 received → 冲突
    expect(() => ws.sync()).toThrow(OrderStateConflictError);
  });
});
