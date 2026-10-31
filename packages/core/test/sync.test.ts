import { describe, it, expect } from 'vitest';
import { OneCore, computePullPlan, type Watermarks } from '../src/index.js';

/**
 * 同步协议测试（DESIGN §8.5 拉模型回合，里程碑 5）：
 *  - computePullPlan 纯函数：水位差 → 拉取区间的各分支；
 *  - 双内核互拉收敛：握手 → 计划 → 分页拉取 → 幂等摄入 → 水位/计数/全序/投影一致。
 * core 层直连（不经 HTTP）——传输层的测试在 @one/server。
 */

const WS = 'ws-sync';

/**
 * 模拟一次「to 拉 from」的客户端回合（limit 可注入以测分页）。
 * 与 @one/server 的 runSyncRound 同构：握手 → 计划 → 逐区间分页循环 → 摄入。
 */
function pullRound(from: OneCore, to: OneCore, workspaceId: string, limit = 2) {
  const theirHello = from.sync.handshake(workspaceId);
  const myHello = to.sync.handshake(workspaceId);
  const plan = computePullPlan(myHello.watermarks, theirHello.watermarks);
  let pulled = 0;
  let accepted = 0;
  for (const range of plan) {
    let fromSeq = range.fromSeq;
    for (;;) {
      const page = from.sync.eventsFor(workspaceId, range.actor, fromSeq, limit);
      if (page.events.length === 0) break;
      pulled += page.events.length;
      accepted += to.sync.applyRemote(workspaceId, page.events).accepted;
      fromSeq = page.nextFromSeq;
      if (!page.hasMore) break;
    }
  }
  return { plan, pulled, accepted };
}

describe('computePullPlan（纯函数：水位差 → 拉取区间）', () => {
  it('双方皆空 → 空计划', () => {
    expect(computePullPlan({}, {})).toEqual([]);
  });

  it('对端独有 actor → 从 1 起的全量区间', () => {
    const plan = computePullPlan({}, { 'node-a': { seq: 3, lamport: 3 } });
    expect(plan).toEqual([{ actor: 'node-a', fromSeq: 1, toSeq: 3 }]);
  });

  it('部分落后 → 差额区间', () => {
    const mine: Watermarks = { 'node-a': { seq: 1, lamport: 1 } };
    const plan = computePullPlan(mine, { 'node-a': { seq: 4, lamport: 4 } });
    expect(plan).toEqual([{ actor: 'node-a', fromSeq: 2, toSeq: 4 }]);
  });

  it('不落后（持平或超前）→ 空计划', () => {
    const same: Watermarks = { 'node-a': { seq: 5, lamport: 5 } };
    expect(computePullPlan(same, { 'node-a': { seq: 5, lamport: 5 } })).toEqual([]);
    expect(computePullPlan({ 'node-a': { seq: 7, lamport: 7 } }, same)).toEqual([]);
  });

  it('多 actor：只列落后者，按 actor 字典序输出（确定性）', () => {
    const mine: Watermarks = { 'node-b': { seq: 2, lamport: 2 }, 'node-d': { seq: 2, lamport: 2 } };
    const theirs: Watermarks = {
      'node-d': { seq: 2, lamport: 2 }, // 持平 → 不拉
      'node-c': { seq: 1, lamport: 1 }, // mine 缺失 → mySeq=0 → 拉全量
      'node-a': { seq: 3, lamport: 3 },
    };
    expect(computePullPlan(mine, theirs)).toEqual([
      { actor: 'node-a', fromSeq: 1, toSeq: 3 },
      { actor: 'node-c', fromSeq: 1, toSeq: 1 },
    ]);
  });

  it('水位持平 + 通道指纹不同 → 全量区间（同 actor 分歧检测）；指纹相同或缺失 → 空', () => {
    const mk = (checksum?: string): Watermarks => ({
      'user:local': { seq: 1, lamport: 1, checksum },
    });
    expect(computePullPlan(mk('aaa'), mk('bbb'))).toEqual([
      { actor: 'user:local', fromSeq: 1, toSeq: 1 },
    ]);
    expect(computePullPlan(mk('aaa'), mk('aaa'))).toEqual([]);
    expect(computePullPlan(mk(), mk('bbb'))).toEqual([]); // 本地无指纹（异常态）→ 不触发
  });
});

