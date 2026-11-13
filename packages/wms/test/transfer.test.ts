import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  SkuNotFoundError,
  TransferExistsError,
  TransferNoLinesError,
  TransferNotFoundError,
  TransferStateError,
  InsufficientStockError,
  DEFAULT_LOCATION_ID,
  DEFAULT_BATCH_NO,
} from '../src/index.js';

/**
 * 调拨单（transfer）：
 *  - 生命周期：created → ship（源扣减）→ inTransit → receive（目标加增）→ completed
 *  - 状态守卫：未发货不能收货；重复发货/收货拒绝；created 外不能取消
 *  - 库存联动：普通 inventory.adjusted（reason: transfer:单号）；批次保持不变
 *  - 取消零库存影响；余量不足整体拒绝；replay 后投影一致
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-transfer');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'L-1', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'L-2', name: '二号架' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, locationCode: 'L-1', batchNo: 'B1' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 5, locationCode: 'L-1' });
});

afterEach(() => {
  core.close();
});

function locId(code: string): string {
  return code === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(code)!.id;
}

function qty(skuCode: string, locationCode: string, batchNo = DEFAULT_BATCH_NO): number {
  return ws.inventory.quantityOf(ws.skus.byCode(skuCode)!.id, locId(locationCode), batchNo);
}

function ledgerReasons(skuCode: string): string[] {
  return ws.inventory.ledgerOf(ws.skus.byCode(skuCode)!.id).map((l) => l.reason);
}

describe('创建与守卫', () => {
  it('建单：默认单号、行落投影、不动库存', async () => {
    const r = (await ws.tools.invoke('wms.transfer.create', {
      lines: [
        { skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 4 },
      ],
    })) as { transferNo: string; state: string; lineCount: number };
    expect(r.transferNo).toMatch(/^TR-\d{8}-\d{3}$/);
    expect(r.state).toBe('created');
    expect(r.lineCount).toBe(1);
    expect(qty('A-1', 'L-1', 'B1')).toBe(10);
    expect(ws.transfers.byNo(r.transferNo)!.state).toBe('created');
  });

  it('空行拒绝；单号重复拒绝；SKU 不存在拒绝', async () => {
    await expect(ws.tools.invoke('wms.transfer.create', { lines: [] })).rejects.toThrow(TransferNoLinesError);
    await ws.tools.invoke('wms.transfer.create', {
      transferNo: 'TR-1',
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 1 }],
    });
    await expect(
      ws.tools.invoke('wms.transfer.create', {
        transferNo: 'TR-1',
        lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 1 }],
      }),
    ).rejects.toThrow(TransferExistsError);
    await expect(
      ws.tools.invoke('wms.transfer.create', {
        lines: [{ skuCode: 'X-9', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 1 }],
      }),
    ).rejects.toThrow(SkuNotFoundError);
  });

  it('源目标库位相同拒绝（同库位请用移库）', async () => {
    await expect(
      ws.tools.invoke('wms.transfer.create', {
        lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/源库位与目标库位相同/);
  });

  it('单号递增：同日第二张 +1', async () => {
    const a = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 1 }],
    })) as { transferNo: string };
    const b = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 1 }],
    })) as { transferNo: string };
    expect(a.transferNo).not.toBe(b.transferNo);
  });
});

describe('发货 / 收货', () => {
  it('两阶段闭环：ship 扣源、receive 增目标，批次不变', async () => {
    const { transferNo } = (await ws.tools.invoke('wms.transfer.create', {
      lines: [
        { skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 4 },
        { skuCode: 'B-2', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 2 },
      ],
    })) as { transferNo: string };
    const ship = (await ws.tools.invoke('wms.transfer.ship', { transferNo })) as { state: string };
    expect(ship.state).toBe('inTransit');
    expect(qty('A-1', 'L-1', 'B1')).toBe(6);
    expect(qty('B-2', 'L-1')).toBe(3);
    expect(qty('A-1', 'L-2', 'B1')).toBe(0);
    const recv = (await ws.tools.invoke('wms.transfer.receive', { transferNo })) as { state: string };
    expect(recv.state).toBe('completed');
    expect(qty('A-1', 'L-1', 'B1')).toBe(6);
    expect(qty('A-1', 'L-2', 'B1')).toBe(4);
    expect(qty('B-2', 'L-2')).toBe(2);
    expect(ledgerReasons('A-1')).toEqual(expect.arrayContaining([`transfer:${transferNo}`, `transfer:${transferNo}`]));
  });

  it('在途守卫：未发货不能收货；重复 ship/receive 拒绝', async () => {
    const { transferNo } = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 1 }],
    })) as { transferNo: string };
    await expect(ws.tools.invoke('wms.transfer.receive', { transferNo })).rejects.toThrow(TransferStateError);
    await ws.tools.invoke('wms.transfer.ship', { transferNo });
    await expect(ws.tools.invoke('wms.transfer.ship', { transferNo })).rejects.toThrow(TransferStateError);
    await ws.tools.invoke('wms.transfer.receive', { transferNo });
    await expect(ws.tools.invoke('wms.transfer.receive', { transferNo })).rejects.toThrow(TransferStateError);
  });

  it('余量不足整单拒绝（另一行也不落流水）', async () => {
    const { transferNo } = (await ws.tools.invoke('wms.transfer.create', {
      lines: [
        { skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 3 },
        { skuCode: 'B-2', fromLocationCode: 'L-1', toLocationCode: 'L-2', quantity: 99 },
      ],
    })) as { transferNo: string };
    await expect(ws.tools.invoke('wms.transfer.ship', { transferNo })).rejects.toThrow(InsufficientStockError);
    // 整单拒绝：A-1 行也没有被扣
    expect(qty('A-1', 'L-1', 'B1')).toBe(10);
    expect(ws.transfers.byNo(transferNo)!.state).toBe('created');
  });

  it('created 阶段取消：零库存影响；在途不能取消', async () => {
    const a = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 2 }],
    })) as { transferNo: string };
    const r = (await ws.tools.invoke('wms.transfer.cancel', { transferNo: a.transferNo })) as { state: string };
    expect(r.state).toBe('canceled');
    expect(qty('A-1', 'L-1', 'B1')).toBe(10);
    await expect(ws.tools.invoke('wms.transfer.cancel', { transferNo: a.transferNo })).rejects.toThrow(
      TransferStateError,
    );

    const b = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 2 }],
    })) as { transferNo: string };
    await ws.tools.invoke('wms.transfer.ship', { transferNo: b.transferNo });
    await expect(ws.tools.invoke('wms.transfer.cancel', { transferNo: b.transferNo })).rejects.toThrow(
      TransferStateError,
    );
  });

  it('单据不存在：全部操作拒绝', async () => {
    await expect(ws.tools.invoke('wms.transfer.ship', { transferNo: 'TR-404' })).rejects.toThrow(
      TransferNotFoundError,
    );
  });
});

describe('重放一致性', () => {
  it('replay 后调拨投影逐字节重建', async () => {
    const { transferNo } = (await ws.tools.invoke('wms.transfer.create', {
      lines: [{ skuCode: 'A-1', fromLocationCode: 'L-1', toLocationCode: 'L-2', batchNo: 'B1', quantity: 4 }],
    })) as { transferNo: string };
    await ws.tools.invoke('wms.transfer.ship', { transferNo });
    await ws.tools.invoke('wms.transfer.receive', { transferNo });
    const before = ws.transfers.byNo(transferNo)!;
    const linesBefore = ws.transfers.lines(before.id);
    ws.replay();
    const after = ws.transfers.byNo(transferNo)!;
    expect(after).toEqual(before);
    expect(ws.transfers.lines(after.id)).toEqual(linesBefore);
    expect(qty('A-1', 'L-2', 'B1')).toBe(4);
    expect(qty('A-1', 'L-1', 'B1')).toBe(6);
  });
});
