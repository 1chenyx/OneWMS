import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  getReturnable,
  InvalidTransitionError,
  LoadRequiredError,
  PackRequiredError,
  PickingRequiredError,
  QcRequiredError,
  ReturnNotPostedError,
  ReviewRequiredError,
  WaveBatchPickError,
  WaveRequiredError,
  WmsDomain,
} from '../src/index.js';
import { allowDirectShip } from './direct-ship.js';

/**
 * 质检、波次、复核、打包、装车默认开着，而且必做。
 * 这一组不走 test/setup 里的跳过。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-stage');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
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

async function inbound(qty = 10): Promise<string> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode: 'A-1', quantity: qty }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: created.orderNo, to: 'received' });
  return created.orderNo;
}

async function outbound(qty = 4): Promise<string> {
  const created = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines: [{ skuCode: 'A-1', quantity: qty }],
  })) as { orderNo: string };
  return created.orderNo;
}

describe('质检', () => {
  it('开着时收货后必须质检，才能上架和完成', async () => {
    const orderNo = await inbound();
    await expect(ws.tools.invoke('wms.order.putaway', { orderNo })).rejects.toBeInstanceOf(QcRequiredError);
    // 上架开着时 received→done 这条边不存在，先被流程挡住。
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    setModule('module.putaway', false);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })).rejects.toBeInstanceOf(
      QcRequiredError,
    );
    setModule('module.putaway', true);
    expect(ws.orders.byNo(orderNo)!.state).toBe('received');

    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('inspected');
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('done');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
  });

  it('关掉后收货可以直接上架', async () => {
    setModule('module.qc', false);
    const orderNo = await inbound();
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    expect(ws.orders.byNo(orderNo)!.state).toBe('putaway');
  });
});

describe('波次、复核、打包、装车', () => {
  it('拣货开着时按组波、拣货、复核、打包、装车再发货，发货不再扣', async () => {
    const orderNo = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });

    const outNo = await outbound();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' })).rejects.toBeInstanceOf(
      WaveRequiredError,
    );
    const wave = (await ws.tools.invoke('wms.wave.create', { orderNos: [outNo] })) as { waveNo: string };
    // 拣货开着时 waved→shipped 不存在。打包边还在，守卫会要求先拣货。
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' })).rejects.toBeInstanceOf(
      PickingRequiredError,
    );
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' })).rejects.toBeInstanceOf(
      WaveBatchPickError,
    );
    const picking = (await ws.tools.invoke('wms.wave.pick', { waveNo: wave.waveNo })) as { pickingNo: string };
    await ws.tools.invoke('wms.picking.pick', { pickingNo: picking.pickingNo, orderNo: outNo, skuCode: 'A-1', pickedQty: 4 });
    await ws.tools.invoke('wms.picking.close', { pickingNo: picking.pickingNo });
    expect(ws.orders.byNo(outNo)!.state).toBe('picked');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);

    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      ReviewRequiredError,
    );
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' })).rejects.toBeInstanceOf(
      ReviewRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      PackRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      LoadRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.orders.byNo(outNo)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });

  it('拣货关掉后，组波、复核、打包、装车仍要做，发货才扣库存', async () => {
    const orderNo = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    setModule('module.picking', false);

    const outNo = await outbound();
    await ws.tools.invoke('wms.wave.create', { orderNos: [outNo] });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      ReviewRequiredError,
    );
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' })).rejects.toBeInstanceOf(
      ReviewRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      PackRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });

  it('质检、波次、复核、打包、装车都关掉后，建单可以直接发货', async () => {
    const orderNo = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    allowDirectShip(ws);
    const outNo = await outbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.orders.byNo(outNo)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });

  it('已经进入该步的单，关掉模块后仍可继续', async () => {
    const inNo = await inbound();
    await ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'inspected' });
    setModule('module.qc', false);
    await ws.tools.invoke('wms.order.putaway', { orderNo: inNo });
    await ws.tools.invoke('wms.order.transition', { orderNo: inNo, to: 'done' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);

    const cancelNo = await outbound();
    await ws.tools.invoke('wms.wave.create', { orderNos: [cancelNo] });
    await ws.tools.invoke('wms.order.transition', { orderNo: cancelNo, to: 'canceled' });
    expect(ws.orders.byNo(cancelNo)!.state).toBe('canceled');

    const outNo = await outbound();
    await ws.tools.invoke('wms.wave.create', { orderNos: [outNo] });
    setModule('module.wave', false);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'picking' });
    const picking = (await ws.tools.invoke('wms.picking.create', { orderNos: [outNo] })) as { pickingNo: string };
    await ws.tools.invoke('wms.picking.pick', {
      pickingNo: picking.pickingNo,
      orderNo: outNo,
      skuCode: 'A-1',
      pickedQty: 4,
    });
    await ws.tools.invoke('wms.picking.close', { pickingNo: picking.pickingNo });
    expect(ws.orders.byNo(outNo)!.state).toBe('picked');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);

    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    setModule('module.review', false);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    setModule('module.pack', false);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    setModule('module.load', false);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.orders.byNo(outNo)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });
});

async function shelf(qty = 10): Promise<void> {
  const orderNo = await inbound(qty);
  await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
  await ws.tools.invoke('wms.order.putaway', { orderNo });
  await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
}

async function pickClose(qty = 4): Promise<string> {
  const outNo = await outbound(qty);
  const wave = (await ws.tools.invoke('wms.wave.create', { orderNos: [outNo] })) as { waveNo: string };
  const picking = (await ws.tools.invoke('wms.wave.pick', { waveNo: wave.waveNo })) as { pickingNo: string };
  await ws.tools.invoke('wms.picking.pick', {
    pickingNo: picking.pickingNo,
    orderNo: outNo,
    skuCode: 'A-1',
    pickedQty: qty,
  });
  await ws.tools.invoke('wms.picking.close', { pickingNo: picking.pickingNo });
  return outNo;
}

describe('单步关掉后的绕行', () => {
  it('质检开着、上架关掉：质检后直接完成，库存停在收货数', async () => {
    setModule('module.putaway', false);
    const orderNo = await inbound();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })).rejects.toBeInstanceOf(
      QcRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'inspected' });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('done');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
  });

  it('复核关掉：拣完直接打包，再装车发货，不再扣第二次', async () => {
    await shelf();
    const outNo = await pickClose();
    setModule('module.review', false);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      PackRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      LoadRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.orders.byNo(outNo)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });

  it('打包关掉：复核后直接装车，再发货', async () => {
    await shelf();
    const outNo = await pickClose();
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    setModule('module.pack', false);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' })).rejects.toBeInstanceOf(
      LoadRequiredError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });

  it('装车关掉：打包后直接发货', async () => {
    await shelf();
    const outNo = await pickClose();
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    setModule('module.load', false);
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(ws.orders.byNo(outNo)!.state).toBe('shipped');
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(6);
  });
});

describe('客退窗口', () => {
  it('已拣货可以退；复核、打包、装车还不能退；发货之后又能退', async () => {
    await shelf();
    const outNo = await pickClose();
    expect(getReturnable(ws, outNo).lines[0]).toMatchObject({ skuCode: 'A-1', remaining: 4 });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-PICKED',
      returnOf: outNo,
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-PICKED', to: 'received' });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-PICKED', to: 'inspected' });
    await ws.tools.invoke('wms.order.putaway', { orderNo: 'RT-PICKED' });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-PICKED', to: 'done' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(7);

    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'reviewed' });
    expect(() => getReturnable(ws, outNo)).toThrow(ReturnNotPostedError);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        returnOf: outNo,
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      }),
    ).rejects.toThrow(ReturnNotPostedError);

    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'packed' });
    expect(() => getReturnable(ws, outNo)).toThrow(ReturnNotPostedError);
    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'loaded' });
    expect(() => getReturnable(ws, outNo)).toThrow(ReturnNotPostedError);

    await ws.tools.invoke('wms.order.transition', { orderNo: outNo, to: 'shipped' });
    expect(getReturnable(ws, outNo).lines[0]!.remaining).toBe(3);
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      orderNo: 'RT-SHIP',
      returnOf: outNo,
      lines: [{ skuCode: 'A-1', quantity: 3 }],
    });
    await ws.tools.invoke('wms.order.transition', { orderNo: 'RT-SHIP', to: 'received' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
  });
});
