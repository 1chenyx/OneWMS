import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES, type ProductSpecDim } from '../events/catalog.js';
import {
  ProductAlreadyExistsError,
  ProductNotFoundError,
  SpecDimInUseError,
} from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { def, type WorkspaceResolver } from './tool-def.js';
import { normalizeSpecDims } from './tool-guards.js';

/**
 * 商品工具（多规格 SPU 层）——SKU 的上一级归组。
 * 护栏三步与 sku-tools / partner-tools 同款：sync → 校验（拒绝零事件）→
 * appendEvent → sync。商品不参与库存维度：每个规格组合仍是一个 SKU
 * （wms.sku.create 的 productCode + variantAttrs 挂回商品）。
 */

const specDimsSchema = {
  type: 'array',
  description:
    '规格维度定义（可选）。如 [{"name":"颜色","values":["红","黑"]},{"name":"尺码","values":["S","M"]}]；不传 = 无维度（单规格归组）',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '维度名，如 颜色 / 尺码' },
      values: {
        type: 'array',
        items: { type: 'string' },
        description: '该维度的全部取值，顺序即展示序',
      },
    },
    required: ['name', 'values'],
  },
} as const;

export function createProductTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const productCreate: ToolDefinition<{
    productCode?: string;
    name: string;
    specDims?: ProductSpecDim[];
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.product.create',
    label: '创建商品',
    description:
      '创建一个商品（多规格 SPU，SKU 的上一级归组）。productCode 全库唯一，不传或空着则按编号规则生成（如 PRD-0001）；name 名称必填；specDims 声明规格维度（如 颜色×尺码），每个规格组合再用 wms.sku.create 挂到该商品下（productCode + variantAttrs），自动生成「商品码-取值」样式的 SKU 编码。商品本身不记库存——条码/单位/安全库存都在 SKU 上。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        productCode: { type: 'string', description: '商品唯一编码（可选。不传或空着按编号规则生成，如 PRD-0001）' },
        name: { type: 'string', description: '商品名称' },
        specDims: specDimsSchema,
        extData: { type: 'object', description: '扩展字段键值对（可选）' },
      },
      required: ['name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const productCode = allocateCode(ws, 'product', params.productCode);
      if (ws.products.byCode(productCode)) {
        throw new ProductAlreadyExistsError(productCode);
      }
      const specDims = params.specDims === undefined ? [] : normalizeSpecDims(params.specDims);
      const productId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.productCreated, {
        productId,
        productCode,
        name: params.name,
        specDims,
        extData: params.extData,
      });
      ws.sync();
      return { productId, productCode, name: params.name, specDims };
    },
  };

  const productUpdate: ToolDefinition<{
    productCode: string;
    name?: string;
    specDims?: ProductSpecDim[];
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.product.update',
    label: '更新商品',
    description:
      '更新商品的名称、规格维度定义或扩展字段。只传需要修改的字段，未传保持不变。specDims 整体替换，且必须与已挂 SKU 的规格组合严丝合缝：删除在用的维度/取值会被拒绝，新增维度要求已挂 SKU 都补上了该维度的取值（先 wms.sku.update 补组合）。productCode 是业务键不可改。停用/启用走 wms.product.archive / wms.product.unarchive。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        productCode: { type: 'string', description: '要更新的商品编码' },
        name: { type: 'string', description: '新的商品名称（可选）' },
        specDims: { ...specDimsSchema, description: `${specDimsSchema.description}（更新时整体替换）` },
        extData: { type: 'object', description: '新的扩展字段（可选，整体替换）' },
      },
      required: ['productCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const product = ws.products.byCode(params.productCode);
      if (!product) throw new ProductNotFoundError(params.productCode);

      let specDims: ProductSpecDim[] | undefined;
      if (params.specDims !== undefined) {
        specDims = params.specDims.length === 0 ? [] : normalizeSpecDims(params.specDims);
        assertDimsKeepAttachments(product, specDims, ws.skus.byProduct(product.id));
      }
      ctx.appendEvent(WMS_EVENT_TYPES.productUpdated, {
        productId: product.id,
        productCode: product.productCode,
        name: params.name,
        specDims,
        extData: params.extData,
      });
      ws.sync();
      return {
        productId: product.id,
        productCode: product.productCode,
        name: params.name ?? product.name,
        specDims: specDims ?? product.specDims,
      };
    },
  };

  // ── A2 软停用先例：archive/unarchive 是薄工具——复用 product.updated 的
  //    LWW 语义写 status；已处于目标状态 = 零事件直接返回。
  //    停用语义：商品列表隐藏、不再允许新挂/改挂规格；已挂 SKU 与库存照常。
  const productArchive: ToolDefinition<{ productCode: string }> = {
    id: 'wms.product.archive',
    label: '停用商品',
    description:
      '软停用一个商品（不再经营的多规格商品）。停用后：商品列表默认隐藏、SKU 不能再挂到它下面或改规格；已挂的 SKU 与库存不受影响，照常出入库。数据不删除，wms.product.unarchive 可随时恢复。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        productCode: { type: 'string', description: '要停用的商品编码' },
      },
      required: ['productCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const product = ws.products.byCode(params.productCode);
      if (!product) throw new ProductNotFoundError(params.productCode);
      if (product.status === 'archived') {
        return { productId: product.id, productCode: product.productCode, status: 'archived' }; // 已停用：幂等零事件
      }
      ctx.appendEvent(WMS_EVENT_TYPES.productUpdated, {
        productId: product.id,
        productCode: product.productCode,
        status: 'archived',
      });
      ws.sync();
      return { productId: product.id, productCode: product.productCode, status: 'archived' };
    },
  };

  const productUnarchive: ToolDefinition<{ productCode: string }> = {
    id: 'wms.product.unarchive',
    label: '启用商品',
    description: '恢复一个已停用的商品（wms.product.archive 的逆操作）：重新出现在商品列表，SKU 可以继续挂规格。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        productCode: { type: 'string', description: '要恢复的商品编码' },
      },
      required: ['productCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const product = ws.products.byCode(params.productCode);
      if (!product) throw new ProductNotFoundError(params.productCode);
      if (product.status === 'active') {
        return { productId: product.id, productCode: product.productCode, status: 'active' }; // 已启用：幂等零事件
      }
      ctx.appendEvent(WMS_EVENT_TYPES.productUpdated, {
        productId: product.id,
        productCode: product.productCode,
        status: 'active',
      });
      ws.sync();
      return { productId: product.id, productCode: product.productCode, status: 'active' };
    },
  };

  const productList: ToolDefinition<{ q?: string; includeArchived?: boolean }> = {
    id: 'wms.product.list',
    label: '查询商品',
    description:
      '列出商品（多规格 SPU 档案）。可选 q 按编码或名称包含匹配；includeArchived = true 含已停用（缺省只列启用中的）。纯读操作——幂等，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '按编码或名称包含匹配（可选）' },
        includeArchived: { type: 'boolean', description: '含已停用（可选，缺省 false）' },
      },
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return { products: ws.products.listMatching({ q: params.q, includeArchived: params.includeArchived }) };
    },
  };

  return [def(productCreate), def(productUpdate), def(productArchive), def(productUnarchive), def(productList)];
}

