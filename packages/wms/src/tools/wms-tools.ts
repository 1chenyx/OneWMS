import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { assertTransition, type OrderDirection, type OrderState } from '../state/order-state-machine.js';
import {
  InsufficientStockError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  SkuAlreadyExistsError,
  SkuNotFoundError,
} from '../errors.js';

/**
 * 领域工具（DESIGN.md §4 宪法：AI 触碰业务数据的唯一通道）。
 *
 * 护栏模式（每个 write 工具三步，缺一不可）：
 *  1. ws.sync()——校验前先追账，投影读到的是最新事实；
 *  2. 业务校验——编码唯一 / SKU 存在 / 状态机合法 / 库存不为负；
 *  3. ctx.appendEvent——事件落账后再 sync()，返回值可携带新状态。
 * 校验失败绝不落事件（命令失败 ≠ 事实，§4.3）。
 *
 * 工具 id 命名空间 `wms.动词.名词`；description 原文注入 function calling，
 * 措辞精确（§6 决策：AI 组装的匹配逻辑就靠它）。
 */

/**
 * 工具定义包装器：handler 参数的逆变位置决定了具体参数类型无法直接赋给
 * ToolDefinition（unknown）——此处集中做一次受控窄化，工具定义处保留精确类型。
 */
function def<P>(tool: ToolDefinition<P>): ToolDefinition {
  return { ...tool, handler: (params: unknown, ctx: ToolContext) => tool.handler(params as P, ctx) };
}

