import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { OneCore } from '@one/core';
import {
  WmsDomain,
  InsufficientStockError,
  BatchExpiryMismatchError,
  AllocationInsufficientError,
  DEFAULT_LOCATION_ID,
  DEFAULT_BATCH_NO,
  WMS_EVENT_TYPES,
} from '../src/index.js';

/**
 * 批次/效期维度（M11）：
 *  - 批次分桶：adjust 按批次入账（缺省 DEFAULT 虚拟批次）、效期一致性校验
 *  - 出库批次守卫：指定批次他桶不救；不指定只扣 DEFAULT（真批次不动）
 *  - 单据行批次：入库行声明批次/效期、四段行键多行、收货效期冲突 fail-fast
 *  - 移库按批次；query 批次下钻；临期查询（阈值/daysLeft/排除无效期桶）
 *  - replay 重建一致；老库收敛（M10 结构 → 整组 DROP 重建 → DEFAULT 批次）；
 *    混合版本（M10 形态事件 → 投影兜底）
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-batch');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'B-02' });
});

afterEach(() => {
  core.close();
});

/** 按编码查余量（库位/批次缺省 DEFAULT 桶） */
function qty(skuCode: string, locationCode = DEFAULT_LOCATION_ID, batchNo = DEFAULT_BATCH_NO): number {
  const skuId = ws.skus.byCode(skuCode)!.id;
  const locationId =
    locationCode === DEFAULT_LOCATION_ID ? DEFAULT_LOCATION_ID : ws.locations.byCode(locationCode)!.id;
  return ws.inventory.quantityOf(skuId, locationId, batchNo);
}

function skuIdOf(code: string): string {
  return ws.skus.byCode(code)!.id;
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

/** 相对今天偏移 N 天的 UTC 日期（构造批次效期用） */
function dateOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function createOrder(
  direction: 'in' | 'out',
  lines: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string; batchExpiryDate?: string }[],
): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', { direction, lines })) as { orderNo: string };
  return r.orderNo;
}

describe('批次分桶与效期', () => {
  it('adjust 指定批次+效期入账；query 平铺行带批次与效期', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      locationCode: 'A-01',
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });
    expect(qty('A-1', 'A-01', 'B1')).toBe(10);

    const flat = (await ws.tools.invoke('wms.inventory.query', { locationCode: 'A-01' })) as {
      skuCode: string;
      batchNo: string;
      batchExpiryDate: string | null;
      quantity: number;
    }[];
    expect(flat).toEqual([
      {
        skuId: expect.any(String),
        skuCode: 'A-1',
        name: '螺丝',
        locationCode: 'A-01',
        locationName: '一号架',
        batchNo: 'B1',
        batchExpiryDate: '2027-06-01',
        quantity: 10,
      },
    ]);
  });

  it('缺省批次落 DEFAULT 虚拟桶（与 M10 行为等价）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 7 });
    expect(qty('A-1', 'DEFAULT', 'DEFAULT')).toBe(7);
    // 旧式两参调用（M10 代码形态）缺省查 DEFAULT 批次——兼容性支点
    expect(ws.inventory.quantityOf(skuIdOf('A-1'), DEFAULT_LOCATION_ID)).toBe(7);
  });

  it('同 SKU 同批次不同效期拒绝（零事件）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: 5,
        batchNo: 'B1',
        batchExpiryDate: '2027-06-02',
      }),
    ).rejects.toThrow(BatchExpiryMismatchError);
    expect(countEvents()).toBe(before);
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(5);
  });

  it('首条无有效期、后补效期允许（首个非空为准）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, batchNo: 'B1' });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(10);
    expect(ws.inventory.expiryOfBatch(skuIdOf('A-1'), 'B1')).toBe('2027-06-01');
    // 已登记后不带效期放行；不一致仍拒绝
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, batchNo: 'B1' });
    await expect(
      ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: 1,
        batchNo: 'B1',
        batchExpiryDate: '2027-07-01',
      }),
    ).rejects.toThrow(BatchExpiryMismatchError);
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(15);
  });

  it('DEFAULT 虚拟批次不携带效期；出库（负 delta）不支持效期', async () => {
    await expect(
      ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: 5,
        batchNo: 'DEFAULT',
        batchExpiryDate: '2027-06-01',
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    await expect(
      ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: -5,
        batchNo: 'B1',
        batchExpiryDate: '2027-06-01',
      }),
    ).rejects.toThrow('TOOL_REJECTED');
  });

  it('同批次号不同 SKU 互不干扰（作用域 = workspace + SKU）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      batchNo: 'LOT-1',
      batchExpiryDate: '2027-06-01',
    });
    // B-2 的 LOT-1 是另一个批次空间：可声明不同效期
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'B-2',
      delta: 3,
      batchNo: 'LOT-1',
      batchExpiryDate: '2028-01-01',
    });
    expect(ws.inventory.expiryOfBatch(skuIdOf('A-1'), 'LOT-1')).toBe('2027-06-01');
    expect(ws.inventory.expiryOfBatch(skuIdOf('B-2'), 'LOT-1')).toBe('2028-01-01');
  });
});

