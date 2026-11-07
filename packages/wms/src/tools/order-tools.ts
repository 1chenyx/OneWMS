import { randomUUID } from 'node:crypto';
import { evalWhenCondition, type ToolContext, type ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { readWmsSettings } from '../config/wms-settings.js';
import { DEFAULT_BATCH_NO, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  PartialNotOnPostError,
  PartnerKindMismatchError,
  PartnerNotFoundError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';
import { expandAllocatedLines } from '../state/batch-allocation.js';
import { resolveTransitionEffect } from '../state/inventory-effect.js';
import { assertOnHand, assertOutboundBuckets } from '../state/outbound-guards.js';
import { resolvePostingMoves, type PostingRequest } from '../state/partial-qty.js';
import {
  assertExpiryConsistent,
  assertNonNegativeQty,
  assertPositiveQty,
  codeOfLocation,
  quantizeQty,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
  type OrderDirection,
} from '../state/order-state-machine.js';
import { withOrderLines } from '../queries/order-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

export interface OrderTransitionResult {
  orderNo: string;
  from: string;
  to: string;
  adjustedLines?: { skuCode: string; locationCode: string; batchNo: string; delta: number }[];
}

/**
 * 单据转移的命令实现（工具与冲突接受共用）。
 * 校验失败抛错、零事件。调用方可以包在更大的 runAtomic 里。
 */
export function applyOrderTransition(
  ws: WmsWorkspace,
  ctx: ToolContext,
  params: {
    orderNo: string;
    to: string;
    lines?: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[];
  },
): OrderTransitionResult {
  ws.sync();
  const order = ws.orders.byNo(params.orderNo);
  if (!order) throw new OrderNotFoundError(params.orderNo);
  const snapshot = ws.profile.getSnapshot();
  const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
  if (!workflow) throw new WorkflowNotFoundError(order.direction);
  const activeTransitions = workflow.transitions.filter((t) =>
    evalWhenCondition(t.when, snapshot.modules),
  );
  assertTransition(activeTransitions, order.direction, order.state, params.to);
  const edge = activeTransitions.find((t) => t.from === order.state && t.to === params.to);
  const settings = readWmsSettings(ws);
  const resolved = resolveTransitionEffect(order.direction, params.to, edge?.effect, settings);
  const requests = resolvePartialRequests(ws, params.lines);
  if (!resolved.post && requests.length > 0) throw new PartialNotOnPostError();

  const lines = ws.orders.lines(order.id);
  const posted = resolved.post
    ? resolvePostingMoves({
        post: resolved.post,
        moduleEnabled: snapshot.modules['module.partial']?.enabled === true,
        lines,
        requests,
      })
    : [];
  const moving = posted.filter((line) => line.move > 0);
  if (resolved.post === 'increase') {
    for (const line of lines) {
      const hit = moving.find(
        (m) => m.skuId === line.skuId && m.locationId === line.locationId && m.batchNo === line.batchNo,
      );
      if (!hit || !line.batchExpiryDate) continue;
      assertExpiryConsistent(
        ws,
        line.skuId,
        ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
        line.batchNo,
        line.batchExpiryDate,
      );
    }
  }
  if (resolved.checkAvailability) {
    const guardLines = resolved.post
      ? moving.map((line) => ({
          skuId: line.skuId,
          locationId: line.locationId,
          batchNo: line.batchNo,
          quantity: line.move,
        }))
      : lines;
    // 出库履约（预检或扣减）走完整守卫；入库冲销只验余量和冻结。只预检时按订单数量。
    if (guardLines.length > 0) {
      if (order.direction === 'out') assertOutboundBuckets(ws, guardLines);
      else assertOnHand(ws, guardLines, { expiry: false, hold: true });
    }
  }

  const fulfillments = posted
    .filter((line) => line.nextPosted !== undefined)
    .map((line) => ({
      skuId: line.skuId,
      locationId: line.locationId,
      batchNo: line.batchNo,
      quantity: line.nextPosted!,
    }));
  const adjustedLines: OrderTransitionResult['adjustedLines'] = [];
  ws.runAtomic(() => {
    ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
      orderId: order.id,
      orderNo: order.orderNo,
      direction: order.direction,
      from: order.state,
      to: params.to,
      ...(fulfillments.length > 0 ? { fulfillments } : {}),
    });
    if (resolved.post) {
      for (const line of moving) {
        const src = lines.find(
          (row) => row.skuId === line.skuId && row.locationId === line.locationId && row.batchNo === line.batchNo,
        );
        const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
        const locationCode = codeOfLocation(ws, line.locationId);
        const delta = resolved.post === 'increase' ? line.move : -line.move;
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: line.skuId,
          skuCode,
          delta,
          reason: `order:${params.to}`,
          locationId: line.locationId,
          locationCode,
          batchNo: line.batchNo,
          batchExpiryDate: src?.batchExpiryDate ?? undefined,
          orderId: order.id,
          orderNo: order.orderNo,
        });
        adjustedLines!.push({ skuCode, locationCode, batchNo: line.batchNo, delta });
      }
    }
  });
  ws.sync();
  return {
    orderNo: order.orderNo,
    from: order.state,
    to: params.to,
    adjustedLines: adjustedLines!.length > 0 ? adjustedLines : undefined,
  };
}

