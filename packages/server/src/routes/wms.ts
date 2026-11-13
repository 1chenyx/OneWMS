import { Hono } from 'hono';
import { resolveActor } from '../actor.js';
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
  listInventorySummaryPage,
  listInventorySlices,
  listLedger,
  getReturnable,
  getReplenishment,
  listWarehouses,
  listWarehouseStock,
  presentLocation,
  listSerials,
  querySerial,
  listLpns,
  lpnStock,
  describeNumbering,
  isNumberPlace,
  listOrdersWithLines,
  listOrdersWithLinesPage,
  listPickingsWithLines,
  listWaves,
  getWave,
  listStocktakes,
  getTransferDetail,
  listTransfers,
  getScrapDetail,
  listScraps,
  PickingNotFoundError,
  StocktakeNotFoundError,
  TransferNotFoundError,
  ScrapNotFoundError,
  WaveNotFoundError,
  withPickingLines,
} from '@one/wms';
import type { OrderDirection, PartnerKind } from '@one/wms';
import type { AppContext } from '../context.js';
import { BadQueryError } from '../errors.js';

/** 界面清单分页上限，与单据查询工具的 limit 上限一致。不传 limit 时仍返回整表数组。 */
const LIST_PAGE_MAX = 200;

function readListPage(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
): { limit: number; offset: number } | undefined {
  if (limitRaw === undefined || limitRaw === '') return undefined;
  const limit = Number(limitRaw);
  const offset = offsetRaw === undefined || offsetRaw === '' ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX) {
    throw new BadQueryError(`limit 须为 1 到 ${LIST_PAGE_MAX} 的整数`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new BadQueryError('offset 须为不小于 0 的整数');
  }
  return { limit, offset };
}

/**
 * 库位清单的仓库范围。
 * 不传 = 全部（盘点、导入、下拉仍走这条）；unassigned=1 = 未分仓；warehouseCode = 该仓库的库位。
 * 未知仓库是查询参数错误，不把空清单伪装成「这个仓没有库位」。
 */
function readLocationWarehouseId(
  ws: AppContext['ws'],
  unassigned: string | undefined,
  warehouseCode: string | undefined,
): string | null | undefined {
  const flag = unassigned?.trim() ?? '';
  const code = warehouseCode?.trim() ?? '';
  if (flag !== '' && flag !== '1') throw new BadQueryError('unassigned 只能是 1');
  if (flag === '1' && code !== '') throw new BadQueryError('不能同时按仓库和未分仓筛选');
  if (flag === '1') return null;
  if (code === '') return undefined;
  ws.sync();
  const warehouse = ws.warehouses.byCode(code);
  if (!warehouse) throw new BadQueryError(`仓库不存在：${code}`);
  return warehouse.id;
}

export type { ExpiryBatchRow, ExpiryLevel, OrderWithLines } from '@one/wms';

/**
 * 管理界面业务端点（读写分治，契约见 ARCHITECTURE.md @one/server 章节）：
 *  - 读 = 调用 WMS 共享查询（投影是缓存，只读安全）；
 *  - 写 = 全部经工具总线（人与 AI 走同一条命令通道，护栏 + 审计免费）。
 * 本文件不做业务校验与投影组装——分别属于工具 handler 与 @one/wms/queries；
 * 错误经 onError 统一映射（WMS_* / TOOL_* → 400 + code，前端按 code 分支提示）。
 */