describe('批次出库守卫（他桶不救）', () => {
  it('指定批次出库成功；他批次纹丝不动；不指定只扣 DEFAULT', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B1' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 6 });

    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -4, batchNo: 'B1' });
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(6);
    expect(qty('A-1', 'DEFAULT', 'DEFAULT')).toBe(6);

    // 不指定批次 → 只扣 DEFAULT 批次（真批次 B1 有货不救）
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -7 })).rejects.toThrow(
      InsufficientStockError,
    );
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(6);
  });

  it('指定批次余量不足拒绝：消息带批次后缀；他批次有货不救', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B1' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B2' });
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -11, batchNo: 'B1' }),
    ).rejects.toThrow('SKU A-1@DEFAULT@B1 库存不足：需出库 11，当前余量 10');
  });

  it('DEFAULT 批次余量不足：错误消息与 M10 逐字节兼容（无批次后缀）', async () => {
    await expect(ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -1 })).rejects.toThrow(
      'SKU A-1@DEFAULT 库存不足：需出库 1，当前余量 0',
    );
  });
});

describe('单据行批次', () => {
  it('入库单行带批次+效期：received 落批次桶、流水带批次与效期', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 10, batchNo: 'B1', batchExpiryDate: '2027-06-01' },
      { skuCode: 'A-1', quantity: 5, locationCode: 'A-01', batchNo: 'B2' },
    ]);
    const r = (await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' })) as {
      adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
    };
    expect(r.adjustedLines).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'B1', delta: 10 },
      { skuCode: 'A-1', locationCode: 'A-01', batchNo: 'B2', delta: 5 },
    ]);
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(10);
    expect(qty('A-1', 'A-01', 'B2')).toBe(5);
    const b1 = ws.inventory.ledgerOf(skuIdOf('A-1')).find((l) => l.batchNo === 'B1')!;
    expect(b1.batchExpiryDate).toBe('2027-06-01');
    expect(b1.orderId).toBeTruthy();
  });

  it('同单同 SKU 同库位不同批次多行（四段行键）；行重复拒绝', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 10, batchNo: 'B1' },
      { skuCode: 'A-1', quantity: 5, batchNo: 'B2' },
    ]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' });
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(10);
    expect(qty('A-1', 'DEFAULT', 'B2')).toBe(5);

    // 同 SKU + 库位 + 批次重复 → 命令侧拒绝（投影唯一约束的四段精化）
    await expect(
      createOrder('in', [
        { skuCode: 'A-1', quantity: 1, batchNo: 'B1' },
        { skuCode: 'A-1', quantity: 2, batchNo: 'B1' },
      ]),
    ).rejects.toThrow('TOOL_REJECTED');
  });

  it('出库行带效期 → TOOL_REJECTED', async () => {
    await expect(
      createOrder('out', [{ skuCode: 'A-1', quantity: 1, batchExpiryDate: '2027-06-01' }]),
    ).rejects.toThrow('TOOL_REJECTED');
  });

  it('出库单行指定批次：shipped 扣指定批次（他批次不救）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B1' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B2' });
    const no = await createOrder('out', [{ skuCode: 'A-1', quantity: 6, batchNo: 'B1' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'shipped' });
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(4);
    expect(qty('A-1', 'DEFAULT', 'B2')).toBe(10);
  });

  it('收货效期冲突 fail-fast：建单后批次被登记了不同效期 → received 拒绝', async () => {
    const no = await createOrder('in', [
      { skuCode: 'A-1', quantity: 10, batchNo: 'B1', batchExpiryDate: '2027-06-01' },
    ]);
    // 建单后、收货前：手动流水给 B1 登记了不同效期（建单 fail-fast 覆盖不到的窗口）
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 1,
      batchNo: 'B1',
      batchExpiryDate: '2027-01-01',
    });
    await expect(ws.tools.invoke('wms.order.transition', { orderNo: no, to: 'received' })).rejects.toThrow(
      BatchExpiryMismatchError,
    );
    // 拒绝发生在落账前：库存未被收货流水污染
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(1);
  });
});

