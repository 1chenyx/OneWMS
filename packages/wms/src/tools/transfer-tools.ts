import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES, type TransferLinePayload } from '../events/catalog.js';
import {
  InsufficientStockError,
  SerialManagedNotSupportedError,
  SkuNotFoundError,
  TransferExistsError,
  TransferNoLinesError,
  TransferNotFoundError,
  TransferStateError,
  WarehouseNotFoundError,
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
import { getTransferDetail, listTransfers } from '../queries/transfer-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

interface TransferLineInput {
  skuCode: string;
  fromLocationCode?: string;
  toLocationCode?: string;
  batchNo?: string;
  quantity: number;
}

/** 公共行解析：SKU/库位/批次校验 + 序列号管理 SKU 拒绝（防序列号账目漂移） */
function resolveLine(ws: ReturnType<WorkspaceResolver>, line: TransferLineInput): TransferLinePayload {
  const sku = ws.skus.byCode(line.skuCode);
  if (!sku) throw new SkuNotFoundError(line.skuCode);
  if (sku.serialTracked) throw new SerialManagedNotSupportedError(sku.skuCode, '调拨单');
  const from = resolveLocation(ws, line.fromLocationCode);
  const to = resolveLocation(ws, line.toLocationCode);
  if (from.locationId === to.locationId) {
    throw new Error(`TOOL_REJECTED: SKU ${sku.skuCode} 的源库位与目标库位相同——同库位移动请用移库`);
  }
  const batch = resolveBatch(line.batchNo, undefined); // 调拨不带效期（批次属性已在入库登记）
  return {
    skuId: sku.id,
    skuCode: sku.skuCode,
    fromLocationId: from.locationId,
    fromLocationCode: from.locationCode,
    toLocationId: to.locationId,
    toLocationCode: to.locationCode,
    batchNo: batch.batchNo,
    quantity: assertPositiveQty(line.quantity, 'quantity'),
  };
}

export function createTransferTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  type WmsWorkspace = ReturnType<WorkspaceResolver>;
  const transferCreate: ToolDefinition<{
    lines: TransferLineInput[];
    fromWarehouseCode?: string;
    toWarehouseCode?: string;
    transferNo?: string;
    note?: string;
  }> = {
    id: 'wms.transfer.create',
    label: '创建调拨单',
    description:
      '创建一张调拨单（跨仓/跨库位两阶段转移）。每行 = SKU + 源库位 + 目标库位 + 批次 + 数量；源目标库位不能相同（同库位移动请用移库）。fromWarehouseCode / toWarehouseCode 是可选的仓库归属（仅展示与筛选，库存按行的库位走）。生命周期：新建（created）→ wms.transfer.ship 发货（源库位扣减，reason: transfer:单号）→ 在途（inTransit）→ wms.transfer.receive 收货（目标库位加增）→ 已完成；新建阶段可用 wms.transfer.cancel 取消（不动库存）。按序列号管理的 SKU 暂不支持调拨。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description:
            '调拨明细行（至少一行），每行 { skuCode, quantity, fromLocationCode?, toLocationCode?, batchNo? }。quantity 正数支持 3 位小数；fromLocationCode/toLocationCode 缺省 DEFAULT；batchNo 缺省虚拟批次 DEFAULT',
          items: { type: 'object' },
        },
        fromWarehouseCode: { type: 'string', description: '源仓库编码（可选，仅展示归类）' },
        toWarehouseCode: { type: 'string', description: '目标仓库编码（可选，仅展示归类）' },
        transferNo: { type: 'string', description: '调拨单号（可选。不传或空着按编号规则生成）' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['lines'],
    },
    handler: (params, ctx) => {
      const ws: WmsWorkspace = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!params.lines || params.lines.length === 0) throw new TransferNoLinesError();
      const lines = params.lines.map((line) => resolveLine(ws, line));
      const resolveWarehouse = (code: string | undefined): string | null => {
        if (!code) return null;
        const wh = ws.warehouses.byCode(code);
        if (!wh) throw new WarehouseNotFoundError(code);
        return wh.id;
      };
      const transferNo = allocateCode(ws, 'transfer', params.transferNo);
      if (ws.transfers.byNo(transferNo)) throw new TransferExistsError(transferNo);
      const transferId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.transferCreated, {
        transferId,
        transferNo,
        fromWarehouseId: resolveWarehouse(params.fromWarehouseCode),
        toWarehouseId: resolveWarehouse(params.toWarehouseCode),
        lines,
        note: params.note,
      });
      ws.sync();
      return {
        transferId,
        transferNo,
        state: 'created' as const,
        lineCount: lines.length,
      };
    },
  };

  const transferShip: ToolDefinition<{ transferNo: string }> = {
    id: 'wms.transfer.ship',
    label: '调拨发货',
    description:
      '调拨单发货：单据进入在途（inTransit），同时从每行的源库位批次扣减数量（流水 reason: transfer:单号）。源库位余量不足（或已装托盘的可动数量不足）会整体拒绝。只有新建（created）状态的单可发货。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        transferNo: { type: 'string', description: '调拨单号' },
      },
      required: ['transferNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const tr = ws.transfers.byNo(params.transferNo);
      if (!tr) throw new TransferNotFoundError(params.transferNo);
      if (tr.state !== 'created') throw new TransferStateError(params.transferNo, tr.state, '发货');
      const lines = ws.transfers.lines(tr.id);
      // 校验全部行余量充足 + 托盘可动，任一不过整单拒绝（拒绝路径不进事务）
      for (const line of lines) {
        const sku = ws.skus.byId(line.skuId);
        if (!sku) throw new SkuNotFoundError(line.skuId);
        const available = ws.inventory.quantityOf(line.skuId, line.fromLocationId, line.batchNo);
        if (available + QTY_EPS < line.quantity) {
          throw new InsufficientStockError(sku.skuCode, -line.quantity, available);
        }
        assertLooseEnough(ws, {
          skuCode: sku.skuCode,
          skuId: line.skuId,
          locationId: line.fromLocationId,
          locationCode: codeOfLocation(ws, line.fromLocationId),
          batchNo: line.batchNo,
          take: line.quantity,
          onHand: available,
        });
      }
      // 原子落账：状态事实 + 每行扣减流水同生共死（savepoint，杜绝半落账）
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.transferStateChanged, {
          transferId: tr.id,
          transferNo: tr.transferNo,
          from: tr.state,
          to: 'inTransit',
        });
        for (const line of lines) {
          const sku = ws.skus.byId(line.skuId)!;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: line.skuId,
            skuCode: sku.skuCode,
            delta: -line.quantity,
            reason: `transfer:${tr.transferNo}`,
            locationId: line.fromLocationId,
            locationCode: codeOfLocation(ws, line.fromLocationId),
            batchNo: line.batchNo,
          });
        }
      });
      ws.sync();
      return { transferNo: tr.transferNo, state: 'inTransit' as const, shippedLines: lines.length };
    },
  };

  const transferReceive: ToolDefinition<{ transferNo: string }> = {
    id: 'wms.transfer.receive',
    label: '调拨收货',
    description:
      '调拨单收货：单据进入已完成（completed），同时向每行的目标库位批次加增数量（流水 reason: transfer:单号，批次不变）。只有发过货的在途（inTransit）单可收货。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        transferNo: { type: 'string', description: '调拨单号' },
      },
      required: ['transferNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const tr = ws.transfers.byNo(params.transferNo);
      if (!tr) throw new TransferNotFoundError(params.transferNo);
      if (tr.state !== 'inTransit') throw new TransferStateError(params.transferNo, tr.state, '收货');
      const lines = ws.transfers.lines(tr.id);
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.transferStateChanged, {
          transferId: tr.id,
          transferNo: tr.transferNo,
          from: tr.state,
          to: 'completed',
        });
        for (const line of lines) {
          const sku = ws.skus.byId(line.skuId)!;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: line.skuId,
            skuCode: sku.skuCode,
            delta: line.quantity,
            reason: `transfer:${tr.transferNo}`,
            locationId: line.toLocationId,
            locationCode: codeOfLocation(ws, line.toLocationId),
            batchNo: line.batchNo,
          });
        }
      });
      ws.sync();
      return { transferNo: tr.transferNo, state: 'completed' as const, receivedLines: lines.length };
    },
  };

  const transferCancel: ToolDefinition<{ transferNo: string }> = {
    id: 'wms.transfer.cancel',
    label: '取消调拨单',
    description:
      '取消调拨单（不动库存）。只有新建（created）状态的单可取消——已发货的在途单不能取消（货已出库），请先收货。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        transferNo: { type: 'string', description: '调拨单号' },
      },
      required: ['transferNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const tr = ws.transfers.byNo(params.transferNo);
      if (!tr) throw new TransferNotFoundError(params.transferNo);
      if (tr.state !== 'created') throw new TransferStateError(params.transferNo, tr.state, '取消');
      ctx.appendEvent(WMS_EVENT_TYPES.transferStateChanged, {
        transferId: tr.id,
        transferNo: tr.transferNo,
        from: tr.state,
        to: 'canceled',
      });
      ws.sync();
      return { transferNo: tr.transferNo, state: 'canceled' as const };
    },
  };

  const transferQuery: ToolDefinition<{ transferNo?: string }> = {
    id: 'wms.transfer.query',
    label: '查询调拨单',
    description:
      '查询调拨单。不给 transferNo 返回全部调拨单清单（单号、状态、源/目标仓库、行数）；给 transferNo 返回单张明细：逐行 SKU×源库位→目标库位×批次的数量。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        transferNo: { type: 'string', description: '调拨单号（可选，缺省列出全部）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!params.transferNo) {
        return listTransfers(ws).map((t) => ({
          transferNo: t.transferNo,
          state: t.state,
          fromWarehouse: t.fromWarehouse,
          toWarehouse: t.toWarehouse,
          note: t.note,
          createdAt: t.createdAt,
          lineCount: t.lineCount,
        }));
      }
      const tr = ws.transfers.byNo(params.transferNo);
      if (!tr) throw new TransferNotFoundError(params.transferNo);
      const detail = getTransferDetail(ws, tr);
      return {
        transferNo: detail.transferNo,
        state: detail.state,
        fromWarehouse: detail.fromWarehouse,
        toWarehouse: detail.toWarehouse,
        note: detail.note,
        createdAt: detail.createdAt,
        lines: detail.lines.map((line) => ({
          skuCode: line.skuCode,
          name: line.name,
          fromLocationCode: line.fromLocationCode,
          toLocationCode: line.toLocationCode,
          batchNo: line.batchNo,
          quantity: line.quantity,
        })),
      };
    },
  };

  return [def(transferCreate), def(transferShip), def(transferReceive), def(transferCancel), def(transferQuery)];
}
