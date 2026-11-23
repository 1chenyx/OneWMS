import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  WMS_EVENT_TYPES,
  ProductAlreadyExistsError,
  ProductArchivedError,
  VariantAttrsMismatchError,
  VariantComboExistsError,
  SpecDimInUseError,
} from '../src/index.js';

/**
 * 商品（多规格 SPU 层）——投影 + 工具。
 * 投影部分：created/updated 投影、LWW、软停用口径、SKU 挂规格与 byProduct
 * 下钻、重放确定性（事件是唯一真相）。
 * 工具部分：CRUD 守卫（拒绝零事件）、组合对齐/唯一、specDims 在用保护。
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

function createProduct(productId: string, productCode: string, name: string, specDims?: unknown) {
  ws.events.append(WMS_EVENT_TYPES.productCreated, {
    productId,
    productCode,
    name,
    ...(specDims === undefined ? {} : { specDims }),
  });
}

function countWmsEvents(): number {
  let n = 0;
  ws.events.forEach((e) => {
    if (e.type.startsWith('wms.')) n++;
  });
  return n;
}

const DIMS = [
  { name: '颜色', values: ['红', '黑'] },
  { name: '尺码', values: ['S', 'M'] },
];

describe('商品投影：创建与更新', () => {
  it('product.created → 投影可见，specDims 解析、缺省 []', () => {
    createProduct('p-1', 'T-SHIRT', '纯棉T恤', [
      { name: '颜色', values: ['红', '黑', '白'] },
      { name: '尺码', values: ['S', 'M', 'L'] },
    ]);
    ws.sync();

    const p = ws.products.byCode('T-SHIRT')!;
    expect(p).toBeDefined();
    expect(p.id).toBe('p-1');
    expect(p.name).toBe('纯棉T恤');
    expect(p.status).toBe('active');
    expect(p.specDims).toEqual([
      { name: '颜色', values: ['红', '黑', '白'] },
      { name: '尺码', values: ['S', 'M', 'L'] },
    ]);

    createProduct('p-2', 'MUG', '马克杯');
    ws.sync();
    expect(ws.products.byCode('MUG')!.specDims).toEqual([]);
    expect(ws.products.list().map((x) => x.productCode)).toEqual(['MUG', 'T-SHIRT']);
  });

  it('product.updated → LWW：显式传才改，未传保持；specDims 整体覆盖', () => {
    createProduct('p-1', 'T-SHIRT', '纯棉T恤', [{ name: '颜色', values: ['红'] }]);
    ws.sync();
    ws.events.append(WMS_EVENT_TYPES.productUpdated, {
      productId: 'p-1',
      productCode: 'T-SHIRT',
      name: '精梳棉T恤',
      specDims: [
        { name: '颜色', values: ['红', '黑'] },
        { name: '尺码', values: ['S', 'M'] },
      ],
    });
    ws.sync();

    const p = ws.products.byId('p-1')!;
    expect(p.name).toBe('精梳棉T恤');
    expect(p.specDims).toEqual([
      { name: '颜色', values: ['红', '黑'] },
      { name: '尺码', values: ['S', 'M'] },
    ]);
    expect(p.status).toBe('active'); // 未传保持
  });

  it('软停用：archived 退出默认清单，includeArchived 可见', () => {
    createProduct('p-1', 'T-SHIRT', '纯棉T恤');
    createProduct('p-2', 'MUG', '马克杯');
    ws.sync();
    ws.events.append(WMS_EVENT_TYPES.productUpdated, {
      productId: 'p-1',
      productCode: 'T-SHIRT',
      status: 'archived',
    });
    ws.sync();

    expect(ws.products.list().map((x) => x.productCode)).toEqual(['MUG']);
    expect(ws.products.listMatching({ includeArchived: true }).map((x) => x.productCode)).toEqual([
      'MUG',
      'T-SHIRT',
    ]);
    expect(ws.products.byCode('T-SHIRT')!.status).toBe('archived'); // 业务键直查不隐藏
  });

  it('q 搜索与分页：total 与行同一 WHERE', () => {
    createProduct('p-1', 'T-SHIRT', '纯棉T恤');
    createProduct('p-2', 'T-SHIRT-LONG', '加厚T恤');
    createProduct('p-3', 'MUG', '马克杯');
    ws.sync();

    expect(ws.products.listMatching({ q: 'T恤' }).map((x) => x.productCode)).toEqual([
      'T-SHIRT',
      'T-SHIRT-LONG',
    ]);
    expect(ws.products.listMatching({ q: 'T-SHIRT' })).toHaveLength(2);
    const page = ws.products.listMatchingPage({ q: 'T恤', limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.rows.map((x) => x.productCode)).toEqual(['T-SHIRT-LONG']);
  });
});

describe('SKU 挂规格（多规格两列）', () => {
  const productId = 'p-1';

  beforeEach(() => {
    createProduct(productId, 'T-SHIRT', '纯棉T恤', [
      { name: '颜色', values: ['红', '黑'] },
      { name: '尺码', values: ['S', 'M'] },
    ]);
  });

  it('sku.created 携带 productId + variantAttrs → 投影可查、byProduct 下钻', () => {
    ws.events.append(WMS_EVENT_TYPES.skuCreated, {
      skuId: 's-1',
      skuCode: 'T-SHIRT-RED-S',
      name: '纯棉T恤 红/S',
      productId,
      variantAttrs: { 颜色: '红', 尺码: 'S' },
      barcode: '6900000000017',
    });
    ws.events.append(WMS_EVENT_TYPES.skuCreated, {
      skuId: 's-2',
      skuCode: 'T-SHIRT-BLK-M',
      name: '纯棉T恤 黑/M',
      productId,
      variantAttrs: { 颜色: '黑', 尺码: 'M' },
    });
    // 独立 SKU（存量口径）：不挂 SPU，两列为 NULL
    ws.events.append(WMS_EVENT_TYPES.skuCreated, { skuId: 's-3', skuCode: 'MUG-001', name: '马克杯' });
    ws.sync();

    const sku = ws.skus.byCode('T-SHIRT-RED-S')!;
    expect(sku.productId).toBe(productId);
    expect(sku.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' });
    expect(ws.skus.byCode('MUG-001')!.productId).toBeNull();
    expect(ws.skus.byCode('MUG-001')!.variantAttrs).toBeNull();

    expect(ws.skus.byProduct(productId).map((x) => x.skuCode)).toEqual([
      'T-SHIRT-BLK-M',
      'T-SHIRT-RED-S',
    ]);
    expect(ws.skus.byProduct('p-不存在')).toEqual([]);
  });

  it('sku.updated 改挂商品：LWW 覆盖 product_id / variant_attrs', () => {
    ws.events.append(WMS_EVENT_TYPES.skuCreated, { skuId: 's-1', skuCode: 'T-SHIRT-RED-S', name: '红/S' });
    ws.sync();
    ws.events.append(WMS_EVENT_TYPES.skuUpdated, {
      skuId: 's-1',
      skuCode: 'T-SHIRT-RED-S',
      productId,
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    ws.sync();

    const sku = ws.skus.byCode('T-SHIRT-RED-S')!;
    expect(sku.productId).toBe(productId);
    expect(sku.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' });
    expect(ws.skus.byProduct(productId)).toHaveLength(1);
  });
});

describe('重放确定性（事件是唯一真相）', () => {
  it('replay() 清空重放：商品与 SKU 的多规格字段全部回到真值', () => {
    createProduct('p-1', 'T-SHIRT', '纯棉T恤', [
      { name: '颜色', values: ['红', '黑'] },
      { name: '尺码', values: ['S', 'M'] },
    ]);
    ws.events.append(WMS_EVENT_TYPES.skuCreated, {
      skuId: 's-1',
      skuCode: 'T-SHIRT-RED-S',
      name: '纯棉T恤 红/S',
      productId: 'p-1',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    ws.sync();

    ws.replay();

    const p = ws.products.byCode('T-SHIRT')!;
    expect(p.specDims).toEqual([
      { name: '颜色', values: ['红', '黑'] },
      { name: '尺码', values: ['S', 'M'] },
    ]);
    const sku = ws.skus.byCode('T-SHIRT-RED-S')!;
    expect(sku.productId).toBe('p-1');
    expect(sku.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' });
    expect(ws.skus.byProduct('p-1').map((x) => x.skuCode)).toEqual(['T-SHIRT-RED-S']);
  });
});

describe('商品工具：创建 / 更新 / 停用', () => {
  it('create → 事件落账 → 投影可见；不传编码按规则发号，传了用传入的', async () => {
    const auto = (await ws.tools.invoke('wms.product.create', { name: '纯棉T恤', specDims: DIMS })) as {
      productCode: string;
      specDims: unknown;
    };
    expect(auto.productCode).toBe('PRD-0001');
    expect(auto.specDims).toEqual(DIMS);

    const given = (await ws.tools.invoke('wms.product.create', {
      productCode: ' T-SHIRT ',
      name: '纯棉T恤',
    })) as { productCode: string; specDims: unknown };
    expect(given.productCode).toBe('T-SHIRT');
    expect(given.specDims).toEqual([]); // 无维度 = 单规格归组

    expect(ws.products.list().map((x) => x.productCode)).toEqual(['PRD-0001', 'T-SHIRT']);
    const types: string[] = [];
    ws.events.forEach((e) => {
      if (e.type.startsWith('wms.')) types.push(e.type);
    });
    expect(types).toEqual(['wms.product.created', 'wms.product.created']);
  });

  it('编码重复 → 拒绝且零事件', async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤' });
    const baseline = countWmsEvents();
    await expect(
      ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '另一件' }),
    ).rejects.toThrow(ProductAlreadyExistsError);
    expect(countWmsEvents()).toBe(baseline);
    expect(ws.products.list()).toHaveLength(1);
  });

  it('specDims 形状非法 → 拒绝且零事件（维度名空/重名/无取值/取值重复）', async () => {
    const bad = [
      [{ name: '  ', values: ['红'] }],
      [
        { name: '颜色', values: ['红'] },
        { name: '颜色', values: ['黑'] },
      ],
      [{ name: '颜色', values: [] }],
      [{ name: '颜色', values: ['红', '红'] }],
      [{ name: '颜色', values: ['红', '  '] }],
    ];
    for (const specDims of bad) {
      await expect(ws.tools.invoke('wms.product.create', { name: '纯棉T恤', specDims })).rejects.toThrow(
        /TOOL_REJECTED/,
      );
    }
    expect(countWmsEvents()).toBe(0);
    expect(ws.products.list()).toEqual([]);
  });

  it('update：只传 name → specDims 保持；传 specDims → 整体替换', async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤', specDims: DIMS });
    await ws.tools.invoke('wms.product.update', { productCode: 'T-SHIRT', name: '精梳棉T恤' });
    expect(ws.products.byCode('T-SHIRT')!.name).toBe('精梳棉T恤');
    expect(ws.products.byCode('T-SHIRT')!.specDims).toEqual(DIMS);

    await ws.tools.invoke('wms.product.update', {
      productCode: 'T-SHIRT',
      specDims: [{ name: '颜色', values: ['红', '黑', '白'] }],
    });
    expect(ws.products.byCode('T-SHIRT')!.specDims).toEqual([{ name: '颜色', values: ['红', '黑', '白'] }]);
  });

  it('archive / unarchive：软停用退出清单、幂等零事件、可恢复', async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤' });
    await ws.tools.invoke('wms.product.create', { productCode: 'MUG', name: '马克杯' });
    const baseline = countWmsEvents();

    await ws.tools.invoke('wms.product.archive', { productCode: 'T-SHIRT' });
    expect(ws.products.list().map((x) => x.productCode)).toEqual(['MUG']);
    expect(ws.products.listMatching({ includeArchived: true })).toHaveLength(2);

    await ws.tools.invoke('wms.product.archive', { productCode: 'T-SHIRT' }); // 已停用：零事件
    expect(countWmsEvents()).toBe(baseline + 1);

    await ws.tools.invoke('wms.product.unarchive', { productCode: 'T-SHIRT' });
    expect(ws.products.byCode('T-SHIRT')!.status).toBe('active');
    await ws.tools.invoke('wms.product.unarchive', { productCode: 'T-SHIRT' }); // 已启用：零事件
    expect(countWmsEvents()).toBe(baseline + 2);
  });

  it('不存在的编码 → ProductNotFound；list 工具支持 q 与 includeArchived', async () => {
    await expect(ws.tools.invoke('wms.product.update', { productCode: 'NOPE', name: 'x' })).rejects.toThrow(
      /NOPE/,
    );
    await expect(ws.tools.invoke('wms.product.archive', { productCode: 'NOPE' })).rejects.toThrow(/NOPE/);

    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤' });
    await ws.tools.invoke('wms.product.create', { productCode: 'MUG', name: '马克杯' });
    await ws.tools.invoke('wms.product.archive', { productCode: 'MUG' });

    const active = (await ws.tools.invoke('wms.product.list', {})) as { products: { productCode: string }[] };
    expect(active.products.map((x) => x.productCode)).toEqual(['T-SHIRT']);
    const all = (await ws.tools.invoke('wms.product.list', { q: 'MUG', includeArchived: true })) as {
      products: { productCode: string; status: string }[];
    };
    expect(all.products).toEqual([expect.objectContaining({ productCode: 'MUG', status: 'archived' })]);
  });
});

describe('SKU 挂规格（工具守卫）', () => {
  beforeEach(async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤', specDims: DIMS });
    await ws.tools.invoke('wms.product.create', { productCode: 'MUG', name: '马克杯' });
  });

  it('create 带 productCode + variantAttrs → 挂上；不传 skuCode 自动生成「商品码-取值」', async () => {
    const made = (await ws.tools.invoke('wms.sku.create', {
      name: '纯棉T恤',
      productCode: 'T-SHIRT',
      variantAttrs: { 尺码: 'S', 颜色: '红' }, // 键序无关
    })) as { skuCode: string; productCode: string; variantAttrs: Record<string, string> };
    expect(made.skuCode).toBe('T-SHIRT-红-S');
    expect(made.productCode).toBe('T-SHIRT');

    const sku = ws.skus.byCode('T-SHIRT-红-S')!;
    expect(sku.productId).toBe(ws.products.byCode('T-SHIRT')!.id);
    expect(sku.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' }); // 按维度顺序规范化
  });

  it('商品不存在 / 已停用 → 拒绝挂靠且零事件', async () => {
    const baseline = countWmsEvents();
    await expect(
      ws.tools.invoke('wms.sku.create', { name: 'x', productCode: 'NOPE', variantAttrs: { 颜色: '红', 尺码: 'S' } }),
    ).rejects.toThrow(/NOPE/);

    await ws.tools.invoke('wms.product.archive', { productCode: 'T-SHIRT' });
    await expect(
      ws.tools.invoke('wms.sku.create', {
        name: 'x',
        productCode: 'T-SHIRT',
        variantAttrs: { 颜色: '红', 尺码: 'S' },
      }),
    ).rejects.toThrow(ProductArchivedError);
    expect(countWmsEvents()).toBe(baseline + 1); // 只多了 archive 那一个
    expect(ws.skus.list()).toEqual([]);
  });

  it('组合与 specDims 不对齐 → 拒绝（缺维度/多键/取值非法/空值/无维度商品带组合）', async () => {
    const bad: Record<string, string>[] = [
      { 颜色: '红' }, // 缺 尺码
      { 颜色: '红', 尺码: 'S', 材质: '棉' }, // 多键
      { 颜色: '紫', 尺码: 'S' }, // 取值不在清单
      { 颜色: '  ', 尺码: 'S' }, // 空值
      {}, // 空组合
    ];
    const baseline = countWmsEvents();
    for (const variantAttrs of bad) {
      await expect(
        ws.tools.invoke('wms.sku.create', { name: 'x', productCode: 'T-SHIRT', variantAttrs }),
      ).rejects.toThrow(VariantAttrsMismatchError);
    }
    // 有维度商品必须给组合
    await expect(
      ws.tools.invoke('wms.sku.create', { name: 'x', productCode: 'T-SHIRT' }),
    ).rejects.toThrow(VariantAttrsMismatchError);
    // 无维度商品不能带组合
    await expect(
      ws.tools.invoke('wms.sku.create', { name: 'x', productCode: 'MUG', variantAttrs: { 颜色: '红' } }),
    ).rejects.toThrow(VariantAttrsMismatchError);

    expect(countWmsEvents()).toBe(baseline);
    expect(ws.skus.list()).toEqual([]);
  });

  it('同商品下组合唯一 → 重复拒绝；不同商品同组合互不影响', async () => {
    await ws.tools.invoke('wms.sku.create', {
      name: '纯棉T恤',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    await expect(
      ws.tools.invoke('wms.sku.create', {
        name: '纯棉T恤',
        productCode: 'T-SHIRT',
        variantAttrs: { 颜色: '红', 尺码: 'S' },
      }),
    ).rejects.toThrow(VariantComboExistsError);
    expect(ws.skus.list()).toHaveLength(1);

    await ws.tools.invoke('wms.product.create', { productCode: 'POLO', name: 'POLO衫', specDims: DIMS });
    const polo = (await ws.tools.invoke('wms.sku.create', {
      name: 'POLO衫',
      productCode: 'POLO',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    })) as { skuCode: string };
    expect(polo.skuCode).toBe('POLO-红-S');
    expect(ws.skus.list()).toHaveLength(2);
  });

  it('只传 variantAttrs：未挂商品 → 拒绝；已挂商品 → 改组合', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'SOLO', name: '独立商品' });
    await expect(ws.tools.invoke('wms.sku.update', { skuCode: 'SOLO', variantAttrs: { 颜色: '红', 尺码: 'S' } })).rejects.toThrow(
      /请同时指定 productCode/,
    );

    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'T-RED-S',
      name: '纯棉T恤',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'T-RED-S', variantAttrs: { 颜色: '黑', 尺码: 'M' } });
    expect(ws.skus.byCode('T-RED-S')!.variantAttrs).toEqual({ 颜色: '黑', 尺码: 'M' });
    // 改回自身原组合不算冲突（排除自身）
    await ws.tools.invoke('wms.sku.update', { skuCode: 'T-RED-S', variantAttrs: { 颜色: '红', 尺码: 'S' } });
    expect(ws.skus.byCode('T-RED-S')!.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' });
  });

  it('改挂到别的商品：无维度商品清空旧组合，有维度商品必须补新组合', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'T-RED-S',
      name: '纯棉T恤',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    // 换挂到有维度商品：旧组合不作数，必须重新给（否则拒）
    await ws.tools.invoke('wms.product.create', { productCode: 'POLO', name: 'POLO衫', specDims: DIMS });
    await expect(ws.tools.invoke('wms.sku.update', { skuCode: 'T-RED-S', productCode: 'POLO' })).rejects.toThrow(
      VariantAttrsMismatchError,
    );

    await ws.tools.invoke('wms.sku.update', { skuCode: 'T-RED-S', productCode: 'MUG' });
    const moved = ws.skus.byCode('T-RED-S')!;
    expect(moved.productId).toBe(ws.products.byCode('MUG')!.id);
    expect(moved.variantAttrs).toBeNull();
    expect(ws.skus.byProduct(ws.products.byCode('T-SHIRT')!.id)).toEqual([]);

    // 原商品的组合已释放，可以再挂
    await ws.tools.invoke('wms.sku.create', {
      name: '纯棉T恤',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
    expect(ws.skus.list()).toHaveLength(2);
  });
});

describe('specDims 在用保护（wms.product.update）', () => {
  beforeEach(async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'T-SHIRT', name: '纯棉T恤', specDims: DIMS });
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'T-RED-S',
      name: '纯棉T恤 红/S',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '红', 尺码: 'S' },
    });
  });

  it('删在用维度 / 删在用取值 / 改成无维度 → 拒绝且零事件', async () => {
    const baseline = countWmsEvents();
    const rejected = [
      [{ name: '尺码', values: ['S', 'M'] }], // 删了 颜色
      [{ name: '颜色', values: ['黑'] }, { name: '尺码', values: ['S', 'M'] }], // 删了 红
      [{ name: '颜色', values: ['红'] }, { name: '尺码', values: ['M'] }], // 删了 S
      [], // 改成无维度
    ];
    for (const specDims of rejected) {
      await expect(ws.tools.invoke('wms.product.update', { productCode: 'T-SHIRT', specDims })).rejects.toThrow(
        SpecDimInUseError,
      );
    }
    expect(countWmsEvents()).toBe(baseline);
    expect(ws.products.byCode('T-SHIRT')!.specDims).toEqual(DIMS);
  });

  it('加维度但已挂 SKU 没有该维度取值 → 拒绝（先补组合再加维度）', async () => {
    const baseline = countWmsEvents();
    await expect(
      ws.tools.invoke('wms.product.update', {
        productCode: 'T-SHIRT',
        specDims: [...DIMS, { name: '版型', values: ['常规', '宽松'] }],
      }),
    ).rejects.toThrow(SpecDimInUseError);
    // 维度还没加上，SKU 也不能提前带这个键
    await expect(
      ws.tools.invoke('wms.sku.update', {
        skuCode: 'T-RED-S',
        variantAttrs: { 颜色: '红', 尺码: 'S', 版型: '常规' },
      }),
    ).rejects.toThrow(VariantAttrsMismatchError);

    expect(countWmsEvents()).toBe(baseline);
    expect(ws.products.byCode('T-SHIRT')!.specDims).toEqual(DIMS);
    expect(ws.skus.byCode('T-RED-S')!.variantAttrs).toEqual({ 颜色: '红', 尺码: 'S' });
  });

  it('加取值 / 换维度取值顺序 → 放行', async () => {
    await ws.tools.invoke('wms.product.update', {
      productCode: 'T-SHIRT',
      specDims: [
        { name: '颜色', values: ['红', '黑', '白'] },
        { name: '尺码', values: ['S', 'M', 'L'] },
      ],
    });
    expect(ws.products.byCode('T-SHIRT')!.specDims[0]!.values).toEqual(['红', '黑', '白']);
    // 新增取值不占用组合，新 SKU 可以挂
    await ws.tools.invoke('wms.sku.create', {
      name: '纯棉T恤 白/L',
      productCode: 'T-SHIRT',
      variantAttrs: { 颜色: '白', 尺码: 'L' },
    });
    expect(ws.skus.byProduct(ws.products.byCode('T-SHIRT')!.id)).toHaveLength(2);
  });

  it('无挂靠时维度可自由改（含无维度 ↔ 有维度翻转）', async () => {
    await ws.tools.invoke('wms.product.create', { productCode: 'MUG', name: '马克杯' });
    await ws.tools.invoke('wms.product.update', { productCode: 'MUG', specDims: [{ name: '容量', values: ['350ml'] }] });
    expect(ws.products.byCode('MUG')!.specDims).toEqual([{ name: '容量', values: ['350ml'] }]);
    await ws.tools.invoke('wms.product.update', { productCode: 'MUG', specDims: [] });
    expect(ws.products.byCode('MUG')!.specDims).toEqual([]);
  });
});