describe('移库与批次', () => {
  it('move 按批次挪位：源扣目标加；不带 batchNo 移 DEFAULT 批次', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      locationCode: 'A-01',
      batchNo: 'B1',
    });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, locationCode: 'A-01' });

    const r = (await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'A-01',
      toLocationCode: 'B-02',
      quantity: 4,
      batchNo: 'B1',
    })) as { batchNo: string; fromBalance: number; toBalance: number };
    expect(r.batchNo).toBe('B1');
    expect(r.fromBalance).toBe(6);
    expect(r.toBalance).toBe(4);
    expect(qty('A-1', 'A-01', 'B1')).toBe(6);
    expect(qty('A-1', 'B-02', 'B1')).toBe(4);
    expect(qty('A-1', 'A-01', 'DEFAULT')).toBe(5); // DEFAULT 批次不动

    // 批次余量不足（他批次不救）
    await expect(
      ws.tools.invoke('wms.inventory.move', {
        skuCode: 'A-1',
        fromLocationCode: 'A-01',
        toLocationCode: 'B-02',
        quantity: 10,
        batchNo: 'B1',
      }),
    ).rejects.toThrow(InsufficientStockError);

    // 不带 batchNo → 移 DEFAULT 批次
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      fromLocationCode: 'A-01',
      toLocationCode: 'B-02',
      quantity: 2,
    });
    expect(qty('A-1', 'A-01', 'DEFAULT')).toBe(3);
    expect(qty('A-1', 'B-02', 'DEFAULT')).toBe(2);
    expect(qty('A-1', 'A-01', 'B1')).toBe(6); // 真批次不动
  });
});

describe('查询与临期', () => {
  it('query 批次下钻：byLocation 内嵌 batches（按批次号排序）', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5, batchNo: 'B2' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 7 });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 8,
      locationCode: 'A-01',
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });

    const g = (await ws.tools.invoke('wms.inventory.query', { skuCode: 'A-1' })) as {
      total: number;
      byLocation: {
        locationCode: string;
        quantity: number;
        batches: { batchNo: string; batchExpiryDate: string | null; quantity: number }[];
      }[];
    };
    expect(g.total).toBe(30);
    const def = g.byLocation.find((l) => l.locationCode === 'DEFAULT')!;
    expect(def.quantity).toBe(22);
    expect(def.batches).toEqual([
      { batchNo: 'B1', batchExpiryDate: '2027-06-01', quantity: 10 },
      { batchNo: 'B2', batchExpiryDate: null, quantity: 5 },
      { batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 7 },
    ]);
    const shelf = g.byLocation.find((l) => l.locationCode === 'A-01')!;
    expect(shelf.batches).toEqual([{ batchNo: 'B1', batchExpiryDate: '2027-06-01', quantity: 8 }]);
  });

  it('expiring 临期查询：阈值过滤、daysLeft、按效期升序；无效期桶排除', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      batchNo: 'OLD',
      batchExpiryDate: dateOffset(-1),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 20,
      batchNo: 'SOON',
      batchExpiryDate: dateOffset(5),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'B-2',
      delta: 30,
      batchNo: 'LATER',
      batchExpiryDate: dateOffset(40),
    });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 40 }); // DEFAULT 无效期
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 50, batchNo: 'NOEXP' }); // 真批次未声明效期

    const rows = (await ws.tools.invoke('wms.inventory.expiring', { days: 30 })) as {
      skuCode: string;
      batchNo: string;
      daysLeft: number;
      quantity: number;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({ skuCode: 'A-1', batchNo: 'OLD', daysLeft: -1, quantity: 10 }),
      expect.objectContaining({ skuCode: 'A-1', batchNo: 'SOON', daysLeft: 5, quantity: 20 }),
    ]);

    const wide = (await ws.tools.invoke('wms.inventory.expiring', { days: 60 })) as { batchNo: string }[];
    expect(wide.map((r) => r.batchNo)).toEqual(['OLD', 'SOON', 'LATER']);
  });
});

