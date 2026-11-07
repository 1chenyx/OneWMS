import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { OneCore, ToolValidationError } from '@one/core';
import {
  WmsDomain,
  PartnerAlreadyExistsError,
  PartnerNotFoundError,
  PartnerKindMismatchError,
  listOrdersWithLines,
} from '../src/index.js';

/**
 * 往来单位主数据（M21）——供应商/客户统一实体。
 * 覆盖：工具 CRUD + kind 语义（不可改 / 订单方向匹配）+ 事件落账纪律
 * （拒绝路径零事件）+ replay 重建 + 老库收敛（wms_order 缺 partner_id 检测）。
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

function countWmsEvents(): number {
  let n = 0;
  ws.events.forEach((e) => {
    if (e.type.startsWith('wms.')) n++;
  });
  return n;
}

describe('往来单位：创建与更新', () => {
  it('工具创建供应商 → 事件落账 → 投影可见', async () => {
    const result = await ws.tools.invoke('wms.partner.create', {
      partnerCode: 'SUP-001',
      kind: 'supplier',
      name: '华东五金供应商',
      contact: '王经理',
    });
    expect(result).toMatchObject({ partnerCode: 'SUP-001', kind: 'supplier', name: '华东五金供应商' });

    const partner = ws.partners.byCode('SUP-001')!;
    expect(partner).toBeDefined();
    expect(partner.kind).toBe('supplier');
    expect(partner.contact).toBe('王经理');
    expect(partner.id).toBe((result as { partnerId: string }).partnerId);

    const types: string[] = [];
    ws.events.forEach((e) => {
      if (e.type.startsWith('wms.')) types.push(e.type);
    });
    expect(types).toEqual(['wms.partner.created']);
  });

  it('重复编码 → 拒绝且不产生第二个事件', async () => {
    await ws.tools.invoke('wms.partner.create', {
      partnerCode: 'SUP-001',
      kind: 'supplier',
      name: '供应商甲',
    });
    const baseline = countWmsEvents();
    await expect(
      ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-001', kind: 'supplier', name: '供应商乙' }),
    ).rejects.toThrow(PartnerAlreadyExistsError);

    expect(ws.partners.list()).toHaveLength(1);
    expect(countWmsEvents()).toBe(baseline);
  });

  it('更新字段级 LWW（未传字段保持不变）', async () => {
    await ws.tools.invoke('wms.partner.create', {
      partnerCode: 'CUS-001',
      kind: 'customer',
      name: '旧名称',
      phone: '13800000000',
    });
    await ws.tools.invoke('wms.partner.update', { partnerCode: 'CUS-001', name: '新名称' });

    const partner = ws.partners.byCode('CUS-001')!;
    expect(partner.name).toBe('新名称');
    expect(partner.phone).toBe('13800000000'); // 未传 → 保持
    expect(partner.kind).toBe('customer'); // kind 恒定
  });

  it('更新不存在的往来单位 → PartnerNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.partner.update', { partnerCode: 'ghost', name: 'x' }),
    ).rejects.toThrow(PartnerNotFoundError);
  });

  it('list 可按 kind 过滤（supplier / customer 互不混杂）', async () => {
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', kind: 'supplier', name: '供应商' });
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });

    expect(ws.partners.list()).toHaveLength(2);
    expect(ws.partners.list('supplier').map((p) => p.partnerCode)).toEqual(['SUP-1']);
    expect(ws.partners.list('customer').map((p) => p.partnerCode)).toEqual(['CUS-1']);

    const r = await ws.tools.invoke('wms.partner.list', { kind: 'customer' });
    expect((r as { partners: { partnerCode: string }[] }).partners).toHaveLength(1);
  });

  it('参数校验：缺必填 → ToolValidationError（schema 层拦截）', async () => {
    await expect(
      ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', name: 'x' }),
    ).rejects.toThrow(ToolValidationError);
  });
});

describe('订单关联（入库=供应商 / 出库=客户）', () => {
  beforeEach(async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', kind: 'supplier', name: '供应商' });
    await ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });
  });

  it('入库单关联供应商 → partnerId 落投影 → 联查可见', async () => {
    const r = await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
      partnerCode: 'SUP-1',
    });
    const orderNo = (r as { orderNo: string }).orderNo;

    const order = ws.orders.byNo(orderNo)!;
    const partner = ws.partners.byCode('SUP-1')!;
    expect(order.partnerId).toBe(partner.id);

    const withLines = listOrdersWithLines(ws)[0];
    expect(withLines.partnerCode).toBe('SUP-1');
    expect(withLines.partnerName).toBe('供应商');
  });

  it('方向不匹配 → PartnerKindMismatchError，拒绝路径零事件', async () => {
    const baseline = countWmsEvents();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
        partnerCode: 'CUS-1', // 入库单只能关联供应商
      }),
    ).rejects.toThrow(PartnerKindMismatchError);
    expect(countWmsEvents()).toBe(baseline);
  });

  it('关联不存在的编码 → PartnerNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
        partnerCode: 'ghost',
      }),
    ).rejects.toThrow(PartnerNotFoundError);
  });

  it('不关联 → partnerId = null（老单据兼容）', async () => {
    const r = await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    const orderNo = (r as { orderNo: string }).orderNo;
    expect(ws.orders.byNo(orderNo)!.partnerId).toBeNull();
  });

  it('replay 重建一致（partner 关联随事件恢复）', async () => {
    const r = await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
      partnerCode: 'SUP-1',
    });
    const orderNo = (r as { orderNo: string }).orderNo;
    const before = ws.orders.byNo(orderNo)!.partnerId;

    ws.replay();
    expect(ws.orders.byNo(orderNo)!.partnerId).toBe(before);
    expect(ws.partners.byCode('SUP-1')).toBeDefined();
  });
});

describe('老库收敛（M21 第四道检测）', () => {
  it('wms_order 缺 partner_id 列 → 文件库重开 → 只重建单据，partnerId 完整恢复', async () => {
    const file = join(tmpdir(), `onewms-m21-conv-${randomUUID()}.db`);
    try {
      // ① 当前代码跑出 M20 时代的业务事实（事件进 oplog）
      {
        const core1 = OneCore.open(file);
        const d1 = WmsDomain.attach(core1);
        const w1 = d1.workspace('ws-partner-conv');
        await w1.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', kind: 'supplier', name: '供应商' });
        await w1.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await w1.tools.invoke('wms.order.create', {
          direction: 'in',
          lines: [{ skuCode: 'A-1', quantity: 10 }],
          partnerCode: 'SUP-1',
        });
        core1.close();
      }
      // ② 裸 SQL 模拟 M20 表结构：wms_order 整表重建为无 partner_id 的形态
      {
        const db = new Database(file);
        try {
          db.exec(`
            ALTER TABLE wms_order RENAME TO wms_order_legacy;
            CREATE TABLE wms_order (
              id           TEXT NOT NULL PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              order_no     TEXT NOT NULL,
              direction    TEXT NOT NULL,
              state        TEXT NOT NULL,
              note         TEXT,
              ext_data     TEXT NOT NULL DEFAULT '{}',
              created_at   TEXT NOT NULL,
              updated_at   TEXT NOT NULL,
              UNIQUE (workspace_id, order_no)
            );
            INSERT INTO wms_order (id, workspace_id, order_no, direction, state, note, ext_data, created_at, updated_at)
            SELECT id, workspace_id, order_no, direction, state, note, ext_data, created_at, updated_at FROM wms_order_legacy;
            DROP TABLE wms_order_legacy;
            INSERT INTO wms_inventory (workspace_id, sku_id, location_id, batch_no, quantity)
            SELECT workspace_id, id, 'SENTINEL-BUCKET', 'DEFAULT', 99 FROM wms_sku LIMIT 1;
          `);
        } finally {
          db.close();
        }
      }
      // ③ 重开：缺 partner_id → 单据头和行一起丢再重放。事件里的 partnerId 恢复。
      //    没事件的库存桶必须还在。
      {
        const core2 = OneCore.open(file);
        const d2 = WmsDomain.attach(core2);
        const w2 = d2.workspace('ws-partner-conv');
        const partner = w2.partners.byCode('SUP-1')!;
        expect(partner).toBeDefined();
        const order = w2.orders.list('in')[0];
        expect(order.partnerId).toBe(partner.id);
        const sku = w2.skus.byCode('A-1')!;
        expect(w2.inventory.quantityOf(sku.id, 'SENTINEL-BUCKET', 'DEFAULT')).toBe(99);
        core2.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
  });
});
