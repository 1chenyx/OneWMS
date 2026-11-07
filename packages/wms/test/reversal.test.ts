import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { InsufficientStockError, InvalidTransitionError, WmsDomain } from '../src/index.js';

/**
 * 可关闭的冲销模块 + 效应状态设置 + 冲突接受。
 * 停用 module.reversal 后，已收货/已发货不能再取消（回到旧流程）。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-rev');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

function applyPatch(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, 'reversal test');
  ws.profile.confirm(proposalId, 'user:tester');
}

async function inbound(qty = 10): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode: 'A-1', quantity: qty }],
  })) as { orderNo: string };
  return r.orderNo;
}

describe('module.reversal', () => {
  it('收货后取消扣回库存；停用后这条转移不可用', async () => {
    const no = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(10);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'canceled' });
    expect(ws.orders.byNo(no)!.state).toBe('canceled');
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);

    applyPatch([{ op: 'replace', path: '/modules/module.reversal/enabled', value: false }]);
    const no2 = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: no2, to: 'received' });
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no2, to: 'canceled' }),
    ).rejects.toThrow(InvalidTransitionError);
    expect(ws.orders.byNo(no2)!.state).toBe('received');
    expect(ws.inventory.quantityOf(sku.id)).toBe(10);
  });

  it('库存已被用掉时冲销拒绝，单据与事件数不变', async () => {
    const no = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -10 });
    const before = ws.events.count();
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'canceled' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.byNo(no)!.state).toBe('received');
  });

  it('已发货取消把库存加回', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 4 }],
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'shipped' });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(6);
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'canceled' });
    expect(ws.orders.byNo(r.orderNo)!.state).toBe('canceled');
    expect(ws.inventory.quantityOf(sku.id)).toBe(10);
  });

  it('卸载摘掉冲销边，基础收货转移还在', () => {
    ws.modules.uninstall('module.reversal');
    const inboundWf = ws.profile.getSnapshot().workflows.inbound;
    expect(inboundWf.transitions.some((t) => t.from === 'received' && t.to === 'canceled')).toBe(false);
    expect(inboundWf.transitions.some((t) => t.from === 'created' && t.to === 'received')).toBe(true);
    const outbound = ws.profile.getSnapshot().workflows.outbound;
    expect(outbound.transitions.some((t) => t.from === 'shipped' && t.to === 'canceled')).toBe(false);
    expect(outbound.transitions.some((t) => t.from === 'picking' && t.to === 'shipped')).toBe(true);
  });
});

describe('效应状态设置', () => {
  it('inboundIncreaseState 改为 done 后，收货不加库存，完成才加', async () => {
    applyPatch([
      { op: 'replace', path: '/modules/core.wms/settings/inboundIncreaseState', value: 'done' },
    ]);
    const no = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'done' });
    expect(ws.inventory.quantityOf(sku.id)).toBe(10);
  });
});

describe('状态冲突接受', () => {
  it('接受后按当前态走到目标并扣回库存，队列关闭', async () => {
    const no = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    const orderId = ws.orders.byNo(no)!.id;
    ws.events.ingest([
      {
        eventId: '44444444-4444-4444-8444-444444444444',
        workspaceId: 'ws-rev',
        actor: 'node-peer-z',
        lamport: 100000,
        seq: 1,
        type: 'wms.order.state_changed',
        payload: { orderId, orderNo: no, direction: 'in', from: 'created', to: 'canceled' },
        createdAt: new Date().toISOString(),
      },
    ]);
    ws.sync();
    const [conflict] = ws.orders.listConflicts('open');
    expect(conflict.toState).toBe('canceled');
    await ws.tools.invoke('wms.order.conflict.accept', { eventId: conflict.eventId });
    const sku = ws.skus.byCode('A-1')!;
    expect(ws.orders.byNo(no)!.state).toBe('canceled');
    expect(ws.inventory.quantityOf(sku.id)).toBe(0);
    expect(ws.orders.listConflicts('open')).toHaveLength(0);
    expect(ws.orders.conflictByEventId(conflict.eventId)?.status).toBe('accepted');
  });
});