export function wmsRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/numbering', (c) => {
      ctx.ws.sync();
      const place = c.req.query('place')?.trim() || undefined;
      if (place && !isNumberPlace(place)) throw new BadQueryError(`没有这个编号位置：${place}`);
      return c.json(describeNumbering(ctx.ws, place));
    })
    // ── SKU ─────────────────────────────────────────────
    // barcode = 精确匹配（扫码枪入口）；q = 三字段模糊（编码/名称/条码）。
    // A2 软停用：默认只回启用档（选择器/下拉零改动自动排除停用）；includeArchived=1 回全量；
    // barcode 精确查询不过滤——扫码定位语义（停用 SKU 的存量库存照常可扫）。
    .get('/skus', (c) => {
      const barcode = c.req.query('barcode');
      const q = c.req.query('q');
      const includeArchived = c.req.query('includeArchived') === '1';
      const matched = {
        barcode: barcode || undefined,
        q: q || undefined,
        includeArchived: includeArchived || Boolean(barcode),
      };
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      if (!page) return c.json(ctx.ws.skus.listMatching(matched));
      const { rows, total } = ctx.ws.skus.listMatchingPage({ ...matched, ...page });
      return c.json({ total, ...page, hasMore: page.offset + rows.length < total, rows });
    })
    .post('/skus', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.sku.create', body, resolveActor(ctx, c)), 201);
    })
    .put('/skus/:skuCode', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.sku.update',
          { ...body, skuCode: c.req.param('skuCode') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/skus/:skuCode/archive', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.sku.archive',
          { skuCode: c.req.param('skuCode') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/skus/:skuCode/unarchive', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.sku.unarchive',
          { skuCode: c.req.param('skuCode') },
          resolveActor(ctx, c),
        ),
      );
    })
    // ── 往来单位（M21：供应商/客户统一档案；q = 编码/名称模糊）──
    .get('/partners', (c) => {
      const kind = c.req.query('kind');
      const q = c.req.query('q');
      // 显式标注类型：字面量联合经对象属性推断会被拓宽成 string，视图签名收不下
      const kindFilter: PartnerKind | undefined =
        kind === 'supplier' || kind === 'customer' ? kind : undefined;
      const matched = { kind: kindFilter, q: q || undefined };
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      if (!page) return c.json(ctx.ws.partners.listMatching(matched));
      const { rows, total } = ctx.ws.partners.listMatchingPage({ ...matched, ...page });
      return c.json({ total, ...page, hasMore: page.offset + rows.length < total, rows });
    })
    .post('/partners', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.partner.create', body, resolveActor(ctx, c)), 201);
    })
    .put('/partners/:partnerCode', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.partner.update',
          { ...body, partnerCode: c.req.param('partnerCode') },
          resolveActor(ctx, c),
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
      return c.json(await ctx.ws.tools.invoke('wms.picking.create', body, resolveActor(ctx, c)), 201);
    })
    .post('/pickings/:no/pick', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.pick',
          { ...body, pickingNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/pickings/:no/close', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.close',
          { pickingNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/pickings/:no/cancel', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.picking.cancel',
          { pickingNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      );
    })
    // ── 波次：多张已创建出库单收成一波，按库位汇总，整波生成一张拣货单 ──
    .get('/waves', (c) => c.json(listWaves(ctx.ws)))
    .get('/waves/:no', (c) => {
      const wave = getWave(ctx.ws, c.req.param('no'));
      if (!wave) throw new WaveNotFoundError(c.req.param('no'));
      return c.json(wave);
    })
    .post('/waves', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.wave.create', body, resolveActor(ctx, c)), 201);
    })
    .post('/waves/:no/pick', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.wave.pick',
          { ...body, waveNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/waves/:no/cancel', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.wave.cancel',
          { waveNo: c.req.param('no') },
          resolveActor(ctx, c),
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
    // ── 补货建议（module.replenish）：读建议；写走 wms.replenish.create ──
    .get('/replenishment', (c) => c.json(getReplenishment(ctx.ws)))
    .post('/replenishment', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await ctx.ws.tools.invoke('wms.replenish.create', body, resolveActor(ctx, c)), 201);
    })
    // ── 单据 ────────────────────────────────────────────
    .get('/orders', (c) => {
      const q = c.req.query('direction');
      const direction = q === 'in' || q === 'out' ? (q as OrderDirection) : undefined;
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      if (!page) return c.json(listOrdersWithLines(ctx.ws, direction));
      return c.json(
        listOrdersWithLinesPage(ctx.ws, {
          direction,
          q: c.req.query('q') || undefined,
          ...page,
        }),
      );
    })
    .get('/orders/:orderNo/returnable', (c) => c.json(getReturnable(ctx.ws, c.req.param('orderNo'))))
    .post('/orders', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.order.create', body, resolveActor(ctx, c)), 201);
    })
    .get('/order-conflicts', (c) => c.json(ctx.ws.orders.listConflicts('open')))
    .post('/order-conflicts/:eventId/accept', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.order.conflict.accept',
          { eventId: c.req.param('eventId') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/order-conflicts/:eventId/dismiss', async (c) => {
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.order.conflict.dismiss',
          { eventId: c.req.param('eventId') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/orders/:orderNo/revise', async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.order.revise',
          { ...body, orderNo: c.req.param('orderNo') },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/orders/:orderNo/transition', async (c) => {
      const body = await c.req.json();
      const result = await ctx.ws.tools.invoke(
        'wms.order.transition',
        {
          orderNo: c.req.param('orderNo'),
          to: body.to,
          lines: Array.isArray(body.lines) && body.lines.length > 0 ? body.lines : undefined,
        },
        resolveActor(ctx, c),
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
        resolveActor(ctx, c),
      );
      return c.json(result);
    })
    // ── 库存 ────────────────────────────────────────────
    .get('/inventory', (c) => {
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      if (!page) return c.json(listInventorySummary(ctx.ws));
      return c.json(
        listInventorySummaryPage(ctx.ws, {
          ...page,
          q: c.req.query('q') || undefined,
          skuCode: c.req.query('skuCode') || undefined,
          lowOnly: c.req.query('lowOnly') === '1',
        }),
      );
    })
    /**
     * 库存分维度。view=sku|location|batch|warehouse。
     * 行上只有实物余量；冻结、预占、可用量仍走 GET /inventory 的 SKU 合计。
     * 仓库筛选与库位清单同一套：warehouseCode 或 unassigned=1，不能同时给。
     */
    .get('/inventory/slices', (c) => {
      const rawView = c.req.query('view')?.trim() ?? '';
      const view = (['sku', 'location', 'batch', 'warehouse'] as const).find((item) => item === rawView);
      if (!view) throw new BadQueryError('view 须为 sku、location、batch 或 warehouse');
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      if (!page) throw new BadQueryError('库存分维度查询必须带 limit');
      return c.json(
        listInventorySlices(ctx.ws, {
          view,
          ...page,
          q: c.req.query('q')?.trim() || undefined,
          locationCode: c.req.query('locationCode')?.trim() || undefined,
          batchNo: c.req.query('batchNo')?.trim() || undefined,
          warehouseId: readLocationWarehouseId(
            ctx.ws,
            c.req.query('unassigned'),
            c.req.query('warehouseCode'),
          ),
        }),
      );
    })
    /**
     * 库存分桶明细（SKU×库位×批次）——Excel 导出用：汇总行看不出东西放在哪、
     * 哪一批快过期，导账必须到桶粒度。零余量的桶滤掉（已清空的桶没有导出价值）。
     */
    .get('/inventory/buckets', (c) => {
      const rows = ctx.ws.inventory
        .list()
        .filter((r) => r.quantity !== 0)
        .map((r) => {
          const sku = ctx.ws.skus.byId(r.skuId);
          const loc = ctx.ws.locations.byId(r.locationId);
          return {
            skuCode: sku?.skuCode ?? '(未知)',
            name: sku?.name ?? '',
            unit: sku?.unit ?? null, // A3：导出带单位
            locationCode: loc?.locationCode ?? r.locationId,
            batchNo: r.batchNo,
            batchExpiryDate: r.batchExpiryDate,
            quantity: r.quantity,
          };
        });
      return c.json(rows);
    })
    /** 库存流水（导出 / 对账）——append-only 真相层，倒序，limit ≤ 5000 */
    .get('/inventory/ledger', (c) => {
      const limitRaw = c.req.query('limit');
      const skuCode = c.req.query('skuCode');
      return c.json(
        listLedger(ctx.ws, {
          limit: limitRaw ? Number(limitRaw) : undefined,
          skuCode: skuCode || undefined,
        }),
      );
    })
    .post('/inventory/adjust', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.inventory.adjust', body, resolveActor(ctx, c)));
    })
    // ── 冻结（M19：活动清单 / 冻结 / 释放；写全走工具通道）──
    .get('/holds', (c) => c.json(listHoldRows(ctx.ws, c.req.query('skuCode'))))
    .post('/holds', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.inventory.hold', body, resolveActor(ctx, c)), 201);
    })
    .post('/holds/:id/release', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.inventory.release',
          { holdId: c.req.param('id') },
          resolveActor(ctx, c),
        ),
      ),
    )
    // ── 效期看板（M14；M15 阈值 settings 化 + 库位明细）──
    .get('/inventory/expiry', (c) => c.json(getExpiryBoard(ctx.ws)))
    // ── 库位（M10 实体；GET 是 M17 盘点范围勾选的数据源）──
    .get('/locations', (c) => {
      const q = c.req.query('q') || undefined;
      const page = readListPage(c.req.query('limit'), c.req.query('offset'));
      const warehouseId = readLocationWarehouseId(ctx.ws, c.req.query('unassigned'), c.req.query('warehouseCode'));
      if (!page) {
        return c.json(
          ctx.ws.locations.list(q, warehouseId).map((location) => presentLocation(ctx.ws, location)),
        );
      }
      const { rows, total } = ctx.ws.locations.listPage({ q, warehouseId, ...page });
      return c.json({
        total,
        ...page,
        hasMore: page.offset + rows.length < total,
        rows: rows.map((location) => presentLocation(ctx.ws, location)),
      });
    })
    .get('/warehouses', (c) => c.json(listWarehouses(ctx.ws)))
    .post('/warehouses', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.warehouse.create', body, resolveActor(ctx, c)), 201);
    })
    .put('/warehouses/:warehouseCode', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.warehouse.update',
          { ...body, warehouseCode: c.req.param('warehouseCode') },
          resolveActor(ctx, c),
        ),
      );
    })
    .get('/warehouses/:warehouseCode/stock', (c) =>
      c.json(listWarehouseStock(ctx.ws, c.req.param('warehouseCode'))),
    )
    .get('/serials', (c) =>
      c.json(
        listSerials(ctx.ws, {
          skuCode: c.req.query('skuCode') || undefined,
          locationCode: c.req.query('locationCode') || undefined,
          status: c.req.query('status') || undefined,
        }),
      ),
    )
    .get('/serials/:serialNo', (c) => c.json(querySerial(ctx.ws, c.req.param('serialNo'))))
    .get('/lpns', (c) => c.json(listLpns(ctx.ws)))
    .post('/lpns', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.lpn.create', body, resolveActor(ctx, c)), 201);
    })
    .post('/lpns/:code/pack', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke('wms.lpn.pack', { ...body, lpnCode: c.req.param('code') }, resolveActor(ctx, c)),
      );
    })
    .post('/lpns/:code/unpack', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke('wms.lpn.unpack', { ...body, lpnCode: c.req.param('code') }, resolveActor(ctx, c)),
      );
    })
    .post('/lpns/:code/move', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke('wms.lpn.move', { ...body, lpnCode: c.req.param('code') }, resolveActor(ctx, c)),
      );
    })
    .get('/lpns/:code/stock', (c) => c.json(lpnStock(ctx.ws, c.req.param('code'))))
    .post('/locations', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.location.create', body, resolveActor(ctx, c)), 201);
    })
    .put('/locations/:locationCode', async (c) => {
      const body = await c.req.json();
      return c.json(
        await ctx.ws.tools.invoke(
          'wms.location.update',
          { ...body, locationCode: c.req.param('locationCode') },
          resolveActor(ctx, c),
        ),
      );
    })
    // ── 盘点（M17：清单+进度 / 创建 / 明细 / 录实盘 / 关单 / 取消）──
    .get('/stocktakes', (c) => c.json(listStocktakes(ctx.ws)))
    .post('/stocktakes', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.stocktake.create', body, resolveActor(ctx, c)), 201);
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
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/stocktakes/:no/close', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.stocktake.close',
          { stocktakeNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      ),
    )
    .post('/stocktakes/:no/cancel', async (c) =>
      c.json(
        await ctx.ws.tools.invoke(
          'wms.stocktake.cancel',
          { stocktakeNo: c.req.param('no') },
          resolveActor(ctx, c),
        ),
      ),
    )
    // ── 调拨（清单 / 创建 / 明细 / 发货 / 收货 / 取消；写操作走工具总线确认流）──
    .get('/transfers', (c) => c.json(listTransfers(ctx.ws)))
    .post('/transfers', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.transfer.create', body, resolveActor(ctx, c)), 201);
    })
    .get('/transfers/:no', (c) => {
      const transferNo = c.req.param('no');
      const transfer = ctx.ws.transfers.byNo(transferNo);
      if (!transfer) throw new TransferNotFoundError(transferNo);
      return c.json(getTransferDetail(ctx.ws, transfer));
    })
    .post('/transfers/:no/ship', async (c) =>
      c.json(
        await ctx.ws.tools.invoke('wms.transfer.ship', { transferNo: c.req.param('no') }, resolveActor(ctx, c)),
      ),
    )
    .post('/transfers/:no/receive', async (c) =>
      c.json(
        await ctx.ws.tools.invoke('wms.transfer.receive', { transferNo: c.req.param('no') }, resolveActor(ctx, c)),
      ),
    )
    .post('/transfers/:no/cancel', async (c) =>
      c.json(
        await ctx.ws.tools.invoke('wms.transfer.cancel', { transferNo: c.req.param('no') }, resolveActor(ctx, c)),
      ),
    )
    // ── 报损（清单 / 创建 / 明细 / 确认 / 取消）──
    .get('/scraps', (c) => c.json(listScraps(ctx.ws)))
    .post('/scraps', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.scrap.create', body, resolveActor(ctx, c)), 201);
    })
    .get('/scraps/:no', (c) => {
      const scrapNo = c.req.param('no');
      const scrap = ctx.ws.scraps.byNo(scrapNo);
      if (!scrap) throw new ScrapNotFoundError(scrapNo);
      return c.json(getScrapDetail(ctx.ws, scrap));
    })
    .post('/scraps/:no/confirm', async (c) =>
      c.json(await ctx.ws.tools.invoke('wms.scrap.confirm', { scrapNo: c.req.param('no') }, resolveActor(ctx, c))),
    )
    .post('/scraps/:no/cancel', async (c) =>
      c.json(await ctx.ws.tools.invoke('wms.scrap.cancel', { scrapNo: c.req.param('no') }, resolveActor(ctx, c))),
    );
}