describe('追账与老库收敛', () => {
  it('replay() 重建后批次/效期/流水一致', async () => {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 10,
      batchNo: 'B1',
      batchExpiryDate: '2027-06-01',
    });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      toLocationCode: 'A-01',
      quantity: 3,
      batchNo: 'B1',
    });
    ws.replay();
    expect(qty('A-1', 'DEFAULT', 'B1')).toBe(7);
    expect(qty('A-1', 'A-01', 'B1')).toBe(3);
    expect(ws.inventory.expiryOfBatch(skuIdOf('A-1'), 'B1')).toBe('2027-06-01');
    expect(ws.inventory.ledgerOf(skuIdOf('A-1'))).toHaveLength(3); // adjust + move 两条
  });

  it('老库收敛：M10 结构文件库重开 → 投影整组重建，老流水落 DEFAULT 批次', async () => {
    const file = join(tmpdir(), `onewms-m11-conv-${randomUUID()}.db`);
    try {
      // ① 用当前代码在文件库跑出 M10 时代的业务事实（事件进 oplog）
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('ws-batch-conv');
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.location.create', { locationCode: 'A-01' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, locationCode: 'A-01' });
        await w1.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
        core1.close();
      }
      // ② 裸 SQL 模拟 M10 表结构：ledger 去掉批次列（= 迁移检测的特征列）
      {
        const db = new Database(file);
        db.exec('ALTER TABLE wms_inventory_ledger DROP COLUMN batch_no');
        db.close();
      }
      // ③ 重开：migrateWms 检测列缺失 → 六张投影整组 DROP → sync() 全量重建；
      //    老事件批次维度收敛 DEFAULT 批次；单据行/库位同样重建
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('ws-batch-conv');
        const skuId = w2.skus.byCode('A-1')!.id;
        const locId = w2.locations.byCode('A-01')!.id;
        expect(w2.inventory.quantityOf(skuId, locId, 'DEFAULT')).toBe(10);
        expect(w2.inventory.quantityOf(skuId, DEFAULT_LOCATION_ID, 'DEFAULT')).toBe(5);
        expect(w2.inventory.ledgerOf(skuId).every((l) => l.batchNo === 'DEFAULT')).toBe(true);
        // 新批次工具在收敛后的库上照常可用
        await w2.tools.invoke('wms.inventory.adjust', {
          skuCode: 'A-1',
          delta: 3,
          batchNo: 'B2026',
          batchExpiryDate: '2027-01-01',
        });
        expect(w2.inventory.quantityOf(skuId, DEFAULT_LOCATION_ID, 'B2026')).toBe(3);
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('混合版本：M10 形态事件（无批次字段）→ 投影兜底 DEFAULT 批次', async () => {
    const skuId = skuIdOf('A-1');
    const locId = ws.locations.byCode('A-01')!.id;
    // M10 节点的 adjusted 事件：带库位、不带批次字段（反向兼容：M11 事件的
    // batchNo 在 M10 节点被无害忽略——graceful degrade）
    ws.events.append(WMS_EVENT_TYPES.inventoryAdjusted, {
      skuId,
      skuCode: 'A-1',
      delta: 7,
      reason: 'inbound',
      locationId: locId,
      locationCode: 'A-01',
    });
    ws.sync();
    expect(ws.inventory.quantityOf(skuId, locId, DEFAULT_BATCH_NO)).toBe(7);
    const last = ws.inventory.ledgerOf(skuId).at(-1)!;
    expect(last.batchNo).toBe('DEFAULT');
    expect(last.batchExpiryDate).toBeNull();
  });
});

