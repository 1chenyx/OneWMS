import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES, type SkuPackageDef } from '../events/catalog.js';
import { SkuAlreadyExistsError, SkuNotFoundError } from '../errors.js';
import { def, type WorkspaceResolver } from './tool-def.js';
import { assertCanTrack, rejectSerialTrackedWhenOff } from '../state/serial-policy.js';
import { allocateCode } from '../numbering/allocate.js';
import {
  assertBarcodeFree,
  normalizeBarcode,
  normalizePackages,
  resolveVariantAttachment,
} from './tool-guards.js';

/** 包装单位数组的参数声明（create/update 共用；独立 const 避开内联字面量的 excess check） */
const packagesSchema = {
  type: 'array',
  description:
    '包装单位（可选，换算）：[{unit, ratio}]，1 个包装单位 = ratio 个基本单位（unit 字段），如 [{"unit":"箱","ratio":24}]。单据行选包装单位录入时自动换算成基本单位入账；须先有基本单位，包名互不重名且不与基本单位重名',
  items: {
    type: 'object',
    properties: {
      unit: { type: 'string', description: '包装单位名，如 箱 / 包' },
      ratio: { type: 'number', description: '换算比例：1 个包装单位 = N 个基本单位（正数）' },
    },
    required: ['unit', 'ratio'],
  },
} as const;

