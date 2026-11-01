import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';

/**
 * 端到端：字段注册 → AI 工具调用 → 事件账本 → 重放重建，全链路一致。
 * 同时覆盖：多工作区隔离、文件库重开（节点身份 + 投影追账）。
 */

const dbFiles: string[] = [];
afterEach(() => {
  for (const f of dbFiles.splice(0)) rmSync(f, { force: true });
});

describe('端到端全链路', () => {
  it('AI 角色走完一笔入库：注册扩展字段 → 工具建 SKU → 建单 → 收货 → 上架 → replay 重建一致', async () => {
    const core = OneCore.open(':memory:');
    const domain = WmsDomain.attach(core);
    const ws = domain.workspace('ws-e2e');
    const AI = 'ai:glm-test';

    // ① 字段注册表声明扩展字段（个性化配置的口子）
    ws.fields.provide('module.spec', {
      entity: 'sku',
      key: 'material',
      label: '材质',
      dataType: 'string',
      sharing: 'shared',
    });
    expect(ws.fields.get('sku', 'material')!.owner).toBe('module.spec');

    // ② AI 以 actor 身份经工具总线完成业务（AI 拿不到 SQL，只有工具）
    await ws.tools.invoke(
      'wms.sku.create',
      { skuCode: 'A-1001', name: '轴承', extData: { material: 'GCr15' } },
      AI,
    );
    const order = (await ws.tools.invoke(
      'wms.order.create',
      { direction: 'in', lines: [{ skuCode: 'A-1001', quantity: 200 }] },
      AI,
    )) as { orderNo: string; orderId: string };
    // M9 单据→库存联动：received 即按明细自动上架（无需手动 adjust）
    const received = (await ws.tools.invoke(
      'wms.order.transition',
      { orderNo: order.orderNo, to: 'received' },
      AI,
    )) as { adjustedLines: { skuCode: string; locationCode: string; delta: number }[] };
    expect(received.adjustedLines).toEqual([
      { skuCode: 'A-1001', locationCode: 'DEFAULT', batchNo: 'DEFAULT', delta: 200 },
    ]);
    await ws.tools.invoke('wms.order.transition', { orderNo: order.orderNo, to: 'done' }, AI);

    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1001')!.id)).toBe(200);

    // ③ 事件账本：全部 wms.* + registry.* 事件，AI 的 actor 可审计
    const actors = new Set<string>();
    const types: string[] = [];
    ws.events.forEach((e) => {
      actors.add(e.actor);
      types.push(e.type);
    });
    expect(actors.has(AI)).toBe(true);
    expect(types.filter((t) => t.startsWith('wms.')).length).toBe(5); // sku.created + order.created + 2×state_changed + 联动 inventory.adjusted（M9）

    // ④ 领域重放：清空投影全量重建 → 与重放前完全一致
    const before = {
      sku: ws.skus.byCode('A-1001'),
      order: ws.orders.byNo(order.orderNo),
      lines: ws.orders.lines(order.orderId),
      qty: ws.inventory.quantityOf(ws.skus.byCode('A-1001')!.id),
    };
    const replay1 = ws.replay();
    expect(replay1.appliedWmsEvents).toBe(5);
    expect(ws.skus.byCode('A-1001')).toEqual(before.sku);
    expect(ws.orders.byNo(order.orderNo)).toEqual(before.order);
    expect(ws.orders.lines(order.orderId)).toEqual(before.lines);
    expect(ws.inventory.quantityOf(before.sku!.id)).toBe(before.qty);

    // ⑤ 内核重放（字段注册表）与领域重放互不干扰，可各自独立执行
    expect(() => core.workspace('ws-e2e').replay()).not.toThrow();
    expect(ws.skus.byCode('A-1001')).toEqual(before.sku);

    // ⑥ 幂等：replay 再来一次，结果不变
    ws.replay();
    expect(ws.inventory.quantityOf(before.sku!.id)).toBe(before.qty);
    core.close();
  });

  it('投影被外部篡改 → replay() 修正（投影是缓存，事件才是真相）', async () => {
    const core = OneCore.open(':memory:');
    const domain = WmsDomain.attach(core);
    const ws = domain.workspace('ws-tamper');

    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 50 });

    // 绕过工具直接改库（模拟损坏/误操作）
    core.exposeDb().prepare(`UPDATE wms_inventory SET quantity = 99999 WHERE 1=1`).run();

    ws.replay();
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(50);
    core.close();
  });

  it('两层投影同时被篡改 → replayAll() 一次修正（M5 同步回合后的重建入口）', async () => {
    const core = OneCore.open(':memory:');
    const domain = WmsDomain.attach(core);
    const ws = domain.workspace('ws-replay-all');

    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x', extData: { spec: 'M6' } });
    const material = ws.fields.get('sku', 'spec')!; // 构造期种子字段（内核投影）

    // 内核（field_registry）与领域（wms_sku）两层同时绕过命令通道篡改
    const db = core.exposeDb();
    db.prepare(`UPDATE field_registry SET visible = 0 WHERE 1=1`).run();
    db.prepare(`UPDATE wms_sku SET name = '被篡改' WHERE 1=1`).run();
    expect(ws.fields.get('sku', 'spec')!.visible).toBe(false);

    // 一次调用修正两层：注册表可见性恢复、SKU 名称恢复
    const result = ws.replayAll();
    expect(result.core.appliedRegistryEvents).toBeGreaterThan(0);
    expect(result.wms.appliedWmsEvents).toBeGreaterThan(0);
    expect(ws.fields.get('sku', 'spec')!.visible).toBe(true);
    expect(ws.fields.get('sku', 'spec')!.qualifiedKey).toBe(material.qualifiedKey);
    expect(ws.skus.byCode('A-1')!.name).toBe('x');
    core.close();
  });

  it('多工作区隔离：SKU / 库存 / 单据互不可见', async () => {
    const core = OneCore.open(':memory:');
    const domain = WmsDomain.attach(core);
    const a = domain.workspace('ws-a');
    const b = domain.workspace('ws-b');
    const baselineA = a.events.count(); // 构造期种子事件之后
    const baselineB = b.events.count();

    await a.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '甲区' });
    await a.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
    await b.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '乙区' }); // 同编码，不同工作区，合法

    expect(a.skus.byCode('A-1')!.name).toBe('甲区');
    expect(b.skus.byCode('A-1')!.name).toBe('乙区');
    expect(a.inventory.list()).toHaveLength(1);
    expect(b.inventory.list()).toHaveLength(0);
    expect(a.events.count()).toBe(baselineA + 2);
    expect(b.events.count()).toBe(baselineB + 1);
    core.close();
  });

  it('文件库重开：节点身份保持、领域投影构造期全量追账', async () => {
    const file = join(tmpdir(), `onewms-e2e-${randomUUID()}.db`);
    dbFiles.push(file);

    // 第一段：写入业务后关闭
    let core = OneCore.open(file);
    WmsDomain.attach(core).workspace('ws-file');
    let ws = WmsDomain.attach(core).workspace('ws-file');
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 8 });
    const nodeId = core.nodeId;
    core.close();

    // 第二段：重开同一文件——不重放、不修复，直接读
    core = OneCore.open(file);
    expect(core.nodeId).toBe(nodeId); // 节点身份持久
    ws = WmsDomain.attach(core).workspace('ws-file');
    expect(ws.skus.byCode('A-1')!.name).toBe('x'); // 构造期追账已重建投影
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(8);

    // 新事件续接
    await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2 });
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id)).toBe(10);
    core.close();
  });
});
