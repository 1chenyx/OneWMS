import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  OrderAlreadyExistsError,
  PartnerKindMismatchError,
  PartnerNotFoundError,
  ReplenishDisabledError,
  ReplenishEmptyError,
  ReplenishNotShortError,
  SerialRequiredError,
  SkuNotFoundError,
} from '../errors.js';
import {
  listReplenishmentSuggestions,
  type ReplenishmentSuggestion,
} from '../queries/replenish-queries.js';
import { serialEnabled } from '../state/serial-policy.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 补货开单（module.replenish）。
 *
 * 不调用 wms.order.create：工具处理器里再进工具总线没有先例，也容易和锁缠在一起。
 * 自己追加 orderCreated。单据是普通入库（created），收货仍走原有的加库存转移。
 * 标记只写在这条事件上，wms.order.create 不能带出补货标记。
 */
export function createReplenishTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const replenishCreate: ToolDefinition<{
    skuCodes?: string[];
    partnerCode?: string;
    note?: string;
    orderNo?: string;
  }> = {
    id: 'wms.replenish.create',
    label: '生成补货单',
    description:
      '按安全库存缺口生成一张入库单。缺口 = 安全库存 − 可用量（余量 − 冻结 − 拣货占用）− 尚未收货的入库数量（状态为已创建或已预报）。可用量已经低于安全库存、但在途入库已经盖住缺口的商品不会再开。skuCodes 可选，只补这些编码；不传则一张单盖住全部缺口。重复编码会合并。没有缺口、传入空数组、或传入的编码没有缺口时拒绝且不产生事件。未知编码拒绝。可选 partnerCode（供应商）、note（缺省「补货」）、orderNo。开出的是普通入库单（状态已创建，行落在默认库位和默认批次），收货时才加库存。停用 module.replenish 后本工具拒绝；低库存预警仍可用；已经开出的入库单仍可收货。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCodes: {
          type: 'array',
          description: '只补这些 SKU 编码（可选）。不传 = 全部有缺口的商品。空数组拒绝。',
          items: { type: 'string' },
        },
        partnerCode: { type: 'string', description: '供应商编码（可选）。入库单只能关联供应商。' },
        note: { type: 'string', description: '备注（可选，缺省「补货」）' },
        orderNo: { type: 'string', description: '单据号（可选，缺省自动生成）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (ws.profile.getSnapshot().modules['module.replenish']?.enabled !== true) {
        throw new ReplenishDisabledError();
      }

      const skuCodes = parseSkuCodes(params.skuCodes);
      if (skuCodes && skuCodes.length === 0) throw new ReplenishEmptyError();
      if (skuCodes) {
        for (const code of skuCodes) {
          if (!ws.skus.byCode(code)) throw new SkuNotFoundError(code);
        }
      }

      if (serialEnabled(ws) && skuCodes) {
        for (const code of skuCodes) {
          if (ws.skus.byCode(code)?.serialTracked) throw new SerialRequiredError(code);
        }
      }

      const suggestions = listReplenishmentSuggestions(ws);
      const byCode = new Map(suggestions.map((row) => [row.skuCode, row]));
      let chosen: ReplenishmentSuggestion[];
      if (skuCodes) {
        chosen = [];
        for (const code of skuCodes) {
          const row = byCode.get(code);
          if (!row) throw new ReplenishNotShortError(code);
          chosen.push(row);
        }
        chosen.sort((a, b) => b.suggestedQty - a.suggestedQty || a.skuCode.localeCompare(b.skuCode));
      } else {
        chosen = suggestions;
      }
      if (serialEnabled(ws)) {
        chosen = chosen.filter((row) => !ws.skus.byCode(row.skuCode)?.serialTracked);
      }
      if (chosen.length === 0) throw new ReplenishEmptyError();

      let partnerId: string | undefined;
      const partnerCode = typeof params.partnerCode === 'string' ? params.partnerCode.trim() : '';
      if (partnerCode) {
        const partner = ws.partners.byCode(partnerCode);
        if (!partner) throw new PartnerNotFoundError(partnerCode);
        if (partner.kind !== 'supplier') {
          throw new PartnerKindMismatchError(partner.partnerCode, partner.kind, 'in');
        }
        partnerId = partner.id;
      }

      const requestedNo = typeof params.orderNo === 'string' ? params.orderNo.trim() : '';
      const orderNo = requestedNo || generateOrderNo();
      if (ws.orders.byNo(orderNo)) throw new OrderAlreadyExistsError(orderNo);

      const note = typeof params.note === 'string' && params.note.trim() ? params.note.trim() : '补货';
      const orderId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.orderCreated, {
        orderId,
        orderNo,
        direction: 'in',
        partnerId,
        replenishment: true,
        lines: chosen.map((row) => ({
          skuId: ws.skus.byCode(row.skuCode)!.id,
          quantity: row.suggestedQty,
        })),
        note,
      });
      ws.sync();
      return {
        orderId,
        orderNo,
        state: 'created' as const,
        lines: chosen.map((row) => ({ skuCode: row.skuCode, quantity: row.suggestedQty })),
      };
    },
  };

  return [def(replenishCreate)];
}

/** 缺省或非数组留给调用方；空串去掉；重复编码只留第一次。 */
function parseSkuCodes(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('TOOL_REJECTED: skuCodes 必须是数组');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('TOOL_REJECTED: skuCodes 每项必须是字符串');
    const code = item.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** 与入库单自动单号同一形态：IN-日期-uuid 片段 */
function generateOrderNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `IN-${date}-${randomUUID().slice(0, 8)}`;
}
