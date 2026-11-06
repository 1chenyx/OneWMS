import { randomUUID } from 'node:crypto';
import { evalWhenCondition, type ToolDefinition } from '@one/core';
import { readWmsSettings } from '../config/wms-settings.js';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  PartnerKindMismatchError,
  PartnerNotFoundError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';
import { expandAllocatedLines } from '../state/batch-allocation.js';
import { requiresAvailabilityCheck, stockEffectOf } from '../state/inventory-effect.js';
import { assertOutboundBuckets } from '../state/outbound-guards.js';
import {
  assertExpiryConsistent,
  codeOfLocation,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
  type OrderDirection,
} from '../state/order-state-machine.js';
import { def, type WorkspaceResolver } from './tool-def.js';

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
      '创建一张入库单或出库单。direction 取 in（入库）/ out（出库）；lines 是商品明细（SKU 编码 + 数量 + 可选库位编码 + 可选批次编码，数量必须是正整数）。行上的 locationCode 指定收货上架/发货扣减的库位（缺省为默认库位 DEFAULT）；batchNo 指定批次（缺省为虚拟批次 DEFAULT）：入库行声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），出库行指定批次则只扣该批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。可选 partnerCode 关联往来单位（入库单选供应商，出库单选客户，种类不匹配会被拒绝）。出库单可选 allocation 批次分配策略（strict=严格桶不分配 / fifo=先进先出 / fefo=先到期先出）：fifo/fefo 启用后未指定批次的行按策略在行库位内自动拆分为具体批次行（一行可拆多批次），显式指定批次的行不受影响；不传时用全局缺省策略（core.wms 设置 defaultAllocation，缺省 strict），本参数优先。同单同 SKU 可分不同库位/批次多行，但同 SKU 同库位同批次不可重复。orderNo 不传则自动生成。',
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
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行数量必须是正整数`);
        }
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
            quantity: l.quantity,
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

  const orderTransition: ToolDefinition<{ orderNo: string; to: string }> = {
    id: 'wms.order.transition',
    label: '单据状态转移',
    description:
      '推进单据状态，并自动联动库存（按行的库位 + 批次维度）：入库单进入 received 时按明细自动增加对应库位/批次库存（行声明了效期则随流水登记）；出库单进入 picking 时按行桶预检余量（不足拒绝），进入 shipped 时按行桶自动扣减库存（余量不足拒绝——注意是行指定的库位和批次的余量，不是 SKU 总量；行未指定批次则只扣 DEFAULT 批次）。合法转移由当前流程配置决定（默认：入库 created → received → done；出库 created → picking → shipped → done；未完成前可 canceled；流程配置可含更多状态）。to 是目标状态。若全局设置开启过期批次出库拦截（core.wms 的 settings.blockExpiredOutbound），出库行批次已过期（效期早于今日；今天到期视为临期可出）会被拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        // 不设 enum：状态词汇由流程配置定义（模块可贡献新状态），合法性由 handler 按配置裁决
        to: { type: 'string', description: '目标状态（合法值由当前流程配置决定）' },
      },
      required: ['orderNo', 'to'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const order = ws.orders.byNo(params.orderNo);
      if (!order) throw new OrderNotFoundError(params.orderNo);
      // 流程校验（M8 行为闭环）——转移表来自 Profile workflows（配置即权威）：
      // AI 慢通道改流程、模块 contributes 叠加转移，下一次流转立即生效。
      // 流程定义缺失 → 明确报错，不静默回退硬编码表（否则「删流程」的配置静默失效）。
      // when 条件运行时求值（M21）：条件不满足的转移视为不存在（如 module.putaway
      // 停用时 received→putaway 不可达）——与 evalWhenCondition（core）同一语义。
      const snapshot = ws.profile.getSnapshot();
      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
      if (!workflow) throw new WorkflowNotFoundError(order.direction);
      const activeTransitions = workflow.transitions.filter((t) =>
        evalWhenCondition(t.when, snapshot.modules),
      );
      assertTransition(activeTransitions, order.direction, order.state, params.to);

      // 库存联动（M9 起，M11 升级为行库位+批次维度）：出库进入 picking 预检、进入
      // shipped 硬守卫——逐行按 (SKU, 行库位, 行批次) 验余量（行键唯一，orderCreate
      // 已挡重复行）；拒绝发生在落账前（命令失败 ≠ 事实，零事件）。入库进入
      // received 前做批次效期一致性权威校验（建单 fail-fast 之后、别的流水可能
      // 已登记了不同效期）。
      const lines = ws.orders.lines(order.id);
      const effect = stockEffectOf(order.direction, params.to);
      if (effect?.kind === 'increase') {
        for (const line of lines) {
          if (line.batchExpiryDate) {
            assertExpiryConsistent(
              ws,
              line.skuId,
              ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
              line.batchNo,
              line.batchExpiryDate,
            );
          }
        }
      }
      if (effect?.kind === 'decrease' || requiresAvailabilityCheck(order.direction, params.to)) {
        // 出库硬守卫（M21 提取为 state/outbound-guards.ts，与拣货关单共用）：
        // 过期拦截（M13）/ 逐桶余量（M11）/ SKU 冻结聚合（M19）。
        // 只拦单据出库：库存调整/移库不经本守卫（盘点、报废走自己的通道）。
        assertOutboundBuckets(ws, lines);
      }

      // 原子落账：状态事实 + 每行流水事实同生共死（savepoint 包裹，杜绝半落账）
      const adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[] = [];
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
          orderId: order.id,
          orderNo: order.orderNo,
          direction: order.direction,
          from: order.state,
          to: params.to,
        });
        if (effect) {
          for (const line of lines) {
            const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
            const locationCode = codeOfLocation(ws, line.locationId);
            const delta = effect.kind === 'increase' ? line.quantity : -line.quantity;
            ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
              skuId: line.skuId,
              skuCode,
              delta,
              reason: `order:${params.to}`,
              locationId: line.locationId,
              locationCode,
              batchNo: line.batchNo,
              batchExpiryDate: line.batchExpiryDate ?? undefined,
              orderId: order.id,
              orderNo: order.orderNo,
            });
            adjustedLines.push({ skuCode, locationCode, batchNo: line.batchNo, delta });
          }
        }
      });
      ws.sync();
      return {
        orderNo: order.orderNo,
        from: order.state,
        to: params.to,
        adjustedLines: adjustedLines.length > 0 ? adjustedLines : undefined,
      };
    },
  };

  return [def(orderCreate), def(orderTransition)];
}

/** 自动单号：IN-20261030-a1b2c3d4（方向 + 日期 + uuid 片段） */
function generateOrderNo(direction: OrderDirection): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${direction === 'in' ? 'IN' : 'OUT'}-${date}-${randomUUID().slice(0, 8)}`;
}
