import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import {
  WmsDomain,
  ExpiredBatchError,
  AllocationInsufficientError,
  InsufficientStockError,
  DEFAULT_LOCATION_ID,
} from '../src/index.js';

/**
 * 分配策略设置配置化 + 过期出库拦截（M13）：
 *  - 种子：settings 两键（defaultAllocation / blockExpiredOutbound）从 manifest
 *    default 落进 modules 段；老库（无种子）/ 脏值 → 工具层兜底代码缺省；
 *  - 优先级：order.create 单参数 allocation > settings.defaultAllocation >
 *    代码缺省 strict；全局策略对入库单无感（不分配不报错）；
 *  - 拦截语义：blockExpiredOutbound 开启后单据出库（picking 预检 + shipped
 *    扣减）拒效期早于今日的批次（今天到期 = 临期可出）、fifo/fefo 分配跳过
 *    过期桶（凑不齐走 AllocationInsufficientError）、adjust/move 不拦；
 *  - 改值走慢通道（propose → confirm），下一次建单/流转即时生效。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-alloc');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

/** 慢通道改 core.wms 设置（propose → confirm——配置变更的唯一路径，§7.3） */
function setSettings(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, 'M13 设置测试');
  ws.profile.confirm(proposalId, 'user:tester');
}

/** A-1 在默认库位某批次的余量 */
function qty(batchNo: string): number {
  return ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, DEFAULT_LOCATION_ID, batchNo);
}

/** 相对今天偏移 N 天的 UTC 日期（负数 = 已过期；0 = 今天到期） */
function dateOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** 建批次库存（默认库位） */
async function seed(batchNo: string, quantity: number, expiry?: string): Promise<void> {
  await ws.tools.invoke('wms.inventory.adjust', {
    skuCode: 'A-1',
    delta: quantity,
    batchNo,
    ...(expiry ? { batchExpiryDate: expiry } : {}),
  });
}

/** 建出库单，返回单号 */
async function createOut(
  lines: { skuCode: string; quantity: number; batchNo?: string }[],
  allocation?: 'strict' | 'fifo' | 'fefo',
): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines,
    ...(allocation ? { allocation } : {}),
  })) as { orderNo: string };
  return r.orderNo;
}

/** 单据拆行视图：[批次, 数量][] */
function orderLines(orderNo: string): [string, number][] {
  return ws.orders.lines(ws.orders.byNo(orderNo)!.id).map((l) => [l.batchNo, l.quantity]);
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

describe('设置种子与兜底（M13）', () => {
  it('新库种子：settings 两键 = manifest default（strict / false）', () => {
    expect(ws.profile.getSnapshot().modules['core.wms']?.settings).toEqual({
      defaultAllocation: 'strict',
      blockExpiredOutbound: false,
    });
  });

  it('老库无 settings（remove 模拟 M12 老库）→ 兜底 strict：不传参建单不分配', async () => {
    setSettings([{ op: 'remove', path: '/modules/core.wms/settings' }]);
    await seed('B-1', 10, dateOffset(30));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5 }]);
    expect(orderLines(orderNo)).toEqual([['DEFAULT', 5]]); // 严格桶：行未被改写
    // DEFAULT 桶空、B-1 有货不救 → picking 拒（证明兜底的是 strict）
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' }),
    ).rejects.toThrow(InsufficientStockError);
  });

  it('脏值兜底：defaultAllocation 非法值回落 strict，blockExpiredOutbound 非 true 回落 false', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'lifo' },
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: 'yes' },
    ]);
    await seed('B-OLD', 10, dateOffset(-1));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5 }]);
    expect(orderLines(orderNo)).toEqual([['DEFAULT', 5]]); // strict 兜底：不分配
    // blockExpiredOutbound='yes' ≠ true → 不拦：过期批次显式出库成功
    const orderNo2 = await createOut([{ skuCode: 'A-1', quantity: 5, batchNo: 'B-OLD' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo: orderNo2, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo: orderNo2, to: 'shipped' });
    expect(qty('B-OLD')).toBe(5);
  });
});

