import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  OrderLineUnitUnknownError,
  SkuPackagesInvalidError,
  InsufficientStockError,
} from '../src/index.js';
import { allowDirectShip } from './direct-ship.js';

/**
 * 包装单位 + 换算率：SKU 定义基本单位与包装（1 箱 = 24 瓶），单据行选包装
 * 单位录入，工具层落事件前换算成基本单位（quantity 恒基本单位，enteredQty/
 * enteredUnit 是原录入快照）。库存调整/盘点等不在本特性范围（恒基本单位）。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
});

afterEach(() => {
  core.close();
});

/** 建「瓶 + 箱=24 / 包=6」的 SKU；用例要别的形状自己 invoke */
async function seedBottledSku(): Promise<void> {
  await ws.tools.invoke('wms.sku.create', {
    skuCode: 'COLA',
    name: '可乐',
    unit: '瓶',
    packages: [
      { unit: '箱', ratio: 24 },
      { unit: '包', ratio: 6 },
    ],
  });
}

describe('SKU：包装单位定义', () => {
  it('create 带 packages → 事件落账 → 投影可见（JSON 解析后）', async () => {
    await seedBottledSku();
    const sku = ws.skus.byCode('COLA')!;
    expect(sku.unit).toBe('瓶');
    expect(sku.packages).toEqual([
      { unit: '箱', ratio: 24 },
      { unit: '包', ratio: 6 },
    ]);
  });

  it('没有基本单位时定义包装 → 拒绝（换算的分母是基本单位）', async () => {
    await expect(
      ws.tools.invoke('wms.sku.create', {
        skuCode: 'X-1',
        name: '无单位货',
        packages: [{ unit: '箱', ratio: 24 }],
      }),
    ).rejects.toThrow(SkuPackagesInvalidError);
  });

  it('包装名与基本单位重名 / 包名重复 / 比例非正 → 拒绝', async () => {
    await expect(
      ws.tools.invoke('wms.sku.create', {
        skuCode: 'X-1',
        name: 'x',
        unit: '瓶',
        packages: [{ unit: '瓶', ratio: 2 }],
      }),
    ).rejects.toThrow(/不能与基本单位/);
    await expect(
      ws.tools.invoke('wms.sku.create', {
        skuCode: 'X-2',
        name: 'x',
        unit: '瓶',
        packages: [
          { unit: '箱', ratio: 24 },
          { unit: '箱', ratio: 12 },
        ],
      }),
    ).rejects.toThrow(/单位名重复/);
    await expect(
      ws.tools.invoke('wms.sku.create', {
        skuCode: 'X-3',
        name: 'x',
        unit: '瓶',
        packages: [{ unit: '箱', ratio: 0 }],
      }),
    ).rejects.toThrow(/必须是正数/);
  });

  it('update：不传 = 不改；[] = 清空；整体替换；与 unit 一起改', async () => {
    await seedBottledSku();

    await ws.tools.invoke('wms.sku.update', { skuCode: 'COLA', name: '可乐（改）' });
    expect(ws.skus.byCode('COLA')!.packages?.map((p) => p.unit)).toEqual(['箱', '包']);

    await ws.tools.invoke('wms.sku.update', { skuCode: 'COLA', packages: [] });
    expect(ws.skus.byCode('COLA')!.packages).toBeNull();

    // 换基本单位 + 重定义包装一次过（基本单位取「本次新值 ?? 现值」）
    await ws.tools.invoke('wms.sku.update', {
      skuCode: 'COLA',
      unit: '罐',
      packages: [{ unit: '箱', ratio: 12 }],
    });
    const sku = ws.skus.byCode('COLA')!;
    expect(sku.unit).toBe('罐');
    expect(sku.packages).toEqual([{ unit: '箱', ratio: 12 }]);
  });
});

describe('单据：按包装单位录入', () => {
  it('入库 2 箱 → 行 quantity=48（基本单位），entered 快照 2/箱；收货入账 48', async () => {
    await seedBottledSku();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 2, unit: '箱' }],
    });
    const order = ws.orders.list('in')[0]!;
    const line = ws.orders.lines(order.id)[0]!;
    expect(line.quantity).toBe(48);
    expect(line.enteredQty).toBe(2);
    expect(line.enteredUnit).toBe('箱');

    await ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'received' });
    expect(ws.inventory.quantityOf(ws.skus.byCode('COLA')!.id)).toBe(48); // 库存恒基本单位
  });

  it('unit 缺省或填基本单位 = 原语义（不写快照，事件形态与存量同构）', async () => {
    await seedBottledSku();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 10 }],
    });
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 5, unit: '瓶' }], // 显式填基本单位 → 同缺省
    });
    // list() 新单在前；此处不关心顺序，只看两条行的形态
    const lines = ws.orders.list('in').flatMap((o) => ws.orders.lines(o.id));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.enteredQty === null && l.enteredUnit === null)).toBe(true);
    expect(lines.map((l) => l.quantity).sort((a, b) => a - b)).toEqual([5, 10]);
  });

  it('拆零：1.5 包（ratio 6）= 9 个基本单位；换算后须为正', async () => {
    await seedBottledSku();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 1.5, unit: '包' }],
    });
    expect(ws.orders.lines(ws.orders.list('in')[0]!.id)[0]!.quantity).toBe(9);
  });

  it('未定义的包装单位 → 拒绝且不产生单据', async () => {
    await seedBottledSku();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'COLA', quantity: 1, unit: '托' }],
      }),
    ).rejects.toThrow(OrderLineUnitUnknownError);
    expect(ws.orders.list('in')).toHaveLength(0);
  });

  it('revise 改明细也能按包装录入（行快照随新行重写）', async () => {
    await seedBottledSku();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 1 }],
    });
    const order = ws.orders.list('in')[0]!;
    await ws.tools.invoke('wms.order.revise', {
      orderNo: order.orderNo,
      lines: [{ skuCode: 'COLA', quantity: 3, unit: '包' }],
    });
    const line = ws.orders.lines(order.id)[0]!;
    expect(line.quantity).toBe(18);
    expect(line.enteredQty).toBe(3);
    expect(line.enteredUnit).toBe('包');
  });

  it('出库按包装录入 → 余量校验按换算后的基本单位（不足即拒）', async () => {
    await seedBottledSku();
    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA', quantity: 1, unit: '箱' }], // 入 24 瓶
    });
    const inbound = ws.orders.list('in')[0]!;
    await ws.tools.invoke('wms.order.transition', { orderNo: inbound.orderNo, to: 'received' });

    // 25 瓶 > 24 → 拒（建单预检按基本单位余量），零出库单
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'COLA', quantity: 25, unit: '瓶' }],
      }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.list('out')).toHaveLength(0);

    // 正好 1 箱（= 24）→ 放行；发货流水 -24，按基本单位扣
    await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'COLA', quantity: 1, unit: '箱' }],
    });
    const outbound = ws.orders.list('out')[0]!;
    await ws.tools.invoke('wms.order.transition', { orderNo: outbound.orderNo, to: 'picking' });
    allowDirectShip(ws);
    const shipped = (await ws.tools.invoke('wms.order.transition', { orderNo: outbound.orderNo, to: 'shipped' })) as {
      adjustedLines: { skuCode: string; delta: number }[];
    };
    expect(shipped.adjustedLines).toEqual([
      { skuCode: 'COLA', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: -24 },
    ]);
    expect(ws.inventory.quantityOf(ws.skus.byCode('COLA')!.id)).toBe(0);
  });
});
