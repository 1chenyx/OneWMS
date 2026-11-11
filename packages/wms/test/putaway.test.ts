import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore, type PatchOp } from '@one/core';
import {
  WmsDomain,
  InvalidTransitionError,
  PutawayRequiredError,
  PutawayLineNotFoundError,
  PutawayOnlyInboundError,
  PutawayQuantityError,
  PutawaySourceShortError,
} from '../src/index.js';

/**
 * 上架（M21，module.putaway）——「流程可配置」的第一个真实模块消费。
 * 覆盖：模块安装贡献状态 + when 过滤（停用 → 转移不可达，回到老流程）/
 * 无 targets 纯确认 / 带 targets 归位流水（± 对，批次效期保留）/
 * 守卫拒绝（源桶不足、行未匹配、出库单）零事件 / replay 重建 /
 * 通用 transition 对 putaway 的兼容（无效应步骤）。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;
const tmpDirs: string[] = [];

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-putaway');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: 'A 区 01 货架' });
});

afterEach(() => {
  core.close();
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** 走慢通道改模块/流程（propose → confirm——用户改配置的真实路径） */
function applyPatch(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, 'M21 上架测试');
  ws.profile.confirm(proposalId, 'user:tester');
}

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

/** 建入库单并收货：返回单号（收货后库存落在 DEFAULT 库位 DEFAULT 批次） */
async function receivedOrder(batchNo?: string): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'in',
    lines: [{ skuCode: 'A-1', quantity: 10, ...(batchNo ? { batchNo } : {}) }],
  })) as { orderNo: string };
  await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
  return r.orderNo;
}

describe('上架：模块安装与流程贡献', () => {
  it('构造即安装：inbound 含 putaway 状态（providedBy）+ 两条转移（when 过滤后活跃）', () => {
    const snapshot = ws.profile.getSnapshot();
    expect(snapshot.modules['module.putaway']).toMatchObject({ enabled: true, version: '0.1.0' });
    const inbound = snapshot.workflows.inbound;
    expect(inbound.states.find((s) => s.id === 'putaway')?.providedBy).toBe('module.putaway');
    expect(inbound.transitions).toEqual(
      expect.arrayContaining([
        { from: 'received', to: 'putaway', when: 'module.putaway.enabled', providedBy: 'module.putaway' },
        { from: 'putaway', to: 'done', providedBy: 'module.putaway' },
      ]),
    );
  });

  it('启用时已收货不能直接完成，上架后才能结束', async () => {
    const orderNo = await receivedOrder();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })).rejects.toThrow(
      InvalidTransitionError,
    );
    await ws.tools.invoke('wms.order.putaway', { orderNo });
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('done');
  });

  it('上架开着时，即使收货直接完成没有条件，也不能完成', async () => {
    const inbound = ws.profile.getSnapshot().workflows.inbound!;
    const transitions = inbound.transitions.map((edge) => {
      if (edge.from !== 'received' || edge.to !== 'done') return edge;
      const { when: _when, ...rest } = edge;
      return rest;
    });
    applyPatch([{ op: 'replace', path: '/workflows/inbound/transitions', value: transitions }]);
    const orderNo = await receivedOrder();
    await expect(ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })).rejects.toThrow(
      PutawayRequiredError,
    );
    expect(ws.orders.byNo(orderNo)!.state).toBe('received');
  });

  it('老库打开时给收货直接完成补上开关，再开一次不再改版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onewms-putaway-gate-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = OneCore.open(dbPath);
    const ws1 = WmsDomain.attach(first).workspace('ws-old');
    const legacy = ws1.profile.getSnapshot().workflows.inbound!.transitions.map((edge) => {
      if (edge.from === 'received' && edge.to === 'done') {
        const { when: _when, ...rest } = edge;
        return rest;
      }
      return edge;
    });
    const proposed = ws1.profile.propose(
      'user:tester',
      [{ op: 'replace', path: '/workflows/inbound/transitions', value: legacy }],
      '模拟老库',
    );
    ws1.profile.confirm(proposed.proposalId, 'user:tester');
    const version = ws1.profile.getSnapshot().version;
    first.close();

    const second = OneCore.open(dbPath);
    const ws2 = WmsDomain.attach(second).workspace('ws-old');
    expect(ws2.profile.getSnapshot().workflows.inbound!.transitions.find((edge) => edge.from === 'received' && edge.to === 'done')?.when).toBe(
      '!module.putaway.enabled',
    );
    expect(ws2.profile.getSnapshot().version).toBe(version + 1);
    second.close();

    const third = OneCore.open(dbPath);
    const ws3 = WmsDomain.attach(third).workspace('ws-old');
    expect(ws3.profile.getSnapshot().version).toBe(version + 1);
    third.close();
  });

  it('停用模块 → received→putaway 被 when 过滤（转移非法）；重新启用 → 恢复', async () => {
    const orderNo = await receivedOrder();
    applyPatch([{ op: 'replace', path: '/modules/module.putaway/enabled', value: false }]);

    await expect(
      ws.tools.invoke('wms.order.putaway', { orderNo }),
    ).rejects.toThrow(InvalidTransitionError);
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'putaway' }),
    ).rejects.toThrow(InvalidTransitionError);
    // 老流程原样可用：received → done 直达不受影响
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('done');
  });
});

