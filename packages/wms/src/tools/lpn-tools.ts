import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  InsufficientStockError,
  LpnAlreadyExistsError,
  LpnNotFoundError,
  LpnPackedError,
  SerialDisabledError,
  SkuNotFoundError,
} from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { listLpns, lpnStock } from '../queries/lpn-queries.js';
import {
  assertPositiveQty,
  bucketLabel,
  codeOfLocation,
  QTY_EPS,
  quantizeQty,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { assertLpnEnabled } from '../state/lpn-policy.js';
import { planQuantitySerials, appendSerialPlans, serialEnabled } from '../state/serial-policy.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 托盘（module.lpn）。
 * 装托不改库存数量，只占用桶里已有的货。整托移动自己写一对 ± 流水，不调用移库工具。
 * 工具不进 core.wms 的 tools 数组。
 */
export function createLpnTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const lpnCreate: ToolDefinition<{ lpnCode?: string; locationCode?: string }> = {
    id: 'wms.lpn.create',
    label: '创建托盘',
    description:
      '建一个空托盘。lpnCode 全库唯一，不传或空着则按编号规则（lpn）生成，传了就用传入的。locationCode 缺省为虚拟库位 DEFAULT。停用 module.lpn 后本工具拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lpnCode: { type: 'string', description: '托盘编码（可选。不传或空着按编号规则生成，如 LPN-0001）' },
        locationCode: { type: 'string', description: '所在库位（可选，缺省 DEFAULT）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertLpnEnabled(ws);
      const lpnCode = allocateCode(ws, 'lpn', params.lpnCode);
      if (ws.lpns.byCode(lpnCode)) throw new LpnAlreadyExistsError(lpnCode);
      const loc = resolveLocation(ws, params.locationCode);
      const lpnId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.lpnCreated, { lpnId, lpnCode, locationId: loc.locationId });
      ws.sync();
      return { lpnId, lpnCode, locationCode: loc.locationCode };
    },
  };

  const lpnPack: ToolDefinition<{
    lpnCode: string;
    skuCode: string;
    quantity: number;
    batchNo?: string;
    serials?: string[];
  }> = {
    id: 'wms.lpn.pack',
    label: '装托',
    description:
      '把托盘当前库位上的散货装进托盘。不产生库存流水，件数还在原库位。装的数量不能超过该桶还没装托的余量。SKU 按序列号管理时必须带上 serials，个数等于件数，且这些号还没装过托。停用 module.lpn 后本工具拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lpnCode: { type: 'string', description: '托盘编码' },
        skuCode: { type: 'string', description: 'SKU 编码' },
        quantity: { type: 'number', minimum: 0.001, maximum: 1000000000, description: '本次装入件数' },
        batchNo: { type: 'string', description: '批次（可选，缺省 DEFAULT）' },
        serials: { type: 'array', items: { type: 'string' }, description: '序列号（按序列号管理时必填）' },
      },
      required: ['lpnCode', 'skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertLpnEnabled(ws);
      if (Object.hasOwn(params, 'serials') && !serialEnabled(ws)) throw new SerialDisabledError();
      const lpnCode = typeof params.lpnCode === 'string' ? params.lpnCode.trim() : '';
      const lpn = lpnCode ? ws.lpns.byCode(lpnCode) : undefined;
      if (!lpn) throw new LpnNotFoundError(lpnCode || '(空)');
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const quantity = assertPositiveQty(params.quantity, 'quantity');
      const batch = resolveBatch(params.batchNo, undefined);
      const onHand = ws.inventory.quantityOf(sku.id, lpn.locationId, batch.batchNo);
      const packed = ws.lpns.packedAt(lpn.locationId, sku.id, batch.batchNo);
      const loose = quantizeQty(onHand - packed);
      if (loose + QTY_EPS < quantity) {
        throw new LpnPackedError(
          bucketLabel(sku.skuCode, codeOfLocation(ws, lpn.locationId), batch.batchNo),
          quantity,
          loose > 0 ? loose : 0,
        );
      }
      const plans = planQuantitySerials(ws, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialTracked: sku.serialTracked,
        hasSerials: Object.hasOwn(params, 'serials'),
        serials: params.serials,
        quantity,
        locationId: lpn.locationId,
        batchNo: batch.batchNo,
        direction: 'move',
        toLocationId: lpn.locationId,
        toBatchNo: batch.batchNo,
        setLpn: true,
        lpnId: lpn.id,
      });
      const existing = ws.lpns.lineOf(lpn.id, sku.id, batch.batchNo);
      const lineId = existing?.id ?? randomUUID();
      const nextQty = quantizeQty((existing?.quantity ?? 0) + quantity);
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.lpnPacked, {
          lpnId: lpn.id,
          lineId,
          skuId: sku.id,
          batchNo: batch.batchNo,
          quantity: nextQty,
        });
        appendSerialPlans(ctx, plans);
      });
      ws.sync();
      return { lpnCode: lpn.lpnCode, skuCode: sku.skuCode, batchNo: batch.batchNo, quantity: nextQty };
    },
  };

  const lpnUnpack: ToolDefinition<{
    lpnCode: string;
    skuCode: string;
    quantity: number;
    batchNo?: string;
    serials?: string[];
  }> = {
    id: 'wms.lpn.unpack',
    label: '卸托',
    description:
      '从托盘上卸下一部分货，货仍留在托盘当前库位。不产生库存流水。按序列号管理时必须带上要卸下的序列号。停用 module.lpn 后本工具拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lpnCode: { type: 'string', description: '托盘编码' },
        skuCode: { type: 'string', description: 'SKU 编码' },
        quantity: { type: 'number', minimum: 0.001, maximum: 1000000000, description: '本次卸下件数' },
        batchNo: { type: 'string', description: '批次（可选，缺省 DEFAULT）' },
        serials: { type: 'array', items: { type: 'string' }, description: '序列号（按序列号管理时必填）' },
      },
      required: ['lpnCode', 'skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertLpnEnabled(ws);
      if (Object.hasOwn(params, 'serials') && !serialEnabled(ws)) throw new SerialDisabledError();
      const lpnCode = typeof params.lpnCode === 'string' ? params.lpnCode.trim() : '';
      const lpn = lpnCode ? ws.lpns.byCode(lpnCode) : undefined;
      if (!lpn) throw new LpnNotFoundError(lpnCode || '(空)');
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const quantity = assertPositiveQty(params.quantity, 'quantity');
      const batch = resolveBatch(params.batchNo, undefined);
      const existing = ws.lpns.lineOf(lpn.id, sku.id, batch.batchNo);
      const have = existing?.quantity ?? 0;
      if (have + QTY_EPS < quantity) {
        throw new LpnPackedError(
          bucketLabel(sku.skuCode, codeOfLocation(ws, lpn.locationId), batch.batchNo),
          quantity,
          have,
        );
      }
      const plans = planQuantitySerials(ws, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialTracked: sku.serialTracked,
        hasSerials: Object.hasOwn(params, 'serials'),
        serials: params.serials,
        quantity,
        locationId: lpn.locationId,
        batchNo: batch.batchNo,
        direction: 'move',
        toLocationId: lpn.locationId,
        toBatchNo: batch.batchNo,
        allowPacked: true,
        setLpn: true,
        lpnId: null,
        requireLpnId: lpn.id,
      });
      const nextQty = quantizeQty(have - quantity);
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.lpnPacked, {
          lpnId: lpn.id,
          lineId: existing!.id,
          skuId: sku.id,
          batchNo: batch.batchNo,
          quantity: nextQty,
        });
        appendSerialPlans(ctx, plans);
      });
      ws.sync();
      return { lpnCode: lpn.lpnCode, skuCode: sku.skuCode, batchNo: batch.batchNo, quantity: nextQty };
    },
  };

  const lpnMove: ToolDefinition<{ lpnCode: string; toLocationCode: string }> = {
    id: 'wms.lpn.move',
    label: '移托盘',
    description:
      '把整个托盘移到另一个库位。托盘上的每一行都写一对库存流水（-源 / +目标，reason lpn:托盘号），已装上的序列号一起过去。源库位余量不够（例如模块关掉时被调走了）会拒绝。目标与当前库位相同会拒绝。停用 module.lpn 后本工具拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        lpnCode: { type: 'string', description: '托盘编码' },
        toLocationCode: { type: 'string', description: '目标库位编码' },
      },
      required: ['lpnCode', 'toLocationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertLpnEnabled(ws);
      const lpnCode = typeof params.lpnCode === 'string' ? params.lpnCode.trim() : '';
      const lpn = lpnCode ? ws.lpns.byCode(lpnCode) : undefined;
      if (!lpn) throw new LpnNotFoundError(lpnCode || '(空)');
      const to = resolveLocation(ws, params.toLocationCode);
      if (to.locationId === lpn.locationId) throw new Error('TOOL_REJECTED: 源库位与目标库位相同');
      const lines = ws.lpns.lines(lpn.id);
      for (const line of lines) {
        const onHand = ws.inventory.quantityOf(line.skuId, lpn.locationId, line.batchNo);
        if (onHand + QTY_EPS < line.quantity) {
          const sku = ws.skus.byId(line.skuId);
          throw new InsufficientStockError(
            bucketLabel(sku?.skuCode ?? line.skuId, codeOfLocation(ws, lpn.locationId), line.batchNo),
            -line.quantity,
            onHand,
          );
        }
      }
      const plans = serialEnabled(ws)
        ? ws.serials
            .list({ lpnId: lpn.id, status: 'in' })
            .filter((row) => ws.skus.byId(row.skuId)?.serialTracked)
            .flatMap((row) =>
              planQuantitySerials(ws, {
                skuId: row.skuId,
                skuCode: ws.skus.byId(row.skuId)?.skuCode ?? row.skuId,
                serialTracked: true,
                hasSerials: true,
                serials: [row.serialNo],
                quantity: 1,
                locationId: row.locationId,
                batchNo: row.batchNo,
                direction: 'move',
                toLocationId: to.locationId,
                toBatchNo: row.batchNo,
                allowPacked: true,
                requireLpnId: lpn.id,
              }),
            )
        : [];
      const fromCode = codeOfLocation(ws, lpn.locationId);
      const reason = `lpn:${lpn.lpnCode}`;
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.lpnMoved, {
          lpnId: lpn.id,
          lpnCode: lpn.lpnCode,
          locationId: to.locationId,
        });
        for (const line of lines) {
          const sku = ws.skus.byId(line.skuId);
          const skuCode = sku?.skuCode ?? line.skuId;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: line.skuId,
            skuCode,
            delta: -line.quantity,
            reason,
            locationId: lpn.locationId,
            locationCode: fromCode,
            batchNo: line.batchNo,
          });
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: line.skuId,
            skuCode,
            delta: line.quantity,
            reason,
            locationId: to.locationId,
            locationCode: to.locationCode,
            batchNo: line.batchNo,
          });
        }
        appendSerialPlans(ctx, plans);
      });
      ws.sync();
      return {
        lpnCode: lpn.lpnCode,
        from: fromCode,
        to: to.locationCode,
        lines: lines.map((line) => ({
          skuCode: ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
          batchNo: line.batchNo,
          quantity: line.quantity,
        })),
      };
    },
  };

  const lpnList: ToolDefinition<Record<string, never>> = {
    id: 'wms.lpn.list',
    label: '查托盘',
    description: '列出托盘（编码、所在库位、行数）。停用 module.lpn 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => listLpns(resolveWorkspace(ctx.workspaceId)),
  };

  const lpnStockTool: ToolDefinition<{ lpnCode: string }> = {
    id: 'wms.lpn.stock',
    label: '查托盘库存',
    description: '列出某个托盘上的 SKU、批次和件数。托盘不存在会报错。停用 module.lpn 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        lpnCode: { type: 'string', description: '托盘编码' },
      },
      required: ['lpnCode'],
    },
    handler: (params, ctx) => lpnStock(resolveWorkspace(ctx.workspaceId), params.lpnCode ?? ''),
  };

  return [def(lpnCreate), def(lpnPack), def(lpnUnpack), def(lpnMove), def(lpnList), def(lpnStockTool)];
}
