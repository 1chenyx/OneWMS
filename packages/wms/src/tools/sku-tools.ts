import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { SkuAlreadyExistsError, SkuNotFoundError } from '../errors.js';
import { def, type WorkspaceResolver } from './tool-def.js';
import { assertCanTrack, rejectSerialTrackedWhenOff } from '../state/serial-policy.js';
import { assertBarcodeFree, normalizeBarcode } from './tool-guards.js';

export function createSkuTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const skuCreate: ToolDefinition<{
    skuCode: string;
    name: string;
    barcode?: string;
    reorderPoint?: number;
    unit?: string;
    serialTracked?: boolean;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.create',
    label: '创建 SKU',
    description:
      '创建一个新的 SKU（库存商品）。skuCode 是全库唯一的商品编码，name 是商品名称；可选 barcode 条码（扫码枪识读用，同库唯一，多个 SKU 不可共用）；可选 reorderPoint 安全库存（低库存预警阈值，可用量低于它时进预警清单，0 或不传 = 不预警）；可选 unit 数量单位（如 kg / 箱 / 件，散装称重商品建议填写，单据与标签会跟随显示）；可选 extData 携带自定义扩展字段（如规格、保质期）。',
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
        unit: { type: 'string', description: '数量单位（可选，如 kg / 箱 / 件；不传 = 数量不带单位）' },
        serialTracked: {
          type: 'boolean',
          description: '按序列号管理（可选，module.serial）。true = 之后收发必须写每一件的序列号。不传 = 否',
        },
        extData: { type: 'object', description: '扩展字段键值对（字段注册表声明的自定义字段）' },
      },
      required: ['skuCode', 'name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      rejectSerialTrackedWhenOff(ws, params);
      if (params.serialTracked !== undefined && typeof params.serialTracked !== 'boolean') {
        throw new Error('TOOL_REJECTED: serialTracked 必须是布尔值');
      }
      if (ws.skus.byCode(params.skuCode)) {
        throw new SkuAlreadyExistsError(params.skuCode);
      }
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode);
      // 单位（A3）：空白 = 未设置（存 NULL）；不约束词表（kg / 箱 / 件 / 自定义皆可）
      const unit = params.unit?.trim() || undefined;
      const skuId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.skuCreated, {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
        unit,
        ...(params.serialTracked === true ? { serialTracked: true } : {}),
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
        unit: unit ?? null,
      };
    },
  };

  const skuUpdate: ToolDefinition<{
    skuCode: string;
    name?: string;
    barcode?: string;
    reorderPoint?: number;
    unit?: string;
    serialTracked?: boolean;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.update',
    label: '更新 SKU',
    description:
      '更新已有 SKU 的名称、条码、安全库存、单位或扩展字段。只传需要修改的字段，未传字段保持不变。barcode 条码同库唯一（已绑定其他 SKU 的条码会被拒绝）；reorderPoint 显式传才改（传 0 = 关闭该 SKU 的低库存预警）；unit 传空串 = 清空单位。停用/启用走 wms.sku.archive / wms.sku.unarchive。',
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
        unit: { type: 'string', description: '新的数量单位（可选；不传保持不变，传空串 = 清空）' },
        serialTracked: {
          type: 'boolean',
          description: '按序列号管理（可选，module.serial）。不传 = 不改。已有库存不能改成按号管理；还有在库序列号不能取消',
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
      rejectSerialTrackedWhenOff(ws, params);
      if (Object.hasOwn(params, 'serialTracked')) {
        if (typeof params.serialTracked !== 'boolean') {
          throw new Error('TOOL_REJECTED: serialTracked 必须是布尔值');
        }
        assertCanTrack(ws, sku.id, sku.skuCode, params.serialTracked);
      }
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode, sku.id);
      // 单位（A3）：undefined = 不改；trim 后空串 = 清空（存 ''，读取层归一成 null）
      const unit = params.unit === undefined ? undefined : params.unit.trim();
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint,
        unit,
        ...(Object.hasOwn(params, 'serialTracked') ? { serialTracked: params.serialTracked } : {}),
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        barcode: barcode ?? sku.barcode,
        reorderPoint: params.reorderPoint ?? sku.reorderPoint,
        unit: unit === undefined ? sku.unit : unit || null,
      };
    },
  };

  // ── A2 软停用：archive/unarchive 是薄工具——复用 sku.updated 的 LWW 语义
  //    写 status 字段，不新增事件类型；已处于目标状态 = 零事件直接返回（不落冗余账）。
  //    软停用语义：隐藏 + 退出预警；剩余库存照常可扣（扫码/直接引用不拦），数据一条不动。
  const skuArchive: ToolDefinition<{ skuCode: string }> = {
    id: 'wms.sku.archive',
    label: '停用 SKU',
    description:
      '软停用一个 SKU（建错/不再经营的档案）。停用后：SKU 列表默认隐藏、新建单据与各处选择器不再出现、退出低库存与效期预警；剩余库存不受影响，仍可正常出库出清（扫码/直接引用不会被拦）。数据不删除——历史单据与流水完整保留，wms.sku.unarchive 可随时恢复。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: '要停用的 SKU 编码' },
      },
      required: ['skuCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if ((sku.status ?? 'active') === 'archived') {
        return { skuId: sku.id, skuCode: sku.skuCode, status: 'archived' }; // 已停用：幂等零事件
      }
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        status: 'archived',
      });
      ws.sync();
      return { skuId: sku.id, skuCode: sku.skuCode, status: 'archived' };
    },
  };

  const skuUnarchive: ToolDefinition<{ skuCode: string }> = {
    id: 'wms.sku.unarchive',
    label: '启用 SKU',
    description:
      '恢复一个已停用的 SKU（wms.sku.archive 的逆操作）：重新出现在 SKU 列表、选择器与预警里。库存数据在停用期间原样保留。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: '要恢复的 SKU 编码' },
      },
      required: ['skuCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if ((sku.status ?? 'active') === 'active') {
        return { skuId: sku.id, skuCode: sku.skuCode, status: 'active' }; // 已启用：幂等零事件
      }
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        status: 'active',
      });
      ws.sync();
      return { skuId: sku.id, skuCode: sku.skuCode, status: 'active' };
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

  return [def(skuCreate), def(skuUpdate), def(skuArchive), def(skuUnarchive), def(skuResolve)];
}