describe('上架：确认与归位', () => {
  it('无 targets = 纯确认（只有状态事件，库存不动）', async () => {
    const orderNo = await receivedOrder();
    const sku = ws.skus.byCode('A-1')!;
    const before = ws.inventory.quantityOf(sku.id, 'DEFAULT', 'DEFAULT');

    const r = (await ws.tools.invoke('wms.order.putaway', { orderNo })) as {
      from: string;
      to: string;
      movedLines: unknown;
    };
    expect(r).toMatchObject({ orderNo, from: 'received', to: 'putaway' });
    expect(r.movedLines).toBeUndefined();
    expect(ws.orders.byNo(orderNo)!.state).toBe('putaway');
    expect(ws.inventory.quantityOf(sku.id, 'DEFAULT', 'DEFAULT')).toBe(before);
  });

  it('带 targets 归位：一对 ± 流水（批次效期保留），目标桶可查', async () => {
    const orderNo = await receivedOrder('B-2026');
    const sku = ws.skus.byCode('A-1')!;

    const r = (await ws.tools.invoke('wms.order.putaway', {
      orderNo,
      targets: [{ skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'A-01' }],
    })) as { movedLines: { toLocationCode: string; quantity: number }[] };

    expect(r.movedLines).toEqual([{ skuCode: 'A-1', batchNo: 'B-2026', fromLocationCode: 'DEFAULT', toLocationCode: 'A-01', quantity: 10 }]);
    // 源桶清零、目标桶满额、批次效期保留
    const a01 = ws.locations.byCode('A-01')!.id;
    expect(ws.inventory.quantityOf(sku.id, 'DEFAULT', 'B-2026')).toBe(0);
    expect(ws.inventory.quantityOf(sku.id, a01, 'B-2026')).toBe(10);
    expect(ws.orders.byNo(orderNo)!.state).toBe('putaway');
    // putaway → done 收尾（收货已入账，done 无再效应）
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
    expect(ws.inventory.quantityOf(sku.id, a01, 'B-2026')).toBe(10);
  });

  it('通用 transition 到 putaway 天然兼容（无效应步骤，不调专用工具）', async () => {
    const orderNo = await receivedOrder();
    const r = (await ws.tools.invoke('wms.order.transition', { orderNo, to: 'putaway' })) as {
      from: string;
      to: string;
    };
    expect(r).toEqual({ orderNo, from: 'received', to: 'putaway', adjustedLines: undefined });
  });

  it('replay 重建一致（状态 + 归位后的库存分布）', async () => {
    const orderNo = await receivedOrder('B-R');
    await ws.tools.invoke('wms.order.putaway', {
      orderNo,
      targets: [{ skuCode: 'A-1', batchNo: 'B-R', toLocationCode: 'A-01' }],
    });

    ws.replay();
    const sku = ws.skus.byCode('A-1')!;
    const a01 = ws.locations.byCode('A-01')!.id;
    expect(ws.orders.byNo(orderNo)!.state).toBe('putaway');
    expect(ws.inventory.quantityOf(sku.id, a01, 'B-R')).toBe(10);
    expect(ws.inventory.quantityOf(sku.id, 'DEFAULT', 'B-R')).toBe(0);
  });
});

