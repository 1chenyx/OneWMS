import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES, type ScrapLinePayload } from '../events/catalog.js';
import {
  InsufficientStockError,
  ScrapExistsError,
  ScrapNoLinesError,
  ScrapNotFoundError,
  ScrapStateError,
  SerialManagedNotSupportedError,
  SkuNotFoundError,
} from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { assertLooseEnough } from '../state/lpn-policy.js';
import {
  assertPositiveQty,
  codeOfLocation,
  QTY_EPS,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { getScrapDetail, listScraps } from '../queries/scrap-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

interface ScrapLineInput {
  skuCode: string;
  locationCode?: string;
  batchNo?: string;
  quantity: number;
}

export function createScrapTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const scrapCreate: ToolDefinition<{
    lines: ScrapLineInput[];
    scrapNo?: string;
    note?: string;
  }> = {
    id: 'wms.scrap.create',
    label: '创建报损单',
    description:
      '创建一张报损单（报废/损坏出库的单据化记录）。每行 = SKU + 库位 + 批次 + 数量。生命周期：新建（created）→ wms.scrap.confirm 确认（逐行从库位批次扣减，流水 reason: scrap:单号）→ 已确认；新建阶段可用 wms.scrap.cancel 取消（不动库存）。按序列号管理的 SKU 暂不支持报损。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description:
            '报损明细行（至少一行），每行 { skuCode, quantity, locationCode?, batchNo? }。quantity 正数支持 3 位小数；locationCode 缺省 DEFAULT；batchNo 缺省虚拟批次 DEFAULT',
          items: { type: 'object' },
        },
        scrapNo: { type: 'string', description: '报损单号（可选。不传或空着按编号规则生成）' },
        note: { type: 'string', description: '备注（可选，如 破损/过期/丢失）' },
      },
      required: ['lines'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!params.lines || params.lines.length === 0) throw new ScrapNoLinesError();
      const lines: ScrapLinePayload[] = params.lines.map((line) => {
        const sku = ws.skus.byCode(line.skuCode);
        if (!sku) throw new SkuNotFoundError(line.skuCode);
        if (sku.serialTracked) throw new SerialManagedNotSupportedError(sku.skuCode, '报损单');
        const loc = resolveLocation(ws, line.locationCode);
        const batch = resolveBatch(line.batchNo, undefined); // 报损不带效期
        return {
          skuId: sku.id,
          skuCode: sku.skuCode,
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          batchNo: batch.batchNo,
          quantity: assertPositiveQty(line.quantity, 'quantity'),
        };
      });
      const scrapNo = allocateCode(ws, 'scrap', params.scrapNo);
      if (ws.scraps.byNo(scrapNo)) throw new ScrapExistsError(scrapNo);
      const scrapId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.scrapCreated, {
        scrapId,
        scrapNo,
        lines,
        note: params.note,
      });
      ws.sync();
      return { scrapId, scrapNo, state: 'created' as const, lineCount: lines.length };
    },
  };

  const scrapConfirm: ToolDefinition<{ scrapNo: string }> = {
    id: 'wms.scrap.confirm',
    label: '确认报损',
    description:
      '确认报损单：单据进入已确认（confirmed），同时逐行从对应库位批次扣减数量（流水 reason: scrap:单号）。余量不足（或已装托盘的可动数量不足）会整体拒绝。只有新建（created）状态的单可确认。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        scrapNo: { type: 'string', description: '报损单号' },
      },
      required: ['scrapNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sc = ws.scraps.byNo(params.scrapNo);
      if (!sc) throw new ScrapNotFoundError(params.scrapNo);
      if (sc.state !== 'created') throw new ScrapStateError(params.scrapNo, sc.state, '确认');
      const lines = ws.scraps.lines(sc.id);
      // 校验全部行余量充足 + 托盘可动，任一不过整单拒绝（拒绝路径不进事务）
      for (const line of lines) {
        const sku = ws.skus.byId(line.skuId);
        if (!sku) throw new SkuNotFoundError(line.skuId);
        const available = ws.inventory.quantityOf(line.skuId, line.locationId, line.batchNo);
        if (available + QTY_EPS < line.quantity) {
          throw new InsufficientStockError(sku.skuCode, -line.quantity, available);
        }
        assertLooseEnough(ws, {
          skuCode: sku.skuCode,
          skuId: line.skuId,
          locationId: line.locationId,
          locationCode: codeOfLocation(ws, line.locationId),
          batchNo: line.batchNo,
          take: line.quantity,
          onHand: available,
        });
      }
      // 原子落账：状态事实 + 每行扣减流水同生共死（savepoint，杜绝半落账）
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.scrapStateChanged, {
          scrapId: sc.id,
          scrapNo: sc.scrapNo,
          from: sc.state,
          to: 'confirmed',
        });
        for (const line of lines) {
          const sku = ws.skus.byId(line.skuId)!;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: line.skuId,
            skuCode: sku.skuCode,
            delta: -line.quantity,
            reason: `scrap:${sc.scrapNo}`,
            locationId: line.locationId,
            locationCode: codeOfLocation(ws, line.locationId),
            batchNo: line.batchNo,
          });
        }
      });
      ws.sync();
      return { scrapNo: sc.scrapNo, state: 'confirmed' as const, scrappedLines: lines.length };
    },
  };

  const scrapCancel: ToolDefinition<{ scrapNo: string }> = {
    id: 'wms.scrap.cancel',
    label: '取消报损单',
    description: '取消报损单（不动库存）。只有新建（created）状态的单可取消；已确认的单不能再取消。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        scrapNo: { type: 'string', description: '报损单号' },
      },
      required: ['scrapNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sc = ws.scraps.byNo(params.scrapNo);
      if (!sc) throw new ScrapNotFoundError(params.scrapNo);
      if (sc.state !== 'created') throw new ScrapStateError(params.scrapNo, sc.state, '取消');
      ctx.appendEvent(WMS_EVENT_TYPES.scrapStateChanged, {
        scrapId: sc.id,
        scrapNo: sc.scrapNo,
        from: sc.state,
        to: 'canceled',
      });
      ws.sync();
      return { scrapNo: sc.scrapNo, state: 'canceled' as const };
    },
  };

  const scrapQuery: ToolDefinition<{ scrapNo?: string }> = {
    id: 'wms.scrap.query',
    label: '查询报损单',
    description:
      '查询报损单。不给 scrapNo 返回全部报损单清单（单号、状态、备注、行数）；给 scrapNo 返回单张明细：逐行 SKU×库位×批次的数量。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        scrapNo: { type: 'string', description: '报损单号（可选，缺省列出全部）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!params.scrapNo) {
        return listScraps(ws).map((s) => ({
          scrapNo: s.scrapNo,
          state: s.state,
          note: s.note,
          createdAt: s.createdAt,
          lineCount: s.lineCount,
        }));
      }
      const sc = ws.scraps.byNo(params.scrapNo);
      if (!sc) throw new ScrapNotFoundError(params.scrapNo);
      const detail = getScrapDetail(ws, sc);
      return {
        scrapNo: detail.scrapNo,
        state: detail.state,
        note: detail.note,
        createdAt: detail.createdAt,
        lines: detail.lines.map((line) => ({
          skuCode: line.skuCode,
          name: line.name,
          locationCode: line.locationCode,
          batchNo: line.batchNo,
          quantity: line.quantity,
        })),
      };
    },
  };

  return [def(scrapCreate), def(scrapConfirm), def(scrapCancel), def(scrapQuery)];
}