/** 装配工厂：注入「workspaceId → 绑定工作区」的解析器（WmsDomain 装配期提供） */
export function createWmsTools(
  resolveWorkspace: (workspaceId: string) => WmsWorkspace,
): ToolDefinition[] {
  // ── SKU ──────────────────────────────────────────────

  const skuCreate: ToolDefinition<{ skuCode: string; name: string; extData?: Record<string, unknown> }> = {
    id: 'wms.sku.create',
    label: '创建 SKU',
    description: '创建一个新的 SKU（库存商品）。skuCode 是全库唯一的商品编码，name 是商品名称；可选 extData 携带自定义扩展字段（如规格、保质期）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 唯一编码，如 A-1001' },
        name: { type: 'string', description: '商品名称' },
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
      const skuId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.skuCreated, {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        extData: params.extData,
      });
      ws.sync();
      return { skuId, skuCode: params.skuCode, name: params.name };
    },
  };

  const skuUpdate: ToolDefinition<{ skuCode: string; name?: string; extData?: Record<string, unknown> }> = {
    id: 'wms.sku.update',
    label: '更新 SKU',
    description: '更新已有 SKU 的名称或扩展字段。只传需要修改的字段，未传字段保持不变。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: '要更新的 SKU 编码' },
        name: { type: 'string', description: '新的商品名称（可选）' },
        extData: { type: 'object', description: '新的扩展字段（可选，整体替换）' },
      },
      required: ['skuCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: params.name,
        extData: params.extData,
      });
      ws.sync();
      return { skuId: sku.id, skuCode: sku.skuCode };
    },
  };

  // ── 单据 ────────────────────────────────────────────

  const orderCreate: ToolDefinition<{
    direction: OrderDirection;
    lines: { skuCode: string; quantity: number }[];
    orderNo?: string;
    note?: string;
  }> = {
    id: 'wms.order.create',
    label: '创建出入库单',
    description: '创建一张入库单或出库单。direction 取 in（入库）/ out（出库）；lines 是商品明细（SKU 编码 + 数量，数量必须是正整数）。orderNo 不传则自动生成。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向：in=入库，out=出库' },
        lines: {
          type: 'array',
          description: '单据明细行，每行 { skuCode, quantity }',
          items: { type: 'object' },
        },
        orderNo: { type: 'string', description: '单据号（可选，缺省自动生成）' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['direction', 'lines'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();

      // 行级校验（schema 校验器不深入 object 内部，handler 手工补位）
      if (!Array.isArray(params.lines) || params.lines.length === 0) {
        throw new Error('TOOL_REJECTED: lines 不能为空');
      }
      for (const [i, line] of params.lines.entries()) {
        if (typeof line?.skuCode !== 'string' || !line.skuCode) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
        }
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行数量必须是正整数`);
        }
        if (!ws.skus.byCode(line.skuCode)) {
          throw new SkuNotFoundError(line.skuCode);
        }
      }

      const orderNo = params.orderNo ?? generateOrderNo(params.direction);
      if (ws.orders.byNo(orderNo)) {
        throw new OrderAlreadyExistsError(orderNo);
      }

      const orderId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.orderCreated, {
        orderId,
        orderNo,
        direction: params.direction,
        lines: params.lines.map((l) => ({ skuId: ws.skus.byCode(l.skuCode)!.id, quantity: l.quantity })),
        note: params.note,
      });
      ws.sync();
      return { orderId, orderNo, state: 'created' as const };
    },
  };

  const orderTransition: ToolDefinition<{ orderNo: string; to: OrderState }> = {
    id: 'wms.order.transition',
    label: '单据状态转移',
    description: '推进单据状态。入库单：created → received → done；出库单：created → picking → shipped → done；未完成前可 canceled。to 是目标状态。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        to: {
          type: 'string',
          enum: ['created', 'received', 'picking', 'shipped', 'done', 'canceled'],
          description: '目标状态',
        },
      },
      required: ['orderNo', 'to'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const order = ws.orders.byNo(params.orderNo);
      if (!order) throw new OrderNotFoundError(params.orderNo);
      // 状态机校验——非法转移在此被墙拦下（§4.2 规则即护栏）
      assertTransition(order.direction, order.state, params.to);
      ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
        orderId: order.id,
        orderNo: order.orderNo,
        direction: order.direction,
        from: order.state,
        to: params.to,
      });
      ws.sync();
      return { orderNo: order.orderNo, from: order.state, to: params.to };
    },
  };

  // ── 库存 ────────────────────────────────────────────

  const inventoryAdjust: ToolDefinition<{
    skuCode: string;
    delta: number;
    reason?: string;
    orderNo?: string;
  }> = {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description: '对某 SKU 做库存增减：delta 为正数是入库、负数是出库。出库超出当前余量会被拒绝（库存不可为负）。可选关联单据号。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        delta: { type: 'integer', minimum: -1000000000, maximum: 1000000000, description: '数量变化：正数入库，负数出库' },
        reason: { type: 'string', description: '调整原因（可选，如 入库上架 / 盘点 / 报损）' },
        orderNo: { type: 'string', description: '关联单据号（可选）' },
      },
      required: ['skuCode', 'delta'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if (params.delta === 0) {
        throw new Error('TOOL_REJECTED: delta 不能为 0');
      }
      if (params.delta < 0) {
        const available = ws.inventory.quantityOf(sku.id);
        if (available + params.delta < 0) {
          throw new InsufficientStockError(sku.skuCode, params.delta, available);
        }
      }
      let orderId: string | undefined;
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        orderId = order.id;
      }
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        delta: params.delta,
        reason: params.reason ?? (params.delta > 0 ? 'inbound' : 'outbound'),
        orderId,
        orderNo: params.orderNo,
      });
      ws.sync();
      return { skuId: sku.id, skuCode: sku.skuCode, quantity: ws.inventory.quantityOf(sku.id) };
    },
  };

  const inventoryQuery: ToolDefinition<{ skuCode?: string }> = {
    id: 'wms.inventory.query',
    label: '查询库存',
    description: '查询库存余量。给 skuCode 查单个 SKU；不给则列出全部 SKU 的库存清单。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选，缺省查全部）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        return { skuId: sku.id, skuCode: sku.skuCode, quantity: ws.inventory.quantityOf(sku.id) };
      }
      return ws.inventory
        .list()
        .map((r) => {
          const sku = ws.skus.byId(r.skuId);
          return { skuId: r.skuId, skuCode: sku?.skuCode ?? '(已删除)', name: sku?.name ?? '', quantity: r.quantity };
        })
        .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    },
  };

  return [
    def(skuCreate),
    def(skuUpdate),
    def(orderCreate),
    def(orderTransition),
    def(inventoryAdjust),
    def(inventoryQuery),
  ];
}

/** 自动单号：IN-20261030-a1b2c3d4（方向 + 日期 + uuid 片段） */
function generateOrderNo(direction: OrderDirection): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${direction === 'in' ? 'IN' : 'OUT'}-${date}-${randomUUID().slice(0, 8)}`;
}
