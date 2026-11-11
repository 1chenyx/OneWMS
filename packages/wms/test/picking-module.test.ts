import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore, type PatchOp } from '@one/core';
import { InsufficientStockError, InvalidTransitionError, PickingRequiredError, WmsDomain } from '../src/index.js';

/**
 * module.picking：出库拣货步骤可关。
 * 打开时是建单 → 拣货中 → 已拣货 → 发货。关掉后建单直接发货，发货时预检并扣减。
 * 已经在拣货中的单仍可发货或取消。直接发货不占用。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;
const tmpDirs: string[] = [];

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-picking-module');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10 });
});

afterEach(() => {
  core.close();
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function setEnabled(moduleId: string, enabled: boolean): void {
  const patch: PatchOp[] = [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value: enabled }];
  const { proposalId } = ws.profile.propose('user:tester', patch, `${moduleId} ${enabled}`);
  ws.profile.confirm(proposalId, 'user:tester');
}

async function outbound(quantity: number, orderNo?: string): Promise<string> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    ...(orderNo ? { orderNo } : {}),
    lines: [{ skuCode: 'A-1', quantity }],
  })) as { orderNo: string };
  return created.orderNo;
}

describe('module.picking', () => {
  it('默认仍要先拣货，不能从建单直接发货', async () => {
    const orderNo = await outbound(4, 'OUT-ON');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' })).rejects.toThrow(
      InvalidTransitionError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('picking');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' })).rejects.toThrow(
      PickingRequiredError,
    );
    expect(ws.orders.byNo(orderNo)!.state).toBe('picking');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'picked' })).rejects.toThrow(
      PickingRequiredError,
    );
  });

  it('关掉后建单直接发货并扣库存；余量不够则停在已创建', async () => {
    setEnabled('module.picking', false);
    const short = await outbound(4, 'OUT-SHIP');
    await ws.tools.invoke('wms.order.transition', { orderNo: short, to: 'shipped' });
    expect(ws.orders.byNo(short)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
    expect(ws.inventory.reservedOfSku(ws.skus.byCode('A-1')!.id)).toBe(0);

    const later = await outbound(4, 'OUT-LATER');
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -5 });
    const before = ws.events.count();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: later, to: 'shipped' })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(ws.events.count()).toBe(before);
    expect(ws.orders.byNo(later)!.state).toBe('created');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: later, to: 'picking' })).rejects.toThrow(
      InvalidTransitionError,
    );

    const beforeCreate = ws.events.count();
    await expect(outbound(8, 'OUT-OVER')).rejects.toThrow(InsufficientStockError);
    expect(ws.events.count()).toBe(beforeCreate);
    expect(ws.orders.byNo('OUT-OVER')).toBeUndefined();
  });

  it('关掉之后，已经在拣货中的单仍可发货或取消', async () => {
    const ship = await outbound(3, 'OUT-KEEP-SHIP');
    const cancel = await outbound(2, 'OUT-KEEP-CANCEL');
    await ws.tools.invoke('wms.order.transition', { orderNo: ship, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: cancel, to: 'picking' });
    setEnabled('module.picking', false);

    await ws.tools.invoke('wms.order.transition', { orderNo: ship, to: 'shipped' });
    await ws.tools.invoke('wms.order.transition', { orderNo: cancel, to: 'canceled' });
    expect(ws.orders.byNo(ship)!.state).toBe('shipped');
    expect(ws.orders.byNo(cancel)!.state).toBe('canceled');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(7);
    expect(ws.inventory.reservedOfSku(ws.skus.byCode('A-1')!.id)).toBe(0);
  });

  it('老库打开时补上拣货开关，再开一次不再改版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onewms-picking-gate-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = OneCore.open(dbPath);
    const ws1 = WmsDomain.attach(first).workspace('ws-old');
    const legacy = ws1.profile
      .getSnapshot()
      .workflows.outbound!.transitions.filter((edge) => !(edge.from === 'created' && edge.to === 'shipped'))
      .map((edge) => (edge.from === 'created' && edge.to === 'picking' ? { from: edge.from, to: edge.to } : edge));
    const proposed = ws1.profile.propose(
      'user:tester',
      [{ op: 'replace', path: '/workflows/outbound/transitions', value: legacy }],
      '模拟老库',
    );
    ws1.profile.confirm(proposed.proposalId, 'user:tester');
    const version = ws1.profile.getSnapshot().version;
    first.close();

    const second = OneCore.open(dbPath);
    const ws2 = WmsDomain.attach(second).workspace('ws-old');
    const edges = ws2.profile.getSnapshot().workflows.outbound!.transitions;
    expect(edges.find((edge) => edge.from === 'created' && edge.to === 'picking')?.when).toBe('module.picking.enabled');
    expect(edges.find((edge) => edge.from === 'created' && edge.to === 'shipped')?.when).toBe(
      '!module.picking.enabled',
    );
    expect(edges.find((edge) => edge.from === 'shipped' && edge.to === 'canceled')?.providedBy).toBe('module.reversal');
    expect(ws2.profile.getSnapshot().version).toBe(version + 1);
    second.close();

    const third = OneCore.open(dbPath);
    const ws3 = WmsDomain.attach(third).workspace('ws-old');
    expect(ws3.profile.getSnapshot().version).toBe(version + 1);
    third.close();
  });

  it('老库没有已拣货时，打开会补上，再开一次不再改版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onewms-picked-state-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = OneCore.open(dbPath);
    const ws1 = WmsDomain.attach(first).workspace('ws-old');
    const outbound = ws1.profile.getSnapshot().workflows.outbound!;
    const proposed = ws1.profile.propose(
      'user:tester',
      [
        { op: 'replace', path: '/workflows/outbound/states', value: outbound.states.filter((state) => state.id !== 'picked') },
        {
          op: 'replace',
          path: '/workflows/outbound/transitions',
          value: outbound.transitions.filter((edge) => edge.to !== 'picked' && edge.from !== 'picked'),
        },
      ],
      '模拟没有已拣货的老库',
    );
    ws1.profile.confirm(proposed.proposalId, 'user:tester');
    const version = ws1.profile.getSnapshot().version;
    first.close();

    const second = OneCore.open(dbPath);
    const ws2 = WmsDomain.attach(second).workspace('ws-old');
    const next = ws2.profile.getSnapshot().workflows.outbound!;
    expect(next.states.find((state) => state.id === 'picked')).toMatchObject({
      label: '已拣货',
      providedBy: 'module.picking',
    });
    expect(next.transitions).toEqual(
      expect.arrayContaining([
        {
          from: 'picking',
          to: 'picked',
          when: 'module.picking.enabled',
          effect: 'none',
          providedBy: 'module.picking',
        },
        { from: 'picked', to: 'shipped', effect: 'none', providedBy: 'module.picking' },
      ]),
    );
    expect(ws2.profile.getSnapshot().version).toBe(version + 1);
    second.close();

    const third = OneCore.open(dbPath);
    const ws3 = WmsDomain.attach(third).workspace('ws-old');
    expect(ws3.profile.getSnapshot().version).toBe(version + 1);
    third.close();
  });
});
