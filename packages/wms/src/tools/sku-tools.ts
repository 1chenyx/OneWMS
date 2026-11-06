import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { SkuAlreadyExistsError, SkuNotFoundError } from '../errors.js';
import { def, type WorkspaceResolver } from './tool-def.js';
import { assertBarcodeFree, normalizeBarcode } from './tool-guards.js';

export function createSkuTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const skuCreate: ToolDefinition<{
    skuCode: string;
    name: string;
    barcode?: string;
    reorderPoint?: number;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.create',
    label: '创建 SKU',
    description:
      '创建一个新的 SKU（库存商品）。skuCode 是全库唯一的商品编码，name 是商品名称；可选 barcode 条码（扫码枪识读用，同库唯一，多个 SKU 不可共用）；可选 reorderPoint 安全库存（低库存预警阈值，可用量低于它时进预警清单，0 或不传 = 不预警）；可选 extData 携带自定义扩展字段（如规格、保质期）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 唯一编码，如 A-1001' },
        name: { type: 'string', description: '商品名称' },
        barcode: {
          type: 'string',
          description: '商品条码（可选，如 EAN-13 / Code128；扫码枪识读用，同库唯一）',
        },
        reorderPoint: {
          type: 'integer',
          minimum: 0,
          maximum: 1000000000,
          description: '安全库存（可选，低库存预警阈值；可用量 < 此值时预警，0 或不传 = 不预警）',
        },
        extData: { type: 'object', description: '扩展字段键值对（字段注册表声明的自定义字段）' },
      },
      required: ['skuCode', 'name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (ws.skus.byCode(params.skuCode)) {
        throw new SkuAlreadyExistsError(params.skuCode);
      }
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode);
      const skuId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.skuCreated, {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
      };
    },
  };

  const skuUpdate: ToolDefinition<{
    skuCode: string;
    name?: string;
    barcode?: string;
    reorderPoint?: number;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.update',
    label: '更新 SKU',
    description:
      '更新已有 SKU 的名称、条码、安全库存或扩展字段。只传需要修改的字段，未传字段保持不变。barcode 条码同库唯一（已绑定其他 SKU 的条码会被拒绝）；reorderPoint 显式传才改（传 0 = 关闭该 SKU 的低库存预警）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: '要更新的 SKU 编码' },
        name: { type: 'string', description: '新的商品名称（可选）' },
        barcode: {
          type: 'string',
          description: '新的商品条码（可选；不传保持不变，传了即绑定——同库唯一）',
        },
        reorderPoint: {
          type: 'integer',
          minimum: 0,
          maximum: 1000000000,
          description: '新的安全库存（可选；不传保持不变，传 0 = 关闭低库存预警）',
        },
        extData: { type: 'object', description: '新的扩展字段（可选，整体替换）' },
      },
      required: ['skuCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode, sku.id);
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint,
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        barcode: barcode ?? sku.barcode,
        reorderPoint: params.reorderPoint ?? sku.reorderPoint,
      };
    },
  };

  const skuResolve: ToolDefinition<{ barcode: string }> = {
    id: 'wms.sku.resolve',
    label: '条码解析',
    description:
      '按条码解析 SKU：给定扫码枪扫出的条码（同库唯一），返回对应的 SKU（skuId、编码、名称、条码）。条码未登记会报 SKU 不存在。纯读操作——幂等，不产生事件。扫码枪录入单据/盘点前先经本工具换算成 SKU 编码。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        barcode: { type: 'string', description: '扫出的商品条码' },
      },
      required: ['barcode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byBarcode(params.barcode.trim());
      if (!sku) throw new SkuNotFoundError(params.barcode);
      return { skuId: sku.id, skuCode: sku.skuCode, name: sku.name, barcode: sku.barcode };
    },
  };

  return [def(skuCreate), def(skuUpdate), def(skuResolve)];
}
