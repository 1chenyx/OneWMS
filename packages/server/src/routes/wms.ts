import { Hono } from 'hono';
import {
  getAlertSummary,
  getDashboardOverview,
  getExpiryBoard,
  getFlowTrend,
  getLocationDistribution,
  getOrderStats,
  getStocktakeDetail,
  listHoldRows,
  listInventorySummary,
  listOrdersWithLines,
  listPickingsWithLines,
  listStocktakes,
  PickingNotFoundError,
  StocktakeNotFoundError,
  withPickingLines,
} from '@one/wms';
import type { OrderDirection } from '@one/wms';
import type { AppContext } from '../context.js';

export type { ExpiryBatchRow, ExpiryLevel, OrderWithLines } from '@one/wms';

/**
 * 管理界面业务端点（读写分治，契约见 ARCHITECTURE.md @one/server 章节）：
 *  - 读 = 调用 WMS 共享查询（投影是缓存，只读安全）；
 *  - 写 = 全部经工具总线（人与 AI 走同一条命令通道，护栏 + 审计免费）。
 * 本文件不做业务校验与投影组装——分别属于工具 handler 与 @one/wms/queries；
 * 错误经 onError 统一映射（WMS_* / TOOL_* → 400 + code，前端按 code 分支提示）。
 */

/** 人操作界面的 actor（带节点后缀：审计可辨「人做的」，且同步通道节点唯一） */
function actorOf(ctx: AppContext): string {
  return `user:local@${ctx.core.nodeId}`;
}

