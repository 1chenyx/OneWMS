import { describe, expect, it } from 'vitest';
import type { Order, Sku } from '../src/api/wms-api';
import {
  buildInventorySummary,
  buildOrderSheet,
  buildSkuSheet,
  parseLocationTable,
  parseOrderTable,
  parsePartnerTable,
  parseSkuTable,
} from '../src/lib/exchange';
import { NAV_CATEGORIES } from '../src/nav';

const sku = (patch: Partial<Sku> = {}): Sku => ({
  id: 's-1',
  skuCode: 'A-1',
  barcode: '6901234567892',
  reorderPoint: 50,
  unit: '个',
  status: 'active',
  name: '螺丝',
  extData: { spec: 'M6' },
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
  ...patch,
});

describe('导航不再单列导入导出', () => {
  it('档案和作业页还在，没有「导入导出」入口', () => {
    const items = NAV_CATEGORIES.flatMap((category) => category.items.map((item) => item.label));
    expect(items).not.toContain('导入导出');
    expect(items).toEqual(expect.arrayContaining(['SKU 管理', '库位管理', '往来单位', '入库单', '出库单', '库存']));
  });
});

describe('SKU 表', () => {
  const existing = [{ skuCode: 'A-1', barcode: '6901234567892' }];

  it('导出带状态和可见扩展列，导入只认档案列', () => {
    const table = buildSkuSheet([sku()], [{ key: 'spec', label: '规格' }]);
    expect(table.headers).toEqual(['编码', '名称', '单位', '条码', '安全库存', '状态', '规格']);
    expect(table.rows[0]).toEqual(['A-1', '螺丝', '个', '6901234567892', 50, '启用', 'M6']);
    const parsed = parseSkuTable([table.headers, table.rows[0]!.map(String)], existing);
    expect(parsed[0]).toMatchObject({ action: 'update', skuCode: 'A-1', name: '螺丝', reorderPoint: 50 });
  });

  it('新建、文件内重复、坏的安全库存、条码占用', () => {
    const table = [
      ['编码', '名称', '条码', '安全库存'],
      ['B-2', '螺母', '', ''],
      ['B-2', '重复', '', ''],
      ['C-3', '坏阈值', '', '1.5'],
      ['D-4', '抢条码', '6901234567892', ''],
      ['E-5', '', '', ''],
    ];
    const rows = parseSkuTable(table, existing);
    expect(rows.map((row) => [row.skuCode, row.action])).toEqual([
      ['B-2', 'create'],
      ['B-2', 'error'],
      ['C-3', 'error'],
      ['D-4', 'error'],
      ['E-5', 'error'],
    ]);
    expect(rows[2]?.reason).toMatch(/安全库存/);
    expect(rows[3]?.reason).toMatch(/条码/);
    expect(rows[4]?.reason).toMatch(/名称/);
  });

  it('没有编码列就整表拒绝', () => {
    expect(() => parseSkuTable([['名称'], ['螺丝']], [])).toThrow(/编码/);
  });
});

describe('库位表', () => {
  it('已有编码是更新，DEFAULT 和空编码跳过', () => {
    const rows = parseLocationTable(
      [
        ['库位编码', '名称'],
        ['A-01', '货架'],
        ['B-02', ''],
        ['DEFAULT', '默认'],
        ['', '无名'],
      ],
      new Set(['A-01']),
    );
    expect(rows.map((row) => row.action)).toEqual(['update', 'create', 'error', 'error']);
    expect(rows[2]?.reason).toMatch(/DEFAULT/);
  });
});

describe('往来单位表', () => {
  const existing = [
    { partnerCode: 'SUP-1', kind: 'supplier' as const },
    { partnerCode: 'SUP-2', kind: 'supplier' as const },
  ];

  it('中文种类能新建；已有档案不能改种类', () => {
    const rows = parsePartnerTable(
      [
        ['编码', '种类', '名称', '电话'],
        ['CUS-1', '客户', '甲公司', '021-1'],
        ['SUP-1', '客户', '改名', ''],
        ['SUP-2', '供应商', '新名', '13900000000'],
        ['SUP-2', '供应商', '再改一次', ''],
      ],
      existing,
    );
    expect(rows[0]).toMatchObject({ action: 'create', kind: 'customer', phone: '021-1' });
    expect(rows[1]?.action).toBe('error');
    expect(rows[1]?.reason).toMatch(/种类不能改/);
    expect(rows[2]).toMatchObject({ action: 'update', name: '新名', phone: '13900000000' });
    expect(rows[3]?.action).toBe('error');
    expect(rows[3]?.reason).toMatch(/文件内重复/);
  });
});

