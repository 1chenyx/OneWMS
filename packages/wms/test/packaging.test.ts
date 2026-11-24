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

describe('商品级默认单位与包装：SKU 继承', () => {
  /** 建「可乐：瓶，箱=24 / 包=6」的商品 + 两个规格 SKU（红 / 黑），SKU 不带单位与包装 */
  async function seedProduct(): Promise<void> {
    await ws.tools.invoke('wms.product.create', {
      productCode: 'COLA',
      name: '可乐',
      unit: '瓶',
      packages: [
        { unit: '箱', ratio: 24 },
        { unit: '包', ratio: 6 },
      ],
      specDims: [{ name: '颜色', values: ['红', '黑'] }],
    });
    await ws.tools.invoke('wms.sku.create', {
      name: '可乐',
      productCode: 'COLA',
      variantAttrs: { 颜色: '红' },
    });
    await ws.tools.invoke('wms.sku.create', {
      name: '可乐',
      productCode: 'COLA',
      variantAttrs: { 颜色: '黑' },
    });
  }

  it('商品带 unit / packages 落账 → 投影可见；不传 = null', async () => {
    await seedProduct();
    await ws.tools.invoke('wms.product.create', { productCode: 'MUG', name: '马克杯' });
    const cola = ws.products.byCode('COLA')!;
    expect(cola.unit).toBe('瓶');
    expect(cola.packages).toEqual([
      { unit: '箱', ratio: 24 },
      { unit: '包', ratio: 6 },
    ]);
    expect(ws.products.byCode('MUG')!.unit).toBeNull();
    expect(ws.products.byCode('MUG')!.packages).toBeNull();
  });

  it('SKU 不设单位/包装 → 继承商品的（unitInherited / packagesInherited 标记）', async () => {
    await seedProduct();
    const red = ws.skus.byCode('COLA-红')!;
    expect(red.unit).toBe('瓶');
    expect(red.packages?.map((p) => p.unit)).toEqual(['箱', '包']);
    expect(red.unitInherited).toBe(true);
    expect(red.packagesInherited).toBe(true);
    // 独立 SKU 没有可继承的来源
    await ws.tools.invoke('wms.sku.create', { skuCode: 'LOOSE', name: '散货' });
    expect(ws.skus.byCode('LOOSE')!.unitInherited).toBe(false);
    expect(ws.skus.byCode('LOOSE')!.packagesInherited).toBe(false);
  });

  it('SKU 单独设置 → 覆盖商品的；传 [] = 明确不要包装（不回落）', async () => {
    await seedProduct();
    await ws.tools.invoke('wms.sku.update', {
      skuCode: 'COLA-红',
      unit: '罐',
      packages: [{ unit: '提', ratio: 8 }],
    });
    const red = ws.skus.byCode('COLA-红')!;
    expect(red.unit).toBe('罐');
    expect(red.packages).toEqual([{ unit: '提', ratio: 8 }]);
    expect(red.unitInherited).toBe(false);
    expect(red.packagesInherited).toBe(false);

    await ws.tools.invoke('wms.sku.update', { skuCode: 'COLA-黑', packages: [] });
    const black = ws.skus.byCode('COLA-黑')!;
    expect(black.packages).toBeNull();
    expect(black.packagesInherited).toBe(false);
    expect(black.unit).toBe('瓶'); // 单位仍继承
  });

  it('改商品的默认包装 → 继承的 SKU 立即按新比例换算；单独设置的不受影响', async () => {
    await seedProduct();
    await ws.tools.invoke('wms.product.update', {
      productCode: 'COLA',
      packages: [{ unit: '箱', ratio: 12 }],
    });
    expect(ws.skus.byCode('COLA-红')!.packages).toEqual([{ unit: '箱', ratio: 12 }]);

    await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'COLA-红', quantity: 2, unit: '箱' }],
    });
    const line = ws.orders.lines(ws.orders.list('in')[0]!.id)[0]!;
    expect(line.quantity).toBe(24);
    expect(line.enteredUnit).toBe('箱');

    // 改商品前就按旧比例开的单：录入快照与基本单位数量都不动
    await ws.tools.invoke('wms.product.update', { productCode: 'COLA', packages: [] });
    expect(ws.skus.byCode('COLA-红')!.packages).toBeNull();
    expect(ws.orders.lines(ws.orders.list('in')[0]!.id)[0]!.quantity).toBe(24);
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'COLA-红', quantity: 1, unit: '箱' }],
      }),
    ).rejects.toThrow(OrderLineUnitUnknownError);
  });

  it('商品没有基本单位时定义默认包装 → 拒绝；有包装时不能清空基本单位', async () => {
    await expect(
      ws.tools.invoke('wms.product.create', {
        productCode: 'X',
        name: 'x',
        packages: [{ unit: '箱', ratio: 24 }],
      }),
    ).rejects.toThrow(SkuPackagesInvalidError);
    await seedProduct();
    await expect(ws.tools.invoke('wms.product.update', { productCode: 'COLA', unit: '' })).rejects.toThrow(
      SkuPackagesInvalidError,
    );
    expect(ws.products.byCode('COLA')!.unit).toBe('瓶');
    // 先清包装，再清单位：放行
    await ws.tools.invoke('wms.product.update', { productCode: 'COLA', packages: [] });
    await ws.tools.invoke('wms.product.update', { productCode: 'COLA', unit: '' });
    expect(ws.products.byCode('COLA')!.unit).toBeNull();
    expect(ws.skus.byCode('COLA-红')!.unit).toBeNull();
  });

  it('SKU 只带包装、单位靠继承 → 基本单位取商品的', async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'P', name: 'p', unit: '个' });
    await ws.tools.invoke('wms.sku.create', {
      name: 'p',
      productCode: 'P',
      packages: [{ unit: '盒', ratio: 10 }],
    });
    const sku = ws.skus.list()[0]!;
    expect(sku.unit).toBe('个');
    expect(sku.packages).toEqual([{ unit: '盒', ratio: 10 }]);
  });
});
