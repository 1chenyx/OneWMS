import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { WmsDomain, InvalidTransitionError, WorkflowNotFoundError } from '../src/index.js';

/**
 * 流程引擎行为闭环测试（里程碑 8，ARCHITECTURE.md「流程引擎行为闭环」）：
 * 转移校验的数据源是 Profile workflows——改配置（config.change）→ 下一次流转立即生效。
 * 既有 orders.test.ts 的默认行为用例 = 种子一致期（默认配置 = ORDER_TRANSITIONS）行为不变的证明。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-wf');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines: [{ skuCode: 'A-1', quantity: 5 }],
  });
});

afterEach(() => {
  core.close();
});

/** 走慢通道改流程（propose → confirm 热应用双轨——AI 改配置的真实路径，§7.3） */
function applyPatch(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, 'M8 流程闭环测试');
  ws.profile.confirm(proposalId, 'user:tester');
}

/** 建一张出库单并返回单号（beforeEach 已建一张，这里按需补建） */
async function newOutOrder(): Promise<string> {
  const r = (await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    lines: [{ skuCode: 'A-1', quantity: 1 }],
  })) as { orderNo: string };
  return r.orderNo;
}

describe('流程引擎行为闭环（配置即权威）', () => {
  it('加转移立即生效：outbound 加 created → done 直达 → 流转成功', async () => {
    const orderNo = await newOutOrder();
    applyPatch([
      { op: 'add', path: '/workflows/outbound/transitions/-', value: { from: 'created', to: 'done' } },
    ]);

    const r = (await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' })) as {
      from: string;
      to: string;
    };
    expect(r).toEqual({ orderNo, from: 'created', to: 'done' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('done');
  });

  it('模块贡献的新状态词汇可流转：quarantine 状态 + created → quarantine 转移 → 生效', async () => {
    const orderNo = await newOutOrder();
    applyPatch([
      { op: 'add', path: '/workflows/outbound/states/-', value: { id: 'quarantine', label: '隔离', providedBy: 'module.demo' } },
      { op: 'add', path: '/workflows/outbound/transitions/-', value: { from: 'created', to: 'quarantine' } },
    ]);

    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'quarantine' });
    expect(ws.orders.byNo(orderNo)!.state).toBe('quarantine');
  });

  it('删转移立即生效：outbound 移除 picking → canceled（取消仅限建单时）→ 拣货中取消被拒且不落事件', async () => {
    const orderNo = await newOutOrder();
    await ws.tools.invoke('wms.order.transition', { orderNo, to: 'picking' });
    const eventCountBefore = countEvents();

    // 去掉 picking→canceled（canceled 仍可从 created 到达——连通性校验通过）
    applyPatch([
      {
        op: 'replace',
        path: '/workflows/outbound/transitions',
        value: [
          { from: 'created', to: 'picking' },
          { from: 'picking', to: 'shipped' },
          { from: 'shipped', to: 'done' },
          { from: 'created', to: 'canceled' },
        ],
      },
    ]);

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'canceled' }),
    ).rejects.toThrow(InvalidTransitionError);
    expect(ws.orders.byNo(orderNo)!.state).toBe('picking');
    expect(countEvents()).toBe(eventCountBefore + 1); // 仅 config.change 一条，零业务事件
  });

  it('整段删除流程 → WMS_WORKFLOW_NOT_FOUND（明确报错，不静默回退硬编码表）', async () => {
    const orderNo = await newOutOrder();
    applyPatch([{ op: 'remove', path: '/workflows/outbound' }]);

    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' }),
    ).rejects.toThrow(WorkflowNotFoundError);
    // 报错信息指向恢复路径（配置确认通道），不 parse message 的 UI 也能靠 code 分支
    try {
      await ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' });
      expect.unreachable();
    } catch (e) {
      expect((e as WorkflowNotFoundError).code).toBe('WMS_WORKFLOW_NOT_FOUND');
    }
  });

  it('默认行为不受影响（对照）：未改配置时 created → done 仍被拒', async () => {
    const orderNo = await newOutOrder();
    await expect(
      ws.tools.invoke('wms.order.transition', { orderNo, to: 'done' }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

/** 当前工作区事件总数（「拒绝不落事件」断言的数据源） */
function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}
