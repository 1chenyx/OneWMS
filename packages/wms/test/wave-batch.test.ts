import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  InsufficientStockError,
  WaveBatchPickError,
  WaveBatchRequiredError,
  WaveDisabledError,
  WaveMembersMovedError,
  WaveOrderTakenError,
  WmsDomain,
  getWave,
} from '../src/index.js';

/**
 * 波次把多张已创建的出库单收成一波。
 * 组波给波次号并把单推进到已组波，按库位加总。
 * 按这波拣货生成一张拣货单；合计超过库存时整波不动。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-wave');
  setModule('module.qc', false);
  setModule('module.wave', true);
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号架' });
});

afterEach(() => {
  core.close();
});

function setModule(id: string, enabled: boolean): void {
  const { proposalId } = ws.profile.propose(
    'user:tester',
    [{ op: 'replace', path: `/modules/${id}/enabled`, value: enabled }],
    '测试开关',
  );
  ws.profile.confirm(proposalId, 'user:tester');
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

async function stock(skuCode: string, qty: number, locationCode: string): Promise<void> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode, quantity: qty, locationCode }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'received' });
  await ws.tools.invoke('wms.order.putaway', { orderNo: created.orderNo });
  await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'done' });
}

async function outbound(skuCode: string, qty: number, locationCode: string): Promise<string> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines: [{ skuCode, quantity: qty, locationCode }],
  })) as { orderNo: string };
  return created.orderNo;
}

describe('组波', () => {
  it('两张单合成一波，按库位把数量加总，单据进入已组波', async () => {
    await stock('A-1', 20, 'A-01');
    await stock('B-2', 10, 'B-02');
    const first = await outbound('A-1', 4, 'A-01');
    const second = await outbound('A-1', 6, 'A-01');
    const third = await outbound('B-2', 2, 'B-02');
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: first, to: 'waved' })).rejects.toBeInstanceOf(
      WaveBatchRequiredError,
    );

    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [second, first, third] })) as {
      waveNo: string;
    };
    expect(created.waveNo).toMatch(/^WV-/);
    expect(ws.orders.byNo(first)!.state).toBe('waved');
    expect(ws.orders.byNo(second)!.state).toBe('waved');
    expect(ws.inventory.totalOf(ws.skus.byCode('A-1')!.id)).toBe(20);

    const wave = getWave(ws, created.waveNo)!;
    expect(wave.walk.map((line) => [line.locationCode, line.skuCode, line.quantity])).toEqual([
      ['A-01', 'A-1', 10],
      ['B-02', 'B-2', 2],
    ]);
    expect(wave.walk[0]!.orders.map((part) => part.orderNo).sort()).toEqual([first, second].sort());
  });

  it('取消波次后，出库单回到已创建，可以重新组', async () => {
    await stock('A-1', 20, 'A-01');
    const first = await outbound('A-1', 2, 'A-01');
    const second = await outbound('A-1', 3, 'A-01');
    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [first, second] })) as { waveNo: string };
    await ws.tools.invoke('wms.wave.cancel', { waveNo: created.waveNo });
    expect(ws.waves.byNo(created.waveNo)!.state).toBe('canceled');
    expect(ws.orders.byNo(first)!.state).toBe('created');
    expect(ws.orders.byNo(second)!.state).toBe('created');
    const again = (await ws.tools.invoke('wms.wave.create', { orderNos: [first] })) as { waveNo: string };
    expect(again.waveNo).not.toBe(created.waveNo);
    expect(ws.orders.byNo(first)!.state).toBe('waved');
  });

  it('已经在波次里的单不能再组进另一波', async () => {
    await stock('A-1', 20, 'A-01');
    const first = await outbound('A-1', 2, 'A-01');
    const second = await outbound('A-1', 2, 'A-01');
    await ws.tools.invoke('wms.wave.create', { orderNos: [first] });
    await expect(ws.tools.invoke('wms.wave.create', { orderNos: [first, second] })).rejects.toBeInstanceOf(
      WaveOrderTakenError,
    );
    expect(ws.orders.byNo(second)!.state).toBe('created');
  });

  it('波次关掉后不能再组新波', async () => {
    await stock('A-1', 10, 'A-01');
    const orderNo = await outbound('A-1', 1, 'A-01');
    setModule('module.wave', false);
    await expect(ws.tools.invoke('wms.wave.create', { orderNos: [orderNo] })).rejects.toBeInstanceOf(WaveDisabledError);
  });
});

describe('按波次拣货', () => {
  it('整波生成一张拣货单，两张单都进入拣货中', async () => {
    await stock('A-1', 20, 'A-01');
    const first = await outbound('A-1', 4, 'A-01');
    const second = await outbound('A-1', 5, 'A-01');
    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [first, second] })) as { waveNo: string };
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: first, to: 'picking' })).rejects.toBeInstanceOf(
      WaveBatchPickError,
    );
    const released = (await ws.tools.invoke('wms.wave.pick', { waveNo: created.waveNo })) as { pickingNo: string };
    expect(ws.orders.byNo(first)!.state).toBe('picking');
    expect(ws.orders.byNo(second)!.state).toBe('picking');
    expect(ws.waves.byNo(created.waveNo)!.state).toBe('picking');
    expect(ws.waves.byNo(created.waveNo)!.pickingNo).toBe(released.pickingNo);
    const lines = ws.pickings.lines(ws.pickings.byNo(released.pickingNo)!.id);
    expect(lines.map((line) => line.orderNo).sort()).toEqual([first, second].sort());
    expect(ws.inventory.listReservations(ws.orders.byNo(first)!.id).reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
    expect(ws.inventory.totalOf(ws.skus.byCode('A-1')!.id)).toBe(20);
  });

  it('两张单加起来超过库存时，整波留在已组波，不生成拣货单', async () => {
    await stock('A-1', 10, 'A-01');
    const first = await outbound('A-1', 6, 'A-01');
    const second = await outbound('A-1', 6, 'A-01');
    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [first, second] })) as { waveNo: string };
    const before = countEvents();
    await expect(ws.tools.invoke('wms.wave.pick', { waveNo: created.waveNo })).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(countEvents()).toBe(before);
    expect(ws.orders.byNo(first)!.state).toBe('waved');
    expect(ws.orders.byNo(second)!.state).toBe('waved');
    expect(ws.waves.byNo(created.waveNo)!.state).toBe('open');
    expect(ws.pickings.list()).toHaveLength(0);
  });

  it('有一张单已经取消时，不能整波拣货', async () => {
    await stock('A-1', 20, 'A-01');
    const first = await outbound('A-1', 2, 'A-01');
    const second = await outbound('A-1', 2, 'A-01');
    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [first, second] })) as { waveNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: second, to: 'canceled' });
    await expect(ws.tools.invoke('wms.wave.pick', { waveNo: created.waveNo })).rejects.toBeInstanceOf(
      WaveMembersMovedError,
    );
    expect(ws.orders.byNo(first)!.state).toBe('waved');
  });

  it('replay 后波次和已组波状态还在', async () => {
    await stock('A-1', 10, 'A-01');
    const orderNo = await outbound('A-1', 3, 'A-01');
    const created = (await ws.tools.invoke('wms.wave.create', { orderNos: [orderNo] })) as { waveNo: string };
    ws.replay();
    expect(ws.waves.byNo(created.waveNo)!.state).toBe('open');
    expect(ws.orders.byNo(orderNo)!.state).toBe('waved');
    expect(getWave(ws, created.waveNo)!.walk).toEqual([
      expect.objectContaining({ locationCode: 'A-01', skuCode: 'A-1', quantity: 3 }),
    ]);
  });
});