describe('双节点互拉收敛（拉模型回合）', () => {
  it('A 产生多 actor 事件 → B 按计划分页拉取摄入 → 水位/计数/全序/投影一致', () => {
    const A = OneCore.open(':memory:');
    const B = OneCore.open(':memory:');
    try {
      const wsA = A.workspace(WS);
      // 三个 actor 通道：module:module.spec（provide）、A 自身（默认）、node-third（显式）
      wsA.fields.provide('module.spec', {
        entity: 'sku',
        key: 'material',
        label: '材质',
        dataType: 'string',
        sharing: 'shared',
      });
      wsA.events.append('wms.sku.created', { skuCode: 'A-1' });
      wsA.events.append('wms.sku.created', { skuCode: 'A-2' });
      wsA.events.append('wms.sku.created', { skuCode: 'T-1' }, 'node-third');
      wsA.events.append('config.change', {
        patch: [{ op: 'add', path: '/workflows/custom', value: { states: [{ id: 's1' }], transitions: [] } }],
        profileVersion: 1,
      });

      // ① 握手 + 计划 + 分页拉取（limit=2 强制 A 通道分两页）
      const round = pullRound(A, B, WS, 2);
      expect(round.plan).toHaveLength(3);
      expect(round.pulled).toBe(5);
      expect(round.accepted).toBe(5);

      // ② 收敛：计数/版本/水位与 A 完全一致
      const a = A.sync.handshake(WS);
      const b = B.sync.handshake(WS);
      expect(b.eventCount).toBe(a.eventCount);
      expect(b.profileVersion).toBe(a.profileVersion); // config.change 摄入后 getVersion 追账
      expect(b.watermarks).toEqual(a.watermarks);

      // ③ 全序 (lamport, actor) 逐事件一致（eventId 序列相等）
      const ids = (core: OneCore) => {
        const out: string[] = [];
        core.workspace(WS).events.forEach((e) => out.push(e.eventId));
        return out;
      };
      expect(ids(B)).toEqual(ids(A));

      // ④ 投影一致：replay 全量重建后，注册表与 Profile 两类投影恢复
      const wsB = B.workspace(WS);
      const replay = wsB.replay();
      expect(replay.appliedRegistryEvents).toBe(1);
      expect(replay.appliedConfigEvents).toBe(1);
      expect(wsB.fields.get('sku', 'material')).toBeDefined();
      expect(wsB.profile.getSnapshot().workflows['custom']).toBeDefined();
    } finally {
      A.close();
      B.close();
    }
  });

  it('actor 节点唯一纪律的防线：同 (actor, seq) 跨节点事件被账本唯一约束拒绝', () => {
    // actor 通道必须单写者（@nodeId 后缀，见 ARCHITECTURE.md 同步回合）——
    // 两节点若各自以相同 actor 落账，(actor, seq) 在账本唯一约束上撞车即失败，
    // 快速暴露违反纪律的装配，而不是静默漏数据
    const A = OneCore.open(':memory:');
    const B = OneCore.open(':memory:');
    try {
      A.workspace(WS).events.append('wms.sku.created', { skuCode: 'A-1' }, 'user:local');
      B.workspace(WS).events.append('wms.sku.created', { skuCode: 'B-1' }, 'user:local');
      const events = A.sync.eventsFor(WS, 'user:local', 0, 500).events;
      expect(() => B.sync.applyRemote(WS, events)).toThrow(/UNIQUE/);
    } finally {
      A.close();
      B.close();
    }
  });

  it('幂等重拉：水位追平后计划为空；强制重拉同批事件全部跳过', () => {
    const A = OneCore.open(':memory:');
    const B = OneCore.open(':memory:');
    try {
      A.workspace(WS).events.append('wms.sku.created', { skuCode: 'A-1' });
      const first = pullRound(A, B, WS);
      expect(first.accepted).toBe(1);

      // 计划为空（no-op 的数据源）
      const plan = computePullPlan(B.sync.handshake(WS).watermarks, A.sync.handshake(WS).watermarks);
      expect(plan).toEqual([]);

      // 即便把同一批事件再喂一遍（网络重试/重复投递）→ eventId 查重全跳过
      const again = B.sync.applyRemote(WS, A.sync.eventsFor(WS, A.nodeId, 0, 500).events);
      expect(again).toEqual({ accepted: 0, skipped: 1 });
      expect(B.sync.handshake(WS).eventCount).toBe(1);
    } finally {
      A.close();
      B.close();
    }
  });

  it('跨工作区事件拒绝摄入（协议违约，不落账）', () => {
    const A = OneCore.open(':memory:');
    const B = OneCore.open(':memory:');
    try {
      A.workspace('ws-a').events.append('wms.sku.created', { skuCode: 'A-1' });
      const events = A.sync.eventsFor('ws-a', A.nodeId, 0, 500).events;
      expect(() => B.sync.applyRemote('ws-b', events)).toThrow(/跨工作区/);
      expect(B.sync.handshake('ws-b').eventCount).toBe(0);
    } finally {
      A.close();
      B.close();
    }
  });

  it('分页游标：nextFromSeq / hasMore 语义；未知 actor 空结果', () => {
    const A = OneCore.open(':memory:');
    try {
      const wsA = A.workspace(WS);
      wsA.events.append('wms.sku.created', { skuCode: 'A-1' });
      wsA.events.append('wms.sku.created', { skuCode: 'A-2' });
      wsA.events.append('wms.sku.created', { skuCode: 'A-3' });

      const page1 = A.sync.eventsFor(WS, A.nodeId, 0, 2);
      expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(page1.nextFromSeq).toBe(3); // 下一页闭起点 = 末条 seq+1
      expect(page1.hasMore).toBe(true);

      const page2 = A.sync.eventsFor(WS, A.nodeId, page1.nextFromSeq, 2);
      expect(page2.events.map((e) => e.seq)).toEqual([3]);
      expect(page2.hasMore).toBe(false);

      const unknown = A.sync.eventsFor(WS, 'node-ghost', 0, 2);
      expect(unknown.events).toEqual([]);
      expect(unknown.nextFromSeq).toBe(0);
      expect(unknown.hasMore).toBe(false);
    } finally {
      A.close();
    }
  });
});