describe('上架：守卫（拒绝路径零事件）', () => {
  it('源桶余量不足（收货后被挪用）→ 拒绝且不落事件', async () => {
    const orderNo = await receivedOrder();
    const sku = ws.skus.byCode('A-1')!;
    // 收货后把 DEFAULT 桶挪走（移库到 A-01）
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: -10, reason: 'test' });
    const baseline = countEvents();

    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo,
        targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
      }),
    ).rejects.toThrow(PutawaySourceShortError);
    expect(countEvents()).toBe(baseline);
    expect(ws.orders.byNo(orderNo)!.state).toBe('received');
  });

  it('target 匹配不到入库单行（库位/批次不对）→ PutawayLineNotFoundError', async () => {
    const orderNo = await receivedOrder();
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo,
        targets: [{ skuCode: 'A-1', batchNo: 'B-NOPE', toLocationCode: 'A-01' }],
      }),
    ).rejects.toThrow(PutawayLineNotFoundError);
  });

  it('出库单调上架 → PutawayOnlyInboundError', async () => {
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 1 });
    const r = (await ws.tools.invoke('wms.order.create', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    await expect(ws.tools.invoke('wms.order.putaway', { orderNo: r.orderNo })).rejects.toThrow(
      PutawayOnlyInboundError,
    );
  });

  it('一行可以分到多个库位，没分走的留在收货库位', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: 'B 区 02' });
    const orderNo = await receivedOrder('B-2026');
    const sku = ws.skus.byCode('A-1')!;
    const r = (await ws.tools.invoke('wms.order.putaway', {
      orderNo,
      targets: [
        { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'A-01', quantity: 6 },
        { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'B-02', quantity: 3 },
      ],
    })) as { movedLines: { toLocationCode: string; quantity: number }[] };
    expect(r.movedLines).toEqual([
      { skuCode: 'A-1', batchNo: 'B-2026', fromLocationCode: 'DEFAULT', toLocationCode: 'A-01', quantity: 6 },
      { skuCode: 'A-1', batchNo: 'B-2026', fromLocationCode: 'DEFAULT', toLocationCode: 'B-02', quantity: 3 },
    ]);
    expect(ws.inventory.quantityOf(sku.id, 'DEFAULT', 'B-2026')).toBe(1);
    expect(ws.inventory.quantityOf(sku.id, ws.locations.byCode('A-01')!.id, 'B-2026')).toBe(6);
    expect(ws.inventory.quantityOf(sku.id, ws.locations.byCode('B-02')!.id, 'B-2026')).toBe(3);
    expect(ws.orders.byNo(orderNo)!.state).toBe('putaway');
  });

  it('分到多处却不写数量，或合计超过本行，拒绝且零事件', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: 'B 区 02' });
    const orderNo = await receivedOrder('B-2026');
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo,
        targets: [
          { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'A-01' },
          { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'B-02' },
        ],
      }),
    ).rejects.toThrow(PutawayQuantityError);
    await expect(
      ws.tools.invoke('wms.order.putaway', {
        orderNo,
        targets: [
          { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'A-01', quantity: 8 },
          { skuCode: 'A-1', batchNo: 'B-2026', toLocationCode: 'B-02', quantity: 4 },
        ],
      }),
    ).rejects.toThrow(PutawayQuantityError);
    expect(countEvents()).toBe(before);
    expect(ws.orders.byNo(orderNo)!.state).toBe('received');
  });
});