/**
 * specDims 改动不得甩开已挂 SKU 的组合（wms.product.update 守卫）：
 *  - 已挂 SKU 的每个维度键必须仍在、取值必须仍在清单内；
 *  - 无维度 ↔ 有维度不能翻转（已有挂靠时）——翻转会让现挂组合失去意义。
 */
function assertDimsKeepAttachments(
  product: { productCode: string; specDims: readonly ProductSpecDim[] },
  next: readonly ProductSpecDim[],
  attached: readonly { skuCode: string; variantAttrs: Record<string, string> | null }[],
): void {
  const hadDims = product.specDims.length > 0;
  const hasDims = next.length > 0;
  if (hadDims !== hasDims && attached.length > 0) {
    throw new SpecDimInUseError(
      product.productCode,
      hasDims
        ? `商品当前没有维度，但已挂着 ${attached.length} 个 SKU——先整理挂靠（wms.sku.update 换挂），再声明维度`
        : `商品已挂 ${attached.length} 个带规格的 SKU，不能改成无维度`,
    );
  }
  const nextDim = (name: string) => next.find((d) => d.name === name);
  for (const sku of attached) {
    const attrs = sku.variantAttrs ?? {};
    for (const [key, value] of Object.entries(attrs)) {
      const dim = nextDim(key);
      if (!dim) {
        throw new SpecDimInUseError(
          product.productCode,
          `SKU ${sku.skuCode} 用着维度 ${key}，不能删（先 wms.sku.update 改挂/换组合）`,
        );
      }
      if (!dim.values.includes(value)) {
        throw new SpecDimInUseError(
          product.productCode,
          `SKU ${sku.skuCode} 用着 ${key}=${value}，这个取值不能删`,
        );
      }
    }
    // 反向对齐：新定义的每个维度都得有取值，否则已挂组合会变成半截规格
    for (const dim of next) {
      if (!(dim.name in attrs)) {
        throw new SpecDimInUseError(
          product.productCode,
          `SKU ${sku.skuCode} 还没有维度 ${dim.name} 的取值——先 wms.sku.update 补全组合，再加维度`,
        );
      }
    }
  }
  // 组合键唯一不受影响：改定义不改已挂组合，上面已保证每个挂靠组合的
  // 维度名与取值在新定义中依然合法（不多不少）。
}