describe('出入库单表', () => {
  const lookups = {
    skuCodes: new Set(['A-1', 'B-2']),
    partners: new Map<string, 'supplier' | 'customer'>([
      ['SUP-1', 'supplier'],
      ['CUS-1', 'customer'],
    ]),
    locationCodes: new Set(['A-01']),
    orderNos: new Set(['IN-OLD']),
  };

  it('同单号合并；留空单号各成一单；已有单号、方向冲突整单跳过', () => {
    const rows = parseOrderTable(
      [
        ['单号', '方向', '往来单位编码', '备注', 'SKU编码', '数量', '库位', '批次', '效期'],
        ['IN-NEW', '入库', 'SUP-1', '补货', 'A-1', '10', 'A-01', 'B1', '2027-06-01'],
        ['IN-NEW', '入库', '', '', 'B-2', '2.5', '', '', ''],
        ['', '出库', 'CUS-1', '', 'A-1', '1', '', '', ''],
        ['IN-OLD', '入库', '', '', 'A-1', '1', '', '', ''],
        ['IN-BAD', '入库', '', '', 'A-1', '1', '', '', ''],
        ['IN-BAD', '出库', '', '', 'A-1', '1', '', '', ''],
      ],
      lookups,
    );
    expect(rows[0]).toMatchObject({ action: 'create', groupKey: 'no:IN-NEW', quantity: 10 });
    expect(rows[1]).toMatchObject({ action: 'create', groupKey: 'no:IN-NEW', quantity: 2.5 });
    expect(rows[2]).toMatchObject({ action: 'create', direction: 'out', groupKey: 'line:4' });
    expect(rows[3]?.reason).toMatch(/已存在/);
    expect(rows[4]?.reason).toMatch(/方向不一致|同单其他行/);
    expect(rows[5]?.reason).toMatch(/方向不一致|同单其他行/);
  });

  it('未知 SKU、出库填效期、客户配进入库单都会跳过', () => {
    const rows = parseOrderTable(
      [
        ['方向', 'SKU编码', '数量', '往来单位编码', '效期'],
        ['入库', 'NOPE', '1', '', ''],
        ['出库', 'A-1', '1', '', '2027-01-01'],
        ['入库', 'A-1', '1', 'CUS-1', ''],
        ['出库', 'A-1', '0.0004', '', ''],
      ],
      lookups,
    );
    expect(rows.map((row) => row.reason)).toEqual([
      expect.stringMatching(/不存在/),
      expect.stringMatching(/效期/),
      expect.stringMatching(/供应商/),
      expect.stringMatching(/小数|正数/),
    ]);
  });

  it('导出列和导出行对齐，方向用中文', () => {
    const order: Order = {
      id: 'o-1',
      orderNo: 'IN-1',
      direction: 'in',
      state: 'created',
      partnerCode: 'SUP-1',
      partnerName: '供应商甲',
      note: null,
      createdAt: '2026-11-07T08:00:00.000Z',
      updatedAt: '2026-11-07T08:00:00.000Z',
      lines: [
        { skuCode: 'A-1', name: '螺丝', quantity: 3, unit: '个', locationCode: 'A-01', batchNo: 'B1', batchExpiryDate: '2027-06-01' },
      ],
    };
    const sheet = buildOrderSheet([order], () => '已创建');
    expect(sheet.rows[0]).toHaveLength(sheet.headers.length);
    expect(sheet.headers).toContain('SKU编码');
    expect(sheet.rows[0]?.[1]).toBe('入库');
    expect(sheet.rows[0]?.[2]).toBe('已创建');
  });
});

describe('库存汇总', () => {
  it('低于安全库存标「是」，预占列按开关出现', () => {
    const row = {
      skuId: 's',
      skuCode: 'A-1',
      name: '螺丝',
      quantity: 4,
      held: 0,
      reserved: 1,
      available: 3,
      reorderPoint: 10,
      unit: '个',
    };
    const withReserved = buildInventorySummary([row], true);
    expect(withReserved.headers).toContain('预占');
    expect(withReserved.rows[0]?.at(-1)).toBe('是');
    expect(buildInventorySummary([row], false).headers).not.toContain('预占');
  });
});