/** 把调用方的实收/实发解析成行键。空数组视为没传。 */
function resolvePartialRequests(
  ws: WmsWorkspace,
  raw: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[] | undefined,
): PostingRequest[] {
  if (!raw?.length) return [];
  return raw.map((line, i) => {
    if (typeof line?.skuCode !== 'string' || !line.skuCode) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 条实收/实发缺少 skuCode`);
    }
    const quantity = assertNonNegativeQty(line.quantity, `第 ${i + 1} 条实收/实发数量`);
    const sku = ws.skus.byCode(line.skuCode);
    if (!sku) throw new SkuNotFoundError(line.skuCode);
    const location = resolveLocation(ws, line.locationCode);
    const batchNo = !line.batchNo || line.batchNo === DEFAULT_BATCH_NO ? DEFAULT_BATCH_NO : line.batchNo;
    return { skuId: sku.id, locationId: location.locationId, batchNo, quantity };
  });
}

export function createOrderTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const orderCreate: ToolDefinition<{
    direction: OrderDirection;
    lines: {
      skuCode: string;
      quantity: number;
      locationCode?: string;
      batchNo?: string;
      batchExpiryDate?: string;
    }[];
    orderNo?: string;
    note?: string;
    /** 往来单位编码（M21，可选）：入库单=供应商 / 出库单=客户 */
    partnerCode?: string;
    /** 批次分配策略（M12 起，M13 扩加 strict，仅出库单）：strict=严格桶不分配，fifo=先进先出，fefo=先到期先出 */
    allocation?: 'strict' | 'fifo' | 'fefo';
  }> = {
    id: 'wms.order.create',
    label: '创建出入库单',
    description:
      '创建一张入库单或出库单。direction 取 in（入库）/ out（出库）；lines 是商品明细（SKU 编码 + 数量 + 可选库位编码 + 可选批次编码，数量必须是正数，支持 3 位小数——散装/称重场景，如 0.5 表示半斤）。行上的 locationCode 指定收货上架/发货扣减的库位（缺省为默认库位 DEFAULT）；batchNo 指定批次（缺省为虚拟批次 DEFAULT）：入库行声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），出库行指定批次则只扣该批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。可选 partnerCode 关联往来单位（入库单选供应商，出库单选客户，种类不匹配会被拒绝）。出库单可选 allocation 批次分配策略（strict=严格桶不分配 / fifo=先进先出 / fefo=先到期先出）：fifo/fefo 启用后未指定批次的行按策略在行库位内自动拆分为具体批次行（一行可拆多批次），显式指定批次的行不受影响；不传时用全局缺省策略（core.wms 设置 defaultAllocation，缺省 strict），本参数优先。同单同 SKU 可分不同库位/批次多行，但同 SKU 同库位同批次不可重复。orderNo 不传则自动生成。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向：in=入库，out=出库' },
        lines: {
          type: 'array',
          description: '单据明细行，每行 { skuCode, quantity, locationCode?, batchNo?, batchExpiryDate? }',
          items: { type: 'object' },
        },
        orderNo: { type: 'string', description: '单据号（可选，缺省自动生成）' },
        note: { type: 'string', description: '备注（可选）' },
        partnerCode: {
          type: 'string',
          description:
            '往来单位编码（可选，M21）：入库单关联供应商、出库单关联客户；种类不匹配会被拒绝',
        },
        allocation: {
          type: 'string',
          enum: ['strict', 'fifo', 'fefo'],
          description: '批次分配策略（可选，仅出库单）：strict=严格桶（不分配，未指定批次只扣 DEFAULT），fifo=先进先出（按批次首笔入库时间），fefo=先到期先出（按效期，无期批次最后）；未传时用全局设置 settings.defaultAllocation（缺省 strict），本参数优先',
        },
      },
      required: ['direction', 'lines'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();

      // 批次分配（M12 起，M13 优先级扩展）：单参数 allocation > 全局设置
      // settings.defaultAllocation > 代码缺省 strict（readWmsSettings 兜底后恒有值）。
      // 显式传参 + 入库单 → 拒（批次是声明不是分配）；全局策略对入库单无感
      // （不分配、不报错）。strict = 不分配（M11 严格桶：未指定批次只扣 DEFAULT）。
      if (params.allocation && params.direction !== 'out') {
        throw new Error('TOOL_REJECTED: allocation 只适用于出库单（入库行的批次是声明，不是分配）');
      }
      const settings = readWmsSettings(ws);
      const effective =
        params.allocation ?? (params.direction === 'out' ? settings.defaultAllocation : 'strict');
      const resolvedLines =
        effective !== 'strict'
          ? expandAllocatedLines(ws, params.lines, effective, settings.blockExpiredOutbound)
          : params.lines;

      // 行级校验（schema 校验器不深入 object 内部，handler 手工补位）
      if (!Array.isArray(resolvedLines) || resolvedLines.length === 0) {
        throw new Error('TOOL_REJECTED: lines 不能为空');
      }
      const seenKeys = new Set<string>(); // 重复键 = SKU + 库位 + 批次（M11：行唯一约束四段）
      for (const [i, line] of resolvedLines.entries()) {
        if (typeof line?.skuCode !== 'string' || !line.skuCode) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
        }
        assertPositiveQty(line.quantity, `第 ${i + 1} 行数量`);
        const sku = ws.skus.byCode(line.skuCode);
        if (!sku) {
          throw new SkuNotFoundError(line.skuCode);
        }
        const loc = resolveLocation(ws, line.locationCode); // 库位存在性（缺省 DEFAULT）
        // 批次解析（M11）：DEFAULT 虚拟批次不携带效期；出库行不支持效期声明
        if (params.direction === 'out' && line.batchExpiryDate) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行出库行不支持批次效期（效期随入库声明）`);
        }
        const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
        // 新批次效期一致性 fail-fast（权威守卫在收货落流水时——建单到收货间可能有别的流水）
        if (batch.batchExpiryDate) {
          assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
        }
        // 行唯一约束（wms_order_line 的 order+sku+location+batch 唯一，行 id 四段派生）：
        // 命令侧必须先挡，否则事件落账后投影 INSERT 炸裂、工作区永久卡死
        const key = `${line.skuCode}@${loc.locationId}@${batch.batchNo}`;
        if (seenKeys.has(key)) {
          throw new Error(
            `TOOL_REJECTED: 第 ${i + 1} 行 SKU ${line.skuCode} 在库位 ${loc.locationCode} 批次 ${batch.batchNo} 与前行重复——同单同 SKU 同库位同批次请合并数量`,
          );
        }
        seenKeys.add(key);
      }

      const orderNo = params.orderNo ?? generateOrderNo(params.direction);
      if (ws.orders.byNo(orderNo)) {
        throw new OrderAlreadyExistsError(orderNo);
      }

      // 往来单位解析（M21）：存在 + 方向匹配（in↔supplier / out↔customer）。
      // 只落 partnerId（业务 id）；编码/名称展示由查询层联查（事件禁冗余快照）。
      let partnerId: string | undefined;
      if (params.partnerCode !== undefined) {
        const partner = ws.partners.byCode(params.partnerCode);
        if (!partner) throw new PartnerNotFoundError(params.partnerCode);
        const expectedKind = params.direction === 'in' ? 'supplier' : 'customer';
        if (partner.kind !== expectedKind) {
          throw new PartnerKindMismatchError(partner.partnerCode, partner.kind, params.direction);
        }
        partnerId = partner.id;
      }

      const orderId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.orderCreated, {
        orderId,
        orderNo,
        direction: params.direction,
        partnerId,
        // M12：分配后行集（未启用分配时即原始行集）——事件形态与 M11 逐字节同构
        lines: resolvedLines.map((l) => {
          const batch = resolveBatch(l.batchNo, l.batchExpiryDate);
          return {
            skuId: ws.skus.byCode(l.skuCode)!.id,
            quantity: quantizeQty(l.quantity),
            locationId: resolveLocation(ws, l.locationCode).locationId,
            batchNo: batch.batchNo,
            batchExpiryDate: batch.batchExpiryDate,
          };
        }),
        note: params.note,
      });
      ws.sync();
      return { orderId, orderNo, state: 'created' as const };
    },
  };

  const orderTransition: ToolDefinition<{
    orderNo: string;
    to: string;
    lines?: { skuCode: string; locationCode?: string; batchNo?: string; quantity: number }[];
  }> = {
    id: 'wms.order.transition',
    label: '单据状态转移',
    description:
      '推进单据状态，并按该转移的库存效应联动库存（按行的库位 + 批次）。未在转移上声明 effect 时：入库进入 received（可用 settings.inboundIncreaseState 改名）按行增加库存；出库进入 picking（outboundCheckState）只预检余量；出库进入 shipped（outboundDecreaseState）按行扣减。转移上的 effect（increase/decrease/check/none）优先于这三键。module.reversal 启用时，已收货可取消并扣回，已发货可取消并加回；停用后这两条转移不可用。module.partial 启用时，会改库存的转移可以带 lines 声明实收/实发（不大于该行订单数量，0 表示这行没到/没发）；不带 lines 按订单数量整单入账。停用 module.partial 后不能改少。已经入账的行，冲销按已入账数量，不能再改。合法目标由当前流程决定。过期批次拦截只作用于出库履约，不拦截入库冲销。拣货关单不走本工具的短发。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        // 不设 enum：状态词汇由流程配置定义（模块可贡献新状态），合法性由 handler 按配置裁决
        to: { type: 'string', description: '目标状态（合法值由当前流程配置决定）' },
        lines: {
          type: 'array',
          description:
            '实收/实发（可选，module.partial）。每项 { skuCode, quantity, locationCode?, batchNo? }。缺省行按订单数量。',
          items: { type: 'object' },
        },
      },
      required: ['orderNo', 'to'],
    },
    handler: (params, ctx) => applyOrderTransition(resolveWorkspace(ctx.workspaceId), ctx, params),
  };

  const orderQuery: ToolDefinition<{
    orderNo?: string;
    direction?: OrderDirection;
    state?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }> = {
    id: 'wms.order.query',
    label: '查询单据',
    description:
      '查询单据清单或单据详情。给 orderNo 返回该单详情（含明细行 lines：SKU 编码/数量/库位/批次，及往来单位），单据不存在会报错。' +
      '不给 orderNo 返回分页清单：direction（in=入库 / out=出库）、state（状态，如 created/received/completed——状态词汇由流程配置定义）、' +
      'from/to（创建时间 ISO 闭区间）均可选过滤。最新在前；limit 默认 20（上限 200）、offset 翻页；' +
      '返回 { total, limit, offset, hasMore, rows }，行含 orderNo / direction / state / partnerCode / lineCount / totalQuantity / createdAt。' +
      '查「最近的出入库单」「某状态的单据」「某单据的明细」用本工具；纯读操作。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号（给定时返回该单详情含明细行）' },
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向过滤（可选）' },
        state: { type: 'string', description: '状态过滤（可选，如 created / received / completed）' },
        from: { type: 'string', description: '创建起始时间（ISO，含）' },
        to: { type: 'string', description: '创建结束时间（ISO，含）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页行数（缺省 20）' },
        offset: { type: 'integer', minimum: 0, description: '跳过行数（缺省 0，翻页用）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();

      // 单号模式：单据详情含明细行（单号详情天然有限，不分页）
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        return withOrderLines(ws, order);
      }

      // 列表模式：分页壳 + 行统计（lines 逐单汇总）
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      const { rows, total } = ws.orders.listPage({
        direction: params.direction,
        state: params.state,
        from: params.from,
        to: params.to,
        limit,
        offset,
      });
      return {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
        rows: rows.map((order) => {
          const lines = ws.orders.lines(order.id);
          const partner = order.partnerId ? ws.partners.byId(order.partnerId) : undefined;
          return {
            orderNo: order.orderNo,
            direction: order.direction,
            state: order.state,
            partnerCode: partner?.partnerCode ?? null,
            partnerName: partner?.name ?? null,
            lineCount: lines.length,
            totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          };
        }),
      };
    },
  };

  return [def(orderCreate), def(orderTransition), def(orderQuery)];
}

/** 自动单号：IN-20261030-a1b2c3d4（方向 + 日期 + uuid 片段） */
function generateOrderNo(direction: OrderDirection): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${direction === 'in' ? 'IN' : 'OUT'}-${date}-${randomUUID().slice(0, 8)}`;
}