export function wmsRoutes(ctx: AppContext): Hono {
  return new Hono()
    // ── SKU ─────────────────────────────────────────────
    // barcode = 精确匹配（扫码枪入口）；q = 三字段模糊（编码/名称/条码）。
    .get('/skus', (c) => {
      const barcode = c.req.query('barcode');
      const q = c.req.query('q');
      let rows = ctx.ws.skus.list();
      if (barcode) rows = rows.filter((s) => s.barcode === barcode);
      if (q) {
        const kw = q.toLowerCase();
        rows = rows.filter(
          (s) =>
            s.skuCode.toLowerCase().includes(kw) ||
            s.name.toLowerCase().includes(kw) ||
            (s.barcode ?? '').toLowerCase().includes(kw),
        );
      }
      return c.json(rows);
    })
    .post('/skus', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.sku.create', body, actorOf(ctx)), 201);
    })
    // ── 往来单位（M21：供应商/客户统一档案；q = 编码/名称模糊）──
    .get('/partners', (c) => {
      const kind = c.req.query('kind');
      const q = c.req.query('q');
      let rows =
        kind === 'supplier' || kind === 'customer' ? ctx.ws.partners.list(kind) : ctx.ws.partners.list();
      if (q) {
        const kw = q.toLowerCase();
        rows = rows.filter(
          (p) => p.partnerCode.toLowerCase().includes(kw) || p.name.toLowerCase().includes(kw),
        );
      }
      return c.json(rows);
    })
    .post('/partners', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.partner.create', body, actorOf(ctx)), 201);
    })
    .put('/partners/:partnerCode', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.partner.update',
          { ...body, partnerCode: c.req.param('partnerCode') },
          actorOf(ctx),
        ),
      );
    })
    // ── 拣货单（M21：聚合「拣货中」出库单；实拣记实，关单统一扣减）──
    .get('/pickings', (c) => {
      const state = c.req.query('state');
      return c.json(listPickingsWithLines(ctx.ws, state || undefined));
    })
    .get('/pickings/:no', (c) => {
      const picking = ctx.ws.pickings.byNo(c.req.param('no'));
      if (!picking) throw new PickingNotFoundError(c.req.param('no'));
      return c.json(withPickingLines(ctx.ws, picking));
    })
    .post('/pickings', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.picking.create', body, actorOf(ctx)), 201);
    })
    .post('/pickings/:no/pick', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.pick',
          { ...body, pickingNo: c.req.param('no') },
          actorOf(ctx),
        ),
      );
    })
    .post('/pickings/:no/close', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.close',
          { pickingNo: c.req.param('no') },
          actorOf(ctx),
        ),
      );
    })
    .post('/pickings/:no/cancel', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.cancel',
          { pickingNo: c.req.param('no') },
          actorOf(ctx),
        ),
      );
    })
    // ── 运营看板（M21）：五维度各自独立端点（独立拉取/失效/扩展新维度）──
    .get('/dashboard/overview', (c) => c.json(getDashboardOverview(ctx.ws)))
    .get('/dashboard/flow-trend', (c) => {
      const days = Number(c.req.query('days') ?? '14');
      return c.json(getFlowTrend(ctx.ws, Number.isInteger(days) && days > 0 && days <= 90 ? days : 14));
    })
    .get('/dashboard/locations', (c) => c.json(getLocationDistribution(ctx.ws)))
    .get('/dashboard/orders', (c) => c.json(getOrderStats(ctx.ws)))
    .get('/dashboard/alerts', (c) => c.json(getAlertSummary(ctx.ws)))
    // ── 单据 ────────────────────────────────────────────
    .get('/orders', (c) => {
      const q = c.req.query('direction');
      const direction = q === 'in' || q === 'out' ? (q as OrderDirection) : undefined;
      return c.json(listOrdersWithLines(ctx.ws, direction));
    })
    .post('/orders', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.order.create', body, actorOf(ctx)), 201);
    })
    .post('/orders/:orderNo/transition', async (c) => {
      const body = await c.req.json();
      const result = await ctx.ws.tools.invoke(
        'wms.order.transition',
        { orderNo: c.req.param('orderNo'), to: body.to },
        actorOf(ctx),
      );
      return c.json(result);
    })
    // 上架确认与归位（M21，module.putaway）：body.targets 可选，缺省 = 纯确认
    .post('/orders/:orderNo/putaway', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const result = await ctx.ws.tools.invoke(
        'wms.order.putaway',
        {
          orderNo: c.req.param('orderNo'),
          targets:
            body.targets && body.targets.length > 0 ? body.targets : undefined,
        },
        actorOf(ctx),
      );
      return c.json(result);
    })
    // ── 库存 ────────────────────────────────────────────
    .get('/inventory', (c) => c.json(listInventorySummary(ctx.ws)))
    .post('/inventory/adjust', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.inventory.adjust', body, actorOf(ctx)));
    })
    // ── 冻结（M19：活动清单 / 冻结 / 释放；写全走工具通道）──
    .get('/holds', (c) => c.json(listHoldRows(ctx.ws, c.req.query('skuCode'))))
    .post('/holds', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.inventory.hold', body, actorOf(ctx)), 201);
    })
    .post('/holds/:id/release', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.inventory.release',
          { holdId: c.req.param('id') },
          actorOf(ctx),
        ),
      ),
    )
    // ── 效期看板（M14；M15 阈值 settings 化 + 库位明细）──
    .get('/inventory/expiry', (c) => c.json(getExpiryBoard(ctx.ws)))
    // ── 库位（M10 实体；GET 是 M17 盘点范围勾选的数据源）──
    .get('/locations', (c) => c.json(ctx.ws.locations.list()))
    // ── 盘点（M17：清单+进度 / 创建 / 明细 / 录实盘 / 关单 / 取消）──
    .get('/stocktakes', (c) => c.json(listStocktakes(ctx.ws)))
    .post('/stocktakes', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.stocktake.create', body, actorOf(ctx)), 201);
    })
    .get('/stocktakes/:no', (c) => {
      const stocktakeNo = c.req.param('no');
      const stocktake = ctx.ws.stocktakes.byNo(stocktakeNo);
      if (!stocktake) throw new StocktakeNotFoundError(stocktakeNo);
      return c.json(getStocktakeDetail(ctx.ws, stocktake));
    })
    .post('/stocktakes/:no/count', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.stocktake.count',
          { ...body, stocktakeNo: c.req.param('no') },
          actorOf(ctx),
        ),
      );
    })
    .post('/stocktakes/:no/close', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.stocktake.close',
          { stocktakeNo: c.req.param('no') },
          actorOf(ctx),
        ),
      ),
    )
    .post('/stocktakes/:no/cancel', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.stocktake.cancel',
          { stocktakeNo: c.req.param('no') },
          actorOf(ctx),
        ),
      ),
    );
}