describe('批次分配策略（M12）', () => {
  /**
   * 造数：三个批次桶（首笔时间序 = 批次号字典序 B-1 < B-2 < B-3——同毫秒并列时
   * 分配器按 batchNo 字典序稳定化，命名保证断言确定性，不依赖时钟精度）。
   * 效期：B-2 最近、B-1 较远、B-3 无期（fefo 序 = B-2, B-1, B-3）。
   */
  async function seedThreeBatches(): Promise<void> {
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1', delta: 30, batchNo: 'B-1', batchExpiryDate: dateOffset(60),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1', delta: 20, batchNo: 'B-2', batchExpiryDate: dateOffset(30),
    });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1', delta: 10, batchNo: 'B-3',
    });
  }

  it('fifo：按批次首笔时间序拆行扣减（跨桶凑数，事件行已是具体批次）', async () => {
    await seedThreeBatches();
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 40 }],
      allocation: 'fifo',
    })) as { orderNo: string };

    // 建单即拆行：B-1 全扣 30 + B-2 补 10；事件 payload 行带具体批次（M11 形态同构）
    const order = ws.orders.byNo(r.orderNo)!;
    const lines = ws.orders.lines(order.id);
    expect(lines.map((l) => [l.batchNo, l.quantity])).toEqual([['B-1', 30], ['B-2', 10]]);

    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'shipped' });
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-1')).toBe(0);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-2')).toBe(10);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-3')).toBe(10); // 未轮到，不动
  });

  it('fefo：按效期升序扣减（近效期先出）', async () => {
    await seedThreeBatches();
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 35 }],
      allocation: 'fefo',
    })) as { orderNo: string };

    // fefo 序：B-2（30 天）→ B-1（60 天）；B-2 全扣 20 + B-1 补 15
    const lines = ws.orders.lines(ws.orders.byNo(r.orderNo)!.id);
    expect(lines.map((l) => [l.batchNo, l.quantity])).toEqual([['B-2', 20], ['B-1', 15]]);
  });

  it('fefo：无期批次排最后，段内按首笔时间（含 DEFAULT 桶参与）', async () => {
    // 两个纯无期桶：B-3 先入、DEFAULT 后入（同毫秒并列按字典序 B-3 < DEFAULT，恰与造数序一致）
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 10, batchNo: 'B-3' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 7 });
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 12 }],
      allocation: 'fefo',
    })) as { orderNo: string };

    const lines = ws.orders.lines(ws.orders.byNo(r.orderNo)!.id);
    expect(lines.map((l) => [l.batchNo, l.quantity])).toEqual([['B-3', 10], ['DEFAULT', 2]]);
  });

  it('缺省不传 allocation = M11 严格桶语义（建单不分配，picking 时 DEFAULT 空则拒）', async () => {
    await seedThreeBatches(); // DEFAULT 桶余量 0，B-1/B-2/B-3 共 60
    // 建单成功（建单不预检余量，行批次 = DEFAULT——未被分配改写）
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out', lines: [{ skuCode: 'A-1', quantity: 5 }],
    })) as { orderNo: string };
    const lines = ws.orders.lines(ws.orders.byNo(r.orderNo)!.id);
    expect(lines.map((l) => l.batchNo)).toEqual(['DEFAULT']);

    // 预检在 picking：行桶 = DEFAULT（余量 0），他桶 60 不救 → 拒且零事件
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'picking' }),
    ).rejects.toThrow(InsufficientStockError);
    expect(ws.orders.byNo(r.orderNo)!.state).toBe('created');
    expect(countEvents()).toBe(before);
  });

  it('显式指定批次的行不参与分配（显式优先）', async () => {
    await seedThreeBatches();
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [
        { skuCode: 'A-1', quantity: 5, batchNo: 'B-3' }, // 显式：原样保留
        { skuCode: 'A-1', quantity: 8 }, // 未指定：fifo 分配到首桶 B-1
      ],
      allocation: 'fifo',
    })) as { orderNo: string };
    const lines = ws.orders.lines(ws.orders.byNo(r.orderNo)!.id);
    expect(lines.map((l) => [l.batchNo, l.quantity])).toEqual([['B-3', 5], ['B-1', 8]]);
  });

  it('各批次合计不足 → AllocationInsufficientError，零事件零单', async () => {
    await seedThreeBatches(); // 合计 60
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 100 }],
        allocation: 'fifo',
      }),
    ).rejects.toThrow(AllocationInsufficientError);
    expect(countEvents()).toBe(before);
    expect(ws.orders.list('out')).toHaveLength(0);
  });

  it('分配行与手动行同键 → 四段查重拒绝（请合并数量）', async () => {
    await seedThreeBatches();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [
          { skuCode: 'A-1', quantity: 5, batchNo: 'B-1' }, // 手动 B-1
          { skuCode: 'A-1', quantity: 8 }, // 分配也选中 B-1（fifo 首桶）
        ],
        allocation: 'fifo',
      }),
    ).rejects.toThrow(/重复/);
  });

  it('入库单 + allocation → 拒（入库批次是声明不是分配）', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 5, batchNo: 'B-9' }],
        allocation: 'fifo',
      }),
    ).rejects.toThrow(/allocation 只适用于出库单/);
  });

  it('非法策略值 → schema 校验拒绝（enum 白名单）', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 5 }],
        allocation: 'lifo',
      }),
    ).rejects.toThrow();
  });

  it('分配单全流程：picking 预检 → shipped 逐批次扣减 → replay 重建一致', async () => {
    await seedThreeBatches();
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 45 }],
      allocation: 'fifo', // B-1:30 + B-2:15
    })) as { orderNo: string };
    await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'picking' });
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-1')).toBe(30); // 预检不动账

    const ship = (await ws.tools.invoke('wms.order.transition', {
      orderNo: r.orderNo, to: 'shipped',
    })) as { adjustedLines: { skuCode: string; batchNo: string; delta: number }[] };
    expect(ship.adjustedLines).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'B-1', delta: -30 },
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'B-2', delta: -15 },
    ]);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-1')).toBe(0);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-2')).toBe(5);

    ws.replay();
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-1')).toBe(0);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-2')).toBe(5);
    expect(qty('A-1', DEFAULT_LOCATION_ID, 'B-3')).toBe(10);
  });
});
