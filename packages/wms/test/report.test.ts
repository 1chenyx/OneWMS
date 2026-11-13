import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { ReportDisabledError, ReportInvalidError, WmsDomain } from '../src/index.js';
import { compileReportQuery } from '../src/reports/run.js';

/**
 * 自定义明细报表：多表只沿主键连接，单据行和流水必须先收窄，
 * 定义进事件账本，重放后还在。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-report');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
  await ws.tools.invoke('wms.partner.create', { partnerCode: 'C-1', kind: 'customer', name: '华东客户' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 4, batchNo: 'B1', reason: '入库' });
  await ws.tools.invoke('wms.inventory.adjust', { skuCode: 'A-1', delta: 2, batchNo: 'B2', reason: '入库' });
  await ws.tools.invoke('wms.order.create', {
    direction: 'out',
    orderNo: 'OUT-1',
    partnerCode: 'C-1',
    lines: [{ skuCode: 'A-1', quantity: 3, batchNo: 'B1' }],
  });
});

afterEach(() => {
  core.close();
});

const orderSection = {
  id: 'lines',
  title: '出库明细',
  grain: 'order_line',
  columns: ['order.orderNo', 'partner.name', 'sku.name', 'line.batchNo', 'line.quantity'],
  filters: [
    { field: 'order.createdAt', op: 'gte', value: '2000-01-01' },
    { field: 'partner.name', op: 'contains', value: '华东' },
  ],
};

describe('报表', () => {
  it('单据行连上客户和商品，不会乘上每个库存桶', async () => {
    const saved = (await ws.tools.invoke('wms.report.save', {
      title: '华东未发',
      note: '给仓管',
      sections: [orderSection],
    })) as { reportId: string };
    const page = ws.reports.run(saved.reportId, 'lines', {}, 50, 0, 200);
    expect(page.rows).toEqual([
      {
        'order.orderNo': 'OUT-1',
        'partner.name': '华东客户',
        'sku.name': '螺丝',
        'line.batchNo': 'B1',
        'line.quantity': 3,
      },
    ]);
    const stock = (await ws.tools.invoke('wms.report.preview', {
      section: {
        id: 'stock',
        title: '库存',
        grain: 'inventory',
        columns: ['sku.skuCode', 'inventory.batchNo', 'inventory.quantity'],
        filters: [{ field: 'sku.skuCode', op: 'eq', value: 'A-1' }],
      },
    })) as { rows: Array<Record<string, unknown>> };
    expect(stock.rows).toHaveLength(2);
  });

  it('按客户和日期从单据表驱动，按商品从单据行走 sku 索引', () => {
    const db = core.exposeDb();
    const byPartner = compileReportQuery(db, 'ws-report', orderSection, [], {}, { limit: 50, offset: 0 });
    expect(byPartner.sql.trimStart().startsWith('SELECT')).toBe(true);
    expect(byPartner.sql).toContain('FROM wms_order AS ord');
    expect(byPartner.sql).toContain('ord.partner_id IN (SELECT id FROM wms_partner');
    expect(byPartner.sql).toContain('ord.created_at >= ?');
    expect(byPartner.sql).not.toContain('wms_inventory AS');

    const bySku = compileReportQuery(
      db,
      'ws-report',
      {
        ...orderSection,
        filters: [{ field: 'sku.skuCode', op: 'eq', value: 'A-1' }],
      },
      [],
      {},
      { limit: 50, offset: 0 },
    );
    expect(bySku.sql).toContain('FROM wms_order_line AS line');
    expect(bySku.sql).toContain('line.sku_id = ?');
  });

  it('流水没有收窄条件就拒绝，带上时间和商品就能看增减', async () => {
    await expect(
      ws.tools.invoke('wms.report.save', {
        title: '全部流水',
        sections: [
          {
            id: 'flow',
            title: '流水',
            grain: 'ledger',
            columns: ['ledger.delta'],
            filters: [],
          },
        ],
      }),
    ).rejects.toThrow(ReportInvalidError);

    const saved = (await ws.tools.invoke('wms.report.save', {
      title: '螺丝流水',
      parameters: [{ key: 'sku', label: '商品', type: 'text' }],
      sections: [
        {
          id: 'flow',
          title: '流水',
          grain: 'ledger',
          columns: ['ledger.delta', 'ledger.reason', 'sku.skuCode'],
          filters: [
            { field: 'ledger.createdAt', op: 'gte', value: '2000-01-01' },
            { field: 'sku.skuCode', op: 'eq', value: { param: 'sku' } },
          ],
        },
      ],
    })) as { reportId: string };
    expect(() => ws.reports.run(saved.reportId, 'flow', {}, 20, 0, 30)).toThrow(/商品/);
    const page = ws.reports.run(saved.reportId, 'flow', { sku: 'A-1' }, 20, 0, 30);
    expect(page.rows.map((row) => row['ledger.delta'])).toEqual([2, 4]);
    const compiled = compileReportQuery(
      core.exposeDb(),
      'ws-report',
      {
        id: 'flow',
        title: '流水',
        grain: 'ledger',
        columns: ['ledger.delta'],
        filters: [
          { field: 'ledger.createdAt', op: 'gte', value: '2000-01-01' },
          { field: 'sku.skuCode', op: 'eq', value: 'A-1' },
        ],
      },
      [],
      {},
      { limit: 20, offset: 0 },
    );
    expect(compiled.sql).toContain('line.sku_id = ?');
    expect(compiled.sql).toContain('line.created_at >= ?');
  });

  it('重放后定义还在，删掉再重放也保持删掉', async () => {
    const saved = (await ws.tools.invoke('wms.report.save', {
      title: '华东未发',
      sections: [orderSection],
    })) as { reportId: string };
    await ws.tools.invoke('wms.report.save', {
      reportId: saved.reportId,
      title: '改过的标题',
      sections: [orderSection],
    });
    ws.replay();
    expect(ws.reports.list().map((report) => report.title)).toEqual(['改过的标题']);
    await ws.tools.invoke('wms.report.delete', { reportId: saved.reportId });
    ws.replay();
    expect(ws.reports.list()).toEqual([]);
  });

  it('模块关掉后不能再保存，已经有的报表还在', async () => {
    const saved = (await ws.tools.invoke('wms.report.save', {
      title: '华东未发',
      sections: [orderSection],
    })) as { reportId: string };
    const patch: PatchOp[] = [{ op: 'replace', path: '/modules/module.report/enabled', value: false }];
    const { proposalId } = ws.profile.propose('user:tester', patch, '关掉报表');
    ws.profile.confirm(proposalId, 'user:tester');
    await expect(
      ws.tools.invoke('wms.report.save', { title: '另一张', sections: [orderSection] }),
    ).rejects.toThrow(ReportDisabledError);
    expect(ws.reports.list()).toHaveLength(1);
    expect(ws.reports.run(saved.reportId, 'lines', {}, 50, 0, 200).rows).toHaveLength(1);
  });
});