describe('全局缺省分配策略（M13）', () => {
  it('全局 fefo：不传 allocation 的出库单按 fefo 拆行（近效期先出）', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fefo' },
    ]);
    await seed('B-1', 30, dateOffset(60));
    await seed('B-2', 20, dateOffset(30));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 25 }]);
    expect(orderLines(orderNo)).toEqual([['B-2', 20], ['B-1', 5]]);
  });

  it('参数 strict 覆盖全局 fefo：严格桶不分配（未指定行 = DEFAULT）', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fefo' },
    ]);
    await seed('B-1', 30, dateOffset(60));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5 }], 'strict');
    expect(orderLines(orderNo)).toEqual([['DEFAULT', 5]]);
  });

  it('参数 fifo 覆盖全局 fefo：按 fifo 序拆行（首笔时间优先，不看效期）', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fefo' },
    ]);
    await seed('B-1', 30, dateOffset(60)); // fifo 首桶（首笔时间在前）
    await seed('B-2', 20, dateOffset(30));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 25 }], 'fifo');
    expect(orderLines(orderNo)).toEqual([['B-1', 25]]);
  });

  it('全局策略对入库单无感：全局 fifo 时建入库单成功且行原样（不分配不报错）', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fifo' },
    ]);
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 5, batchNo: 'B-9', batchExpiryDate: dateOffset(90) }],
    })) as { orderNo: string };
    expect(orderLines(r.orderNo)).toEqual([['B-9', 5]]);
  });

  it('入库单显式传 allocation（含 strict）仍拒：批次是声明不是分配', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 5 }],
        allocation: 'strict',
      }),
    ).rejects.toThrow(/allocation 只适用于出库单/);
  });

  it('慢通道改值即时生效：种子 strict 建单不分配 → 改 fifo 后下一单即按 fifo 拆行', async () => {
    await seed('B-1', 10, dateOffset(60));
    await seed('B-2', 5, dateOffset(30));
    const before = await createOut([{ skuCode: 'A-1', quantity: 3 }]);
    expect(orderLines(before)).toEqual([['DEFAULT', 3]]); // 新库种子 = strict
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fifo' },
    ]);
    const after = await createOut([{ skuCode: 'A-1', quantity: 12 }]);
    expect(orderLines(after)).toEqual([['B-1', 10], ['B-2', 2]]);
  });
});

describe('过期出库拦截（M13）', () => {
  it('拦截开启：显式过期批次 → picking 拒 ExpiredBatchError（code WMS_BATCH_EXPIRED），零事件', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    await seed('B-OLD', 10, dateOffset(-1)); // 昨天到期
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5, batchNo: 'B-OLD' }]);
    const before = countEvents();
    try {
      await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExpiredBatchError);
      expect((e as ExpiredBatchError).code).toBe('WMS_BATCH_EXPIRED');
    }
    expect(ws.orders.byNo(orderNo)!.state).toBe('created');
    expect(countEvents()).toBe(before);
  });

  it('今天到期 = 临期可出（边界）：拦截开启仍正常预检与扣减', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    await seed('B-TODAY', 10, dateOffset(0));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5, batchNo: 'B-TODAY' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' });
    expect(qty('B-TODAY')).toBe(5);
  });

  it('分配跳过过期桶：fefo 序里更早到期的过期货被跳过，未过期桶扣满', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    await seed('B-OLD', 10, dateOffset(-1)); // fefo 序首位，但已过期
    await seed('B-OK', 8, dateOffset(10));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 6 }], 'fefo');
    expect(orderLines(orderNo)).toEqual([['B-OK', 6]]); // 全从 B-OK 扣
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' });
    expect(qty('B-OLD')).toBe(10); // 过期桶不动
    expect(qty('B-OK')).toBe(2);
  });

  it('可用桶全被过滤后凑不齐 → AllocationInsufficientError（不是 ExpiredBatchError）', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    await seed('B-OLD', 10, dateOffset(-1));
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 5 }],
        allocation: 'fefo',
      }),
    ).rejects.toThrow(AllocationInsufficientError);
    expect(countEvents()).toBe(before);
  });

  it('扣减段同样拦截：picking 通过后开启拦截 → shipped 拒，库存不动零事件', async () => {
    await seed('B-OLD', 10, dateOffset(-1));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5, batchNo: 'B-OLD' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' }); // 未开启：预检通过
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' }),
    ).rejects.toThrow(ExpiredBatchError);
    expect(countEvents()).toBe(before);
    expect(qty('B-OLD')).toBe(10); // 扣减未发生
  });

  it('缺省不拦（M12 回归）：blockExpiredOutbound=false 时过期批次照常出库', async () => {
    await seed('B-OLD', 10, dateOffset(-1));
    const orderNo = await createOut([{ skuCode: 'A-1', quantity: 5, batchNo: 'B-OLD' }]);
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'shipped' });
    expect(qty('B-OLD')).toBe(5);
  });

  it('只拦单据出库：拦截开启时 adjust 负数与 move 移动过期批次不受影响', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true },
    ]);
    await seed('B-OLD', 10, dateOffset(-1));
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -4, batchNo: 'B-OLD' }); // 报损出账
    expect(qty('B-OLD')).toBe(6);
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01' });
    await ws.tools.invoke('wms.inventory.move', {
      skuCode: 'A-1',
      quantity: 6,
      batchNo: 'B-OLD',
      toLocationCode: 'A-01',
    });
    expect(qty('B-OLD')).toBe(0);
    expect(
      ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, ws.locations.byCode('A-01')!.id, 'B-OLD'),
    ).toBe(6);
  });
});
