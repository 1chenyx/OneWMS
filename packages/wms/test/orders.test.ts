import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  InvalidTransitionError,
  OrderNotFoundError,
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
      { skuId: ws.skus.byCode('A-1')!.id, locationId: 'DEFAULT', batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 100, fulfilledQty: null },
      { skuId: ws.skus.byCode('B-2')!.id, locationId: 'DEFAULT', batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 50, fulfilledQty: null },
    ]);
  });

  it('出库单自动单号 OUT- 前缀；按方向列出', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1 });
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    expect(r.orderNo).toMatch(/^OUT-/);
    expect(ws.orders.list('out')).toHaveLength(1);
    expect(ws.orders.list('in')).toHaveLength(0);
  });

  it('出库所选桶余量不足 → 建单拒绝且不落单', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号位' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2, locationCode: 'A-01', batchNo: 'B1' });
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 3, locationCode: 'A-01', batchNo: 'B1' }],
      }),
    ).rejects.toThrow(/库存不足/);
    expect(ws.orders.list('out')).toHaveLength(0);
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

  it('明细行校验：空数组 / 非正数量 → 拒绝；小数数量 → 放行', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', { direction: 'in', lines: [] }),
    ).rejects.toThrow(/lines 不能为空/);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 0 }],
      }),
    ).rejects.toThrow(/正数/);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: -0.5 }],
      }),
    ).rejects.toThrow(/正数/);
    // 小数数量（散装/称重）：建单 → 收货 → 库存 0.5
    const r = await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 0.5 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, 'DEFAULT', 'DEFAULT')).toBe(0.5);
  });

  it('同单同 SKU 重复行 → 拒绝且不落事件（M9：行唯一约束的命令侧守卫）', async () => {
    const baseline = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [
          { skuCode: 'A-1', quantity: 30 },
          { skuCode: 'A-1', quantity: 70 },
        ],
      }),
    ).rejects.toThrow(/重复/);
    expect(ws.orders.list()).toHaveLength(0);
    expect(ws.events.count()).toBe(baseline);
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

  it('入库单全程 created → received → putaway → done，上架打开时不能跳过', async () => {
    const no = await createIn();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    expect(ws.orders.byNo(no)!.state).toBe('received');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' })).rejects.toThrow(
      InvalidTransitionError,
    );
    await ws.tools.invoke('wms.order.putaway', { orderNo: no });
    expect(ws.orders.byNo(no)!.state).toBe('putaway');
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' });
    expect(ws.orders.byNo(no)!.state).toBe('done');

    const changes: string[] = [];
    ws.events.forEach((e) => {
      if (e.type === 'wms.order.state_changed') {
        changes.push(`${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`);
      }
    });
    expect(changes).toEqual(['created→received', 'received→putaway', 'putaway→done']);
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

  it('停用冲销模块后，入库单 received 不可取消；出库单 picking 仍可取消', async () => {
    const { proposalId } = ws.profile.propose(
      'user:test',
      [{ op: 'replace', path: '/modules/module.reversal/enabled', value: false }],
      '关闭冲销',
    );
    ws.profile.confirm(proposalId, 'user:test');
    const inNo = await createIn('in');
    await ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'received' });
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'canceled' }),
    ).rejects.toThrow(InvalidTransitionError);

    const outNo = await createIn('out');
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 }); // M9：出库 picking 前需余量
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'canceled' });
    expect(ws.orders.byNo(outNo)!.state).toBe('canceled');
  });

  it('不存在的单据 → OrderNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: 'ghost', to: 'done' }),
    ).rejects.toThrow(OrderNotFoundError);
  });

  it('并发状态转移：后到事件进冲突队列，单据停在先到状态，追账不中断', async () => {
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
    // 全序应用：第一条 created→received 成功；第二条 from=created 但实际已 received → 入队
    expect(() => ws.sync()).not.toThrow();
    expect(ws.orders.byNo(no)!.state).toBe('received');
    const open = ws.orders.listConflicts('open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ orderNo: no, fromState: 'created', toState: 'canceled', actualState: 'received' });
  });
});

/** 让相邻事件的 updated_at 落在不同毫秒 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('单据：界面清单按更新时间倒序', () => {
  it('入库、出库和已收货（上架清单）都是最近更新的在前，分页与全量同一顺序', async () => {
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-A',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await tick();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'IN-Z',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2 });
    await tick();
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-A',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await tick();
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      orderNo: 'OUT-Z',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });

    // 单号序会是 A 在前；更新时间倒序是后建的 Z 在前
    expect(ws.orders.list('in').map((o) => o.orderNo)).toEqual(['IN-Z', 'IN-A']);
    expect(ws.orders.list('out').map((o) => o.orderNo)).toEqual(['OUT-Z', 'OUT-A']);

    await tick();
    await ws.tools.invoke('wms.order.revise', { orderNo: 'IN-A', note: '补记' });
    await tick();
    await ws.tools.invoke('wms.order.revise', { orderNo: 'OUT-A', note: '补记' });
    expect(ws.orders.list('in').map((o) => o.orderNo)).toEqual(['IN-A', 'IN-Z']);
    expect(ws.orders.list('out').map((o) => o.orderNo)).toEqual(['OUT-A', 'OUT-Z']);

    await tick();
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-Z', to: 'received' });
    await tick();
    await ws.tools.invoke('wms.order.transition', { orderNo: 'IN-A', to: 'received' });
    // 上架页用的就是这张入库清单里 state=received 的单，顺序跟着更新时间
    expect(
      ws.orders.list('in').filter((o) => o.state === 'received').map((o) => o.orderNo),
    ).toEqual(['IN-A', 'IN-Z']);

    const first = ws.orders.listPageByNo({ direction: 'in', limit: 1, offset: 0 });
    const second = ws.orders.listPageByNo({ direction: 'in', limit: 1, offset: 1 });
    expect(first.total).toBe(2);
    expect(first.rows.map((o) => o.orderNo)).toEqual(['IN-A']);
    expect(second.rows.map((o) => o.orderNo)).toEqual(['IN-Z']);
  });
});
