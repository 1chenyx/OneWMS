import { evalWhenCondition, type ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderNotFoundError,
  PutawayLineNotFoundError,
  PutawayOnlyInboundError,
  PutawaySourceShortError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';
import { codeOfLocation, resolveBatch, resolveLocation } from '../state/inventory-policy.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
} from '../state/order-state-machine.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 上架工具（M21，module.putaway 贡献的流程步骤）。
 *
 * 设计（零语义破坏）：收货落账行为不变（received 仍按行库位入账）；上架 =
 * received 之后的可选确认 + 归位步骤——无 targets 纯确认（只有状态事件）；
 * 带 targets 的行为行改派目标库位（一对 ± 流水，reason putaway:{orderNo}，
 * 批次/效期保留）。模块停用时 when 过滤使 received→putaway 不可达，
 * 通用 transition 也会被拒——回到老流程。
 */
export function createPutawayTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const orderPutaway: ToolDefinition<{
    orderNo: string;
    targets?: {
      skuCode: string;
      fromLocationCode?: string;
      batchNo?: string;
      toLocationCode: string;
    }[];
  }> = {
    id: 'wms.order.putaway',
    label: '上架确认',
    description:
      '对已收货（received）的入库单做上架确认与归位。不带 targets = 纯确认（单据流转到「已上架」，不动库存）；带 targets = 把指定行从收货库位改派到目标库位（每行生成一对移库流水，批次与效期保留，流水 reason: putaway:单号）。targets 每项：skuCode 必填；fromLocationCode 源库位（可选，缺省 DEFAULT）；batchNo 批次（可选，缺省 DEFAULT）；toLocationCode 目标库位必填。要求单据处于已收货状态且上架模块启用（module.putaway）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '入库单号' },
        targets: {
          type: 'array',
          description: '归位明细（可选；缺省 = 纯确认不动库存）。每行 { skuCode, fromLocationCode?, batchNo?, toLocationCode }',
          items: { type: 'object' },
        },
      },
      required: ['orderNo'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const order = ws.orders.byNo(params.orderNo);
      if (!order) throw new OrderNotFoundError(params.orderNo);
      if (order.direction !== 'in') throw new PutawayOnlyInboundError(params.orderNo);

      // 流程校验（配置即权威）：when 过滤后的活跃转移断言 received→putaway 可达。
      // 模块停用 → 转移不存在 → InvalidTransitionError（老流程语义原样）。
      const snapshot = ws.profile.getSnapshot();
      const workflow = snapshot.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
      if (!workflow) throw new WorkflowNotFoundError(order.direction);
      const activeTransitions = workflow.transitions.filter((t) =>
        evalWhenCondition(t.when, snapshot.modules),
      );
      assertTransition(activeTransitions, order.direction, order.state, 'putaway');

      // 归位明细解析：源桶（SKU+源库位+批次 = 行键前三段）匹配入库单行
      const lines = ws.orders.lines(order.id);
      const moves: {
        line: (typeof lines)[number];
        skuCode: string;
        fromLocationId: string;
        toLocationId: string;
        toLocationCode: string;
        batchNo: string;
        batchExpiryDate: string | undefined;
      }[] = [];
      for (const t of params.targets ?? []) {
        const sku = ws.skus.byCode(t.skuCode);
        if (!sku) throw new SkuNotFoundError(t.skuCode);
        const from = resolveLocation(ws, t.fromLocationCode);
        const batch = resolveBatch(t.batchNo, undefined);
        const to = resolveLocation(ws, t.toLocationCode);
        const line = lines.find(
          (l) => l.skuId === sku.id && l.locationId === from.locationId && l.batchNo === batch.batchNo,
        );
        if (!line) {
          throw new PutawayLineNotFoundError(
            params.orderNo,
            `${t.skuCode}@${from.locationCode}/${batch.batchNo}`,
          );
        }
        // 源桶余量守卫：该行收货入库的桶须还有足量（可能被移库/盘点挪用）
        const available = ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo);
        if (available < line.quantity) {
          throw new PutawaySourceShortError(
            sku.skuCode,
            from.locationCode,
            batch.batchNo,
            line.quantity,
            available,
          );
        }
        if (to.locationId === from.locationId) continue; // 目标 = 源：无流水，纯确认
        moves.push({
          line,
          skuCode: sku.skuCode,
          fromLocationId: from.locationId,
          toLocationId: to.locationId,
          toLocationCode: to.locationCode,
          batchNo: batch.batchNo,
          batchExpiryDate: line.batchExpiryDate ?? ws.inventory.expiryOfBatch(sku.id, batch.batchNo) ?? undefined,
        });
      }

      // 原子落账：状态事实 + 每个归位行一对 ± 流水同生共死（savepoint）
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
          orderId: order.id,
          orderNo: order.orderNo,
          direction: order.direction,
          from: order.state,
          to: 'putaway',
        });
        for (const m of moves) {
          const reason = `putaway:${order.orderNo}`;
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: m.line.skuId,
            skuCode: m.skuCode,
            delta: -m.line.quantity,
            reason,
            locationId: m.fromLocationId,
            locationCode: codeOfLocation(ws, m.fromLocationId),
            batchNo: m.batchNo,
            orderId: order.id,
            orderNo: order.orderNo,
          });
          ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
            skuId: m.line.skuId,
            skuCode: m.skuCode,
            delta: m.line.quantity,
            reason,
            locationId: m.toLocationId,
            locationCode: m.toLocationCode,
            batchNo: m.batchNo,
            batchExpiryDate: m.batchExpiryDate,
            orderId: order.id,
            orderNo: order.orderNo,
          });
        }
      });
      ws.sync();
      return {
        orderNo: order.orderNo,
        from: order.state,
        to: 'putaway',
        movedLines:
          moves.length > 0
            ? moves.map((m) => ({
                skuCode: m.skuCode,
                batchNo: m.batchNo,
                fromLocationCode: codeOfLocation(ws, m.fromLocationId),
                toLocationCode: m.toLocationCode,
                quantity: m.line.quantity,
              }))
            : undefined,
      };
    },
  };

  return [def(orderPutaway)];
}
