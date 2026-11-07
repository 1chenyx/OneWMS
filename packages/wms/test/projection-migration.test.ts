import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { OneCore } from '@one/core';
import { WmsDomain, listInventorySummary, listInventorySummaryPage, listOrdersWithLinesPage } from '../src/index.js';

function removeDb(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Windows 上 sqlite 句柄可能要等进程退出才放得开。
  }
}

describe('投影增量迁移', () => {
  it('文件库重开：已入账的转移不再被记成冲突', async () => {
    const file = join(tmpdir(), `onewms-reopen-${randomUUID()}.db`);
    try {
      {
        const core = OneCore.open(file);
        const ws = WmsDomain.attach(core).workspace('w');
        await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        const r = (await ws.tools.invoke('wms.order.create', {
          direction: 'in',
          lines: [{ skuCode: 'A-1', quantity: 5 }],
        })) as { orderNo: string };
        await ws.tools.invoke('wms.order.transition', { orderNo: r.orderNo, to: 'received' });
        core.close();
      }
      {
        const core = OneCore.open(file);
        const ws = WmsDomain.attach(core).workspace('w');
        expect(ws.orders.list('in')[0]!.state).toBe('received');
        expect(ws.orders.listConflicts('open')).toHaveLength(0);
        core.close();
      }
    } finally {
      removeDb(file);
    }
  });

  it('quantity 是 INTEGER 时只搬行表，不丢单据头，也不清掉别的表', async () => {
    const file = join(tmpdir(), `onewms-qty-${randomUUID()}.db`);
    try {
      {
        const core = OneCore.open(file);
        const ws = WmsDomain.attach(core).workspace('w');
        await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
        await ws.tools.invoke('wms.order.create', {
          direction: 'in',
          lines: [{ skuCode: 'A-1', quantity: 4 }],
        });
        core.close();
      }
      {
        const db = new Database(file);
        db.exec(`
          ALTER TABLE wms_order_line RENAME TO wms_order_line_old;
          CREATE TABLE wms_order_line (
            id TEXT NOT NULL PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            sku_id TEXT NOT NULL,
            location_id TEXT NOT NULL,
            batch_no TEXT NOT NULL,
            batch_expiry_date TEXT,
            quantity INTEGER NOT NULL,
            UNIQUE (workspace_id, order_id, sku_id, location_id, batch_no)
          );
          INSERT INTO wms_order_line (
            id, workspace_id, order_id, sku_id, location_id, batch_no, batch_expiry_date, quantity
          )
          SELECT id, workspace_id, order_id, sku_id, location_id, batch_no, batch_expiry_date, quantity
          FROM wms_order_line_old;
          DROP TABLE wms_order_line_old;
          INSERT INTO wms_location (id, workspace_id, location_code, name, created_at, updated_at)
          SELECT 'sentinel-loc', workspace_id, 'SENTINEL', '哨兵库位', created_at, updated_at
          FROM wms_sku LIMIT 1;
        `);
        db.close();
      }
      {
        const core = OneCore.open(file);
        const ws = WmsDomain.attach(core).workspace('w');
        const order = ws.orders.list('in')[0]!;
        expect(order.state).toBe('created');
        const [line] = ws.orders.lines(order.id);
        expect(line!.quantity).toBe(4);
        expect(line!.fulfilledQty).toBeNull();
        expect(ws.locations.byCode('SENTINEL')?.name).toBe('哨兵库位');
        expect(ws.orders.listConflicts('open')).toHaveLength(0);
        core.close();
      }
    } finally {
      removeDb(file);
    }
  });
});

describe('列表 SQL 分页', () => {
  it('SKU / 库位 / 往来单位 / 单据 / 库存汇总按页返回，不传 limit 的全量口径不变', async () => {
    const core = OneCore.open(':memory:');
    try {
      const ws = WmsDomain.attach(core).workspace('w');
      await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝', reorderPoint: 20 });
      await ws.tools.invoke('wms.sku.create', { skuCode: 'B-2', name: '螺母' });
      await ws.tools.invoke('wms.sku.create', { skuCode: 'C-3', name: '垫片' });
      await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号' });
      await ws.tools.invoke('wms.location.create', { locationCode: 'B-02', name: '二号' });
      await ws.tools.invoke('wms.partner.create', { partnerCode: 'SUP-1', kind: 'supplier', name: '供应商' });
      await ws.tools.invoke('wms.partner.create', { partnerCode: 'CUS-1', kind: 'customer', name: '客户' });
      await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 5 });
      await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'B-2', delta: 30 });
      await ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 1 }],
      });
      await ws.tools.invoke('wms.order.create', {
        direction: 'out',
        lines: [{ skuCode: 'B-2', quantity: 2 }],
      });

      const skuPage = ws.skus.listMatchingPage({ includeArchived: true, limit: 2, offset: 0 });
      expect(skuPage.total).toBe(3);
      expect(skuPage.rows.map((s) => s.skuCode)).toEqual(['A-1', 'B-2']);
      const skuNext = ws.skus.listMatchingPage({ includeArchived: true, q: '垫', limit: 10, offset: 0 });
      expect(skuNext.rows.map((s) => s.skuCode)).toEqual(['C-3']);

      const locPage = ws.locations.listPage({ limit: 1, offset: 1 });
      expect(locPage.total).toBe(2);
      expect(locPage.rows.map((l) => l.locationCode)).toEqual(['B-02']);
      expect(ws.locations.list('一号').map((l) => l.locationCode)).toEqual(['A-01']);

      const partnerPage = ws.partners.listMatchingPage({ kind: 'supplier', limit: 10, offset: 0 });
      expect(partnerPage.total).toBe(1);
      expect(partnerPage.rows[0]!.partnerCode).toBe('SUP-1');

      const orders = listOrdersWithLinesPage(ws, { limit: 1, offset: 0 });
      expect(orders.total).toBe(2);
      expect(orders.hasMore).toBe(true);
      expect(orders.rows[0]!.lines).toHaveLength(1);
      const outs = listOrdersWithLinesPage(ws, { direction: 'out', q: 'OUT', limit: 10, offset: 0 });
      expect(outs.total).toBe(1);

      const full = listInventorySummary(ws);
      const paged = listInventorySummaryPage(ws, { limit: 1, offset: 0 });
      expect(paged.total).toBe(full.length);
      expect(paged.rows[0]).toEqual(full[0]);
      expect(paged.hasReserved).toBe(false);
      const low = listInventorySummaryPage(ws, { lowOnly: true, limit: 10, offset: 0 });
      expect(low.rows.map((r) => r.skuCode)).toEqual(['A-1']);
      const one = listInventorySummaryPage(ws, { skuCode: 'B-2', limit: 10, offset: 0 });
      expect(one.rows.map((r) => r.skuCode)).toEqual(['B-2']);
    } finally {
      core.close();
    }
  });
});
