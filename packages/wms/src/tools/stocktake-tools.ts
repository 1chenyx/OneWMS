import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  SkuNotFoundError,
  StocktakeExistsError,
  StocktakeLinesUncountedError,
  StocktakeNotFoundError,
  StocktakeNotOpenError,
  StocktakeScopeViolationError,
} from '../errors.js';
import {
  getStocktakeDetail,
  listStocktakeLineStates,
  listStocktakes,
  type StocktakeLineState,
} from '../queries/stocktake-queries.js';
import {
  assertNonNegativeQty,
  codeOfLocation,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { bucketReservationNotice } from '../state/reservation.js';
import { allocateCode } from '../numbering/allocate.js';
import { assertStocktakeLines } from '../state/serial-policy.js';
import { def, type WorkspaceResolver } from './tool-def.js';

export function createStocktakeTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const stocktakeCreate: ToolDefinition<{
    locationCodes?: string[];
    stocktakeNo?: string;
    note?: string;
  }> = {
    id: 'wms.stocktake.create',
    label: '创建盘点单',
    description:
      '创建一张盘点单，对指定范围（缺省全场）的库存做实盘核对。创建时立即按当前账面余量生成待盘明细行——每个有余量的 SKU×库位×批次桶一行，行上记录创建时点的账面快照（expectedQty）。locationCodes 是盘点范围的库位编码列表（可选；缺省或空数组 = 全场盘点，含默认库位 DEFAULT）；stocktakeNo 盘点单号（可选，不传或空着按编号规则 stocktake 生成）；note 备注（可选）。生命周期：创建后处于盘点中（created）→ wms.stocktake.count 逐桶录实盘数 → 全部录完后 wms.stocktake.close 关单（按差异自动调整库存）→ 或 wms.stocktake.cancel 取消（不调整库存）。范围外库位的录入会被拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCodes: {
          type: 'array',
          items: { type: 'string' },
          description: '盘点范围库位编码列表（可选；缺省或空数组 = 全场盘点，含默认库位 DEFAULT）',
        },
        stocktakeNo: { type: 'string', description: '盘点单号（可选。不传或空着按编号规则生成）' },
        note: { type: 'string', description: '备注（可选，如 月度大盘）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      // 范围解析：undefined / 空数组 → null（全场）；显式列表逐个校验存在性并去重
      const codes = params.locationCodes;
      const locationIds =
        codes && codes.length > 0
          ? [...new Set(codes.map((code) => resolveLocation(ws, code).locationId))]
          : null;
      const stocktakeNo = allocateCode(ws, 'stocktake', params.stocktakeNo);
      if (ws.stocktakes.byNo(stocktakeNo)) {
        throw new StocktakeExistsError(stocktakeNo);
      }
      const stocktakeId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.stocktakeCreated, {
        stocktakeId,
        stocktakeNo,
        locationIds,
        note: params.note,
      });
      ws.sync();
      return {
        stocktakeId,
        stocktakeNo,
        state: 'created' as const,
        scope: locationIds ? locationIds.map((id) => codeOfLocation(ws, id)) : '全场',
        lineCount: ws.stocktakes.stats(stocktakeId).lineCount,
      };
    },
  };

  const stocktakeCount: ToolDefinition<{
    stocktakeNo: string;
    skuCode: string;
    locationCode?: string;
    batchNo?: string;
    countedQty: number;
  }> = {
    id: 'wms.stocktake.count',
    label: '录入盘点实盘数',
    description:
      '为盘点单录入一个桶（SKU×库位×批次）的实盘数 countedQty（实际清点数量，≥0，支持 3 位小数；0 表示盘亏到零）。locationCode 缺省为默认库位 DEFAULT，batchNo 缺省为虚拟批次 DEFAULT。同桶可重复录入——后录覆盖先录（重盘修正）。账面没有余量的桶也可以录（货架上真有货而账面为零 = 盘盈，关单时自动补库存）。库位必须在盘点范围内，否则拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        stocktakeNo: { type: 'string', description: '盘点单号' },
        skuCode: { type: 'string', description: 'SKU 编码' },
        locationCode: { type: 'string', description: '库位编码（可选，缺省 DEFAULT）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省虚拟批次 DEFAULT）' },
        countedQty: { type: 'number', minimum: 0, description: '实盘数量（≥0，支持 3 位小数）' },
      },
      required: ['stocktakeNo', 'skuCode', 'countedQty'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const st = ws.stocktakes.byNo(params.stocktakeNo);
      if (!st) throw new StocktakeNotFoundError(params.stocktakeNo);
      if (st.state !== 'created') throw new StocktakeNotOpenError(params.stocktakeNo, st.state);
      const countedQty = assertNonNegativeQty(params.countedQty, 'countedQty');
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const loc = resolveLocation(ws, params.locationCode);
      const batch = resolveBatch(params.batchNo, undefined); // 盘点不带效期（批次属性已在入库登记）
      if (st.locationIds && !st.locationIds.includes(loc.locationId)) {
        throw new StocktakeScopeViolationError(params.stocktakeNo, loc.locationCode);
      }
      ctx.appendEvent(WMS_EVENT_TYPES.stocktakeCounted, {
        stocktakeId: st.id,
        stocktakeNo: st.stocktakeNo,
        skuId: sku.id,
        skuCode: sku.skuCode,
        locationId: loc.locationId,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        countedQty,
      });
      ws.sync();
      const line = ws.stocktakes
        .lines(st.id)
        .find(
          (l) =>
            l.skuId === sku.id && l.locationId === loc.locationId && l.batchNo === batch.batchNo,
        );
      return {
        stocktakeNo: st.stocktakeNo,
        skuCode: sku.skuCode,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        countedQty,
        expectedQty: line?.expectedQty ?? 0,
        bookQty: ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo),
      };
    },
  };

  const stocktakeClose: ToolDefinition<{ stocktakeNo: string }> = {
    id: 'wms.stocktake.close',
    label: '盘点关单',
    description:
      '关闭盘点单并收敛差异：要求全部行已录实盘数（未录完会被拒绝）。对每行按「实盘数 − 关单时账面余量」生成库存调整（流水 reason: stocktake:单号）——实盘多于账面自动补库存（盘盈），少于则扣减（盘亏，扣减后余量=实盘数，恒不为负），零差异行跳过不落流水。状态与全部调整原子落账（同生共死）。范围外新录的桶同样收敛。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        stocktakeNo: { type: 'string', description: '盘点单号' },
      },
      required: ['stocktakeNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const st = ws.stocktakes.byNo(params.stocktakeNo);
      if (!st) throw new StocktakeNotFoundError(params.stocktakeNo);
      if (st.state !== 'created') throw new StocktakeNotOpenError(params.stocktakeNo, st.state);
      const stats = ws.stocktakes.stats(st.id);
      const uncounted = stats.lineCount - stats.countedCount;
      if (uncounted > 0) throw new StocktakeLinesUncountedError(st.stocktakeNo, uncounted);

      // 差异计算与 HTTP 明细/查询工具共用同一行状态：按关单时点账面现值收敛，
      // delta = 实盘 − 现值，跳过零差行；共享查询已按编码/库位/批次稳定排序。
      const diffs = listStocktakeLineStates(ws, st.id).filter(
        (d): d is StocktakeLineState & { delta: number } => d.delta !== null && d.delta !== 0,
      );
      assertStocktakeLines(
        ws,
        diffs.map((d) => ({
          skuId: d.line.skuId,
          skuCode: d.skuCode,
          locationId: d.line.locationId,
          locationCode: d.locationCode,
          batchNo: d.line.batchNo,
          delta: d.delta,
          bookQty: d.bookQty,
        })),
      );

      // 原子落账：状态事实 + 每行差异流水同生共死（savepoint，杜绝半落账）。
      // 差异不落新事件类型——就是普通 inventory.adjusted（reason 可追溯回盘点单）。
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.stocktakeStateChanged, {
          stocktakeId: st.id,
          stocktakeNo: st.stocktakeNo,
          from: st.state,
          to: 'closed',
        });
        for (const d of diffs) {
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: d.line.skuId,
            skuCode: d.skuCode,
            delta: d.delta,
            reason: `stocktake:${st.stocktakeNo}`,
            locationId: d.line.locationId,
            locationCode: d.locationCode,
            batchNo: d.line.batchNo,
          });
        }
      });
      ws.sync();
      const warnings = diffs.flatMap((d) => {
        if (d.delta >= 0) return [];
        const notice = bucketReservationNotice(ws, d.line.skuId, d.line.locationId, d.line.batchNo);
        return notice ? [notice] : [];
      });
      return {
        stocktakeNo: st.stocktakeNo,
        state: 'closed' as const,
        totalLines: stats.lineCount,
        adjustedLines: diffs.length,
        ...(warnings.length > 0 ? { warning: [...new Set(warnings)].join(' ') } : {}),
        adjustments: diffs.map((d) => ({
          skuCode: d.skuCode,
          locationCode: d.locationCode,
          batchNo: d.line.batchNo,
          expectedQty: d.line.expectedQty,
          countedQty: d.line.countedQty as number,
          bookQty: d.bookQty,
          delta: d.delta,
        })),
      };
    },
  };

  const stocktakeCancel: ToolDefinition<{ stocktakeNo: string }> = {
    id: 'wms.stocktake.cancel',
    label: '取消盘点单',
    description:
      '取消盘点单（零库存调整——已录的实盘数保留在单上仅作记录，不动账面库存）。只有盘点中（created）的单可取消；已关单/已取消的单再取消会被拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        stocktakeNo: { type: 'string', description: '盘点单号' },
      },
      required: ['stocktakeNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const st = ws.stocktakes.byNo(params.stocktakeNo);
      if (!st) throw new StocktakeNotFoundError(params.stocktakeNo);
      if (st.state !== 'created') throw new StocktakeNotOpenError(params.stocktakeNo, st.state);
      ctx.appendEvent(WMS_EVENT_TYPES.stocktakeStateChanged, {
        stocktakeId: st.id,
        stocktakeNo: st.stocktakeNo,
        from: st.state,
        to: 'canceled',
      });
      ws.sync();
      return { stocktakeNo: st.stocktakeNo, state: 'canceled' as const };
    },
  };

  const stocktakeQuery: ToolDefinition<{ stocktakeNo?: string }> = {
    id: 'wms.stocktake.query',
    label: '查询盘点单',
    description:
      '查询盘点单。不给 stocktakeNo 返回全部盘点单清单（单号、状态、范围、进度=已盘行数/总行数）；给 stocktakeNo 返回单张明细：逐行 SKU×库位×批次的账面快照 expectedQty（创建时点）、实盘数 countedQty（未盘为 null）、当前账面 bookQty 与差异 delta（实盘 − 当前账面；未盘为 null）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        stocktakeNo: { type: 'string', description: '盘点单号（可选，缺省列出全部）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!params.stocktakeNo) {
        // 工具 DTO 保持既有精简形状；HTTP 清单复用同一共享查询的完整记录。
        return listStocktakes(ws).map((st) => ({
          stocktakeNo: st.stocktakeNo,
          state: st.state,
          scope: st.scope,
          note: st.note,
          createdAt: st.createdAt,
          lineCount: st.lineCount,
          countedCount: st.countedCount,
        }));
      }
      const st = ws.stocktakes.byNo(params.stocktakeNo);
      if (!st) throw new StocktakeNotFoundError(params.stocktakeNo);
      const detail = getStocktakeDetail(ws, st);
      return {
        stocktakeNo: detail.stocktakeNo,
        state: detail.state,
        scope: detail.scope,
        note: detail.note,
        createdAt: detail.createdAt,
        lineCount: detail.lineCount,
        countedCount: detail.countedCount,
        // 工具行不暴露 HTTP 展示用的 name，保持原响应逐字段兼容。
        lines: detail.lines.map((line) => ({
          skuCode: line.skuCode,
          locationCode: line.locationCode,
          batchNo: line.batchNo,
          expectedQty: line.expectedQty,
          countedQty: line.countedQty,
          bookQty: line.bookQty,
          delta: line.delta,
        })),
      };
    },
  };

  return [
    def(stocktakeCreate),
    def(stocktakeCount),
    def(stocktakeClose),
    def(stocktakeCancel),
    def(stocktakeQuery),
  ];
}