export function createSkuTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const skuCreate: ToolDefinition<{
    skuCode?: string;
    name: string;
    barcode?: string;
    reorderPoint?: number;
    unit?: string;
    packages?: SkuPackageDef[];
    serialTracked?: boolean;
    productCode?: string;
    variantAttrs?: Record<string, string>;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.create',
    label: '创建 SKU',
    description:
      '创建一个新的 SKU（库存商品）。skuCode 是全库唯一的商品编码，不传或空着则按编号规则（sku）生成；挂多规格商品时不传 skuCode 会自动生成「商品码-取值」样式（如 T-SHIRT-红-S）。name 是商品名称；可选 barcode 条码（扫码枪识读用，同库唯一，多个 SKU 不可共用）；可选 reorderPoint 安全库存（低库存预警阈值，可用量低于它时进预警清单，0 或不传 = 不预警）；可选 unit 数量单位（如 kg / 箱 / 件，散装称重商品建议填写，单据与标签会跟随显示）——定义包装换算时它是基本单位；可选 packages 包装单位（如 [{"unit":"箱","ratio":24}] = 1 箱 = 24 个基本单位；单据行可选包装单位录入，系统自动换算成基本单位入账，库存恒按基本单位记）；多规格：productCode 挂到所属商品（wms.product.create 先建并声明 specDims），variantAttrs 声明规格组合（如 {"颜色":"红","尺码":"S"}，键值须与商品维度对齐，同商品下组合唯一）；可选 extData 携带自定义扩展字段（如规格、保质期）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 唯一编码（可选。不传或空着按编号规则生成，如 SKU-00001）' },
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
        packages: { ...packagesSchema },
        serialTracked: {
          type: 'boolean',
          description: '按序列号管理（可选，module.serial）。true = 之后收发必须写每一件的序列号。不传 = 否',
        },
        productCode: {
          type: 'string',
          description: '所属商品编码（可选，多规格）。先用 wms.product.create 建商品并声明规格维度',
        },
        variantAttrs: {
          type: 'object',
          description:
            '规格组合（可选，多规格）：维度名→取值，如 {"颜色":"红","尺码":"S"}；须与商品 specDims 对齐，同商品下组合唯一',
        },
        extData: { type: 'object', description: '扩展字段键值对（字段注册表声明的自定义字段）' },
      },
      required: ['name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      rejectSerialTrackedWhenOff(ws, params);
      if (params.serialTracked !== undefined && typeof params.serialTracked !== 'boolean') {
        throw new Error('TOOL_REJECTED: serialTracked 必须是布尔值');
      }
      const attach = resolveVariantAttachment(ws, params);
      const skuCode = allocateCode(ws, 'sku', params.skuCode ?? attach?.defaultSkuCode ?? undefined);
      if (ws.skus.byCode(skuCode)) {
        throw new SkuAlreadyExistsError(skuCode);
      }
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode);
      // 单位（A3）：空白 = 未设置（存 NULL）；不约束词表（kg / 箱 / 件 / 自定义皆可）。
      // 定义了包装换算时它是基本单位（换算分母）
      const unit = params.unit?.trim() || undefined;
      // 包装单位（换算）：整体下发；先校验（须有基本单位）
      const packages = params.packages === undefined ? undefined : normalizePackages(params.packages, unit ?? null);
      const skuId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.skuCreated, {
        skuId,
        skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
        unit,
        ...(packages && packages.length > 0 ? { packages } : {}),
        ...(params.serialTracked === true ? { serialTracked: true } : {}),
        ...(attach
          ? {
              productId: attach.product.id,
              ...(attach.variantAttrs ? { variantAttrs: attach.variantAttrs } : {}),
            }
          : {}),
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId,
        skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint ?? 0,
        unit: unit ?? null,
        ...(packages && packages.length > 0 ? { packages } : {}),
        ...(attach ? { productCode: attach.product.productCode, variantAttrs: attach.variantAttrs } : {}),
      };
    },
  };

  const skuUpdate: ToolDefinition<{
    skuCode: string;
    name?: string;
    barcode?: string;
    reorderPoint?: number;
    unit?: string;
    packages?: SkuPackageDef[];
    serialTracked?: boolean;
    productCode?: string;
    variantAttrs?: Record<string, string>;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.sku.update',
    label: '更新 SKU',
    description:
      '更新已有 SKU 的名称、条码、安全库存、单位、包装单位、规格挂靠或扩展字段。只传需要修改的字段，未传字段保持不变。barcode 条码同库唯一（已绑定其他 SKU 的条码会被拒绝）；reorderPoint 显式传才改（传 0 = 关闭该 SKU 的低库存预警）；unit 传空串 = 清空单位；packages 包装单位整体替换（如 [{"unit":"箱","ratio":24}]，传 [] = 清空全部包装单位；改比例只影响之后开的单据，已开单的录入快照不变）；多规格：productCode 换挂商品（目标须启用中，组合对齐其 specDims 且同商品下不被占用），variantAttrs 改组合（不传 productCode 时沿用现挂商品）；不支持脱挂回独立商品——历史单据引用关系保持稳定。停用/启用走 wms.sku.archive / wms.sku.unarchive。',
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
        packages: { ...packagesSchema, description: `${packagesSchema.description}（更新时整体替换；不传 = 不改，传 [] = 清空。改比例或删包装不影响已开单据）` },
        serialTracked: {
          type: 'boolean',
          description: '按序列号管理（可选，module.serial）。不传 = 不改。已有库存不能改成按号管理；还有在库序列号不能取消',
        },
        productCode: {
          type: 'string',
          description: '换挂的商品编码（可选，多规格）。目标商品须启用中；不传 = 沿用现挂商品',
        },
        variantAttrs: {
          type: 'object',
          description:
            '新的规格组合（可选，多规格）：维度名→取值。沿用现挂商品时不传 = 不改组合；换挂到别的商品必须重新给（目标商品无维度则自动清空旧组合）',
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
      const attach = resolveVariantAttachment(ws, params, {
        skuId: sku.id,
        productId: sku.productId,
        variantAttrs: sku.variantAttrs,
      });
      const barcode = params.barcode === undefined ? undefined : normalizeBarcode(params.barcode);
      if (barcode) assertBarcodeFree(ws, barcode, sku.id);
      // 单位（A3）：undefined = 不改；trim 后空串 = 清空（存 ''，读取层归一成 null）
      const unit = params.unit === undefined ? undefined : params.unit.trim();
      // 包装单位（换算）：undefined = 不改；[] = 清空；否则整体替换。
      // 基本单位取「本次新值 ?? 现值」——把 unit 和 packages 一起改也一次过
      const effectiveUnit = (unit ?? (sku.unit || null)) || null;
      const packages =
        params.packages === undefined ? undefined : normalizePackages(params.packages, effectiveUnit);
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: params.name,
        barcode,
        reorderPoint: params.reorderPoint,
        unit,
        ...(packages !== undefined ? { packages } : {}),
        ...(Object.hasOwn(params, 'serialTracked') ? { serialTracked: params.serialTracked } : {}),
        ...(attach
          ? {
              productId: attach.product.id,
              // 换挂到无维度商品 = 显式清空旧组合（{} 在读取层归一成 null）
              ...(attach.variantAttrs
                ? { variantAttrs: attach.variantAttrs }
                : sku.variantAttrs
                  ? { variantAttrs: {} }
                  : {}),
            }
          : {}),
        extData: params.extData,
      });
      ws.sync();
      return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        barcode: barcode ?? sku.barcode,
        reorderPoint: params.reorderPoint ?? sku.reorderPoint,
        unit: unit === undefined ? sku.unit : unit || null,
        packages: packages === undefined ? (sku.packages ?? null) : packages.length > 0 ? packages : null,
        ...(attach ? { productCode: attach.product.productCode, variantAttrs: attach.variantAttrs } : {}),
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
