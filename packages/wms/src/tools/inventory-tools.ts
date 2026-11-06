import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { DEFAULT_LOCATION_ID, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  HoldExceedsStockError,
  HoldNotFoundError,
  InsufficientStockError,
  OrderNotFoundError,
  SkuNotFoundError,
} from '../errors.js';
import {
  assertExpiryConsistent,
  bucketLabel,
  codeOfLocation,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { def, type WorkspaceResolver } from './tool-def.js';

export function createInventoryTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const inventoryAdjust: ToolDefinition<{
    skuCode: string;
    delta: number;
    reason?: string;
    orderNo?: string;
    locationCode?: string;
    batchNo?: string;
    batchExpiryDate?: string;
  }> = {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description:
      '对某 SKU 做库存增减：delta 为正数是入库、负数是出库。可选 locationCode 指定库位（缺省为默认库位 DEFAULT）；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——正数入库声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），负数出库只扣指定批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。出库超出该库位该批次当前余量会被拒绝（库存不可为负）。可选关联单据号。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        delta: { type: 'integer', minimum: -1000000000, maximum: 1000000000, description: '数量变化：正数入库，负数出库' },
        reason: { type: 'string', description: '调整原因（可选，如 入库上架 / 盘点 / 报损）' },
        orderNo: { type: 'string', description: '关联单据号（可选）' },
        locationCode: { type: 'string', description: '库位编码（可选，缺省为默认库位 DEFAULT）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT；批次随首条入库流水诞生）' },
        batchExpiryDate: { type: 'string', description: '批次效期 YYYY-MM-DD（可选，仅入库；同批次后继必须一致）' },
      },
      required: ['skuCode', 'delta'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const loc = resolveLocation(ws, params.locationCode);
      if (params.delta === 0) {
        throw new Error('TOOL_REJECTED: delta 不能为 0');
      }
      if (params.delta < 0 && params.batchExpiryDate) {
        throw new Error('TOOL_REJECTED: 出库（负 delta）不支持批次效期——效期随入库声明');
      }
      const batch = resolveBatch(params.batchNo, params.batchExpiryDate);
      // 批次效期一致性（M11）：新批次登记 / 老批次比对（建批 fail-fast）
      assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
      if (params.delta < 0) {
        const available = ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo);
        if (available + params.delta < 0) {
          throw new InsufficientStockError(
            bucketLabel(sku.skuCode, loc.locationCode, batch.batchNo),
            params.delta,
            available,
          );
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
        locationId: loc.locationId,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        batchExpiryDate: batch.batchExpiryDate,
        orderId,
        orderNo: params.orderNo,
      });
      ws.sync();
      return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        quantity: ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo),
      };
    },
  };

  const inventoryMove: ToolDefinition<{
    skuCode: string;
    fromLocationCode?: string;
    toLocationCode?: string;
    quantity: number;
    batchNo?: string;
  }> = {
    id: 'wms.inventory.move',
    label: '移库',
    description:
      '把某 SKU 的库存从一个库位移到另一个库位（同批次数量转移，总量不变）。fromLocationCode / toLocationCode 缺省均为默认库位 DEFAULT；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——移的是该批次的货，源与目标不能相同；源库位该批次余量不足会拒绝。移库产生一对 transfer 流水（-源 / +目标），可审计。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        fromLocationCode: { type: 'string', description: '源库位编码（可选，缺省 DEFAULT）' },
        toLocationCode: { type: 'string', description: '目标库位编码（可选，缺省 DEFAULT）' },
        quantity: { type: 'integer', minimum: 1, maximum: 1000000000, description: '移库数量（正整数）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT）' },
      },
      required: ['skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
        throw new Error('TOOL_REJECTED: quantity 必须是正整数');
      }
      const from = resolveLocation(ws, params.fromLocationCode);
      const to = resolveLocation(ws, params.toLocationCode);
      const batch = resolveBatch(params.batchNo, undefined); // 移库不带效期（批次属性已在入库登记）
      if (from.locationId === to.locationId) {
        throw new Error('TOOL_REJECTED: 源库位与目标库位相同');
      }
      const available = ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo);
      if (available < params.quantity) {
        throw new InsufficientStockError(
          bucketLabel(sku.skuCode, from.locationCode, batch.batchNo),
          params.quantity,
          available,
        );
      }
      // 原子落账（M9 runAtomic）：-源 / +目标 两条流水同生共死，杜绝「出旧库位
      // 了没进新库位」的半落账。零新事件类型——移库就是一对普通流水事实。
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: -params.quantity,
          reason: 'transfer',
          locationId: from.locationId,
          locationCode: from.locationCode,
          batchNo: batch.batchNo,
        });
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: params.quantity,
          reason: 'transfer',
          locationId: to.locationId,
          locationCode: to.locationCode,
          batchNo: batch.batchNo,
        });
      });
      ws.sync();
      return {
        skuCode: sku.skuCode,
        from: from.locationCode,
        to: to.locationCode,
        batchNo: batch.batchNo,
        quantity: params.quantity,
        fromBalance: ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo),
        toBalance: ws.inventory.quantityOf(sku.id, to.locationId, batch.batchNo),
      };
    },
  };

  const inventoryHold: ToolDefinition<{ skuCode: string; quantity: number; reason?: string }> = {
    id: 'wms.inventory.hold',
    label: '冻结库存',
    description:
      '冻结某 SKU 的一部分数量（如 质检隔离 / 客订预留 / 促销占位）。冻结不改物理库存、不产生流水——只是把数量标记为不可出库：单据出库（拣货/发货）会校验可用量 = 全库位合计余量 − 冻结合计，不足即拒。同 SKU 可多笔冻结；已冻结合计 + 本次不能超过账面余量。释放用 wms.inventory.release（按 holdId）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        quantity: { type: 'integer', minimum: 1, maximum: 1000000000, description: '冻结数量（正整数）' },
        reason: { type: 'string', description: '冻结原因（如 质检隔离 / 客订预留）' },
      },
      required: ['skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
        throw new Error('TOOL_REJECTED: quantity 必须是正整数');
      }
      const total = ws.inventory.totalOf(sku.id);
      const held = ws.inventory.heldOf(sku.id);
      if (held + params.quantity > total) {
        throw new HoldExceedsStockError(sku.skuCode, params.quantity, total, held);
      }
      const holdId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryHeld, {
        holdId,
        skuId: sku.id,
        skuCode: sku.skuCode,
        quantity: params.quantity,
        reason: params.reason ?? 'hold',
      });
      ws.sync();
      return {
        holdId,
        skuCode: sku.skuCode,
        quantity: params.quantity,
        total,
        held: held + params.quantity,
        available: total - held - params.quantity,
      };
    },
  };

  const inventoryRelease: ToolDefinition<{ holdId: string; reason?: string }> = {
    id: 'wms.inventory.release',
    label: '释放冻结',
    description:
      '释放一笔冻结（整笔解除，按 holdId 定位——先经 wms.inventory.holds 查活动冻结拿 holdId）。释放后该数量回到可用量，可正常出库。已释放的冻结再释放会报「冻结单不存在或已释放」。可选 reason 记录释放原因（如 质检合格放行）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        holdId: { type: 'string', description: '冻结单 id（wms.inventory.holds 返回的 holdId）' },
        reason: { type: 'string', description: '释放原因（可选，如 质检合格放行）' },
      },
      required: ['holdId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const hold = ws.inventory.listHolds().find((h) => h.id === params.holdId);
      if (!hold) throw new HoldNotFoundError(params.holdId);
      const sku = ws.skus.byId(hold.skuId);
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryReleased, {
        holdId: hold.id,
        skuId: hold.skuId,
        skuCode: sku?.skuCode ?? hold.skuId,
        reason: params.reason,
      });
      ws.sync();
      const total = ws.inventory.totalOf(hold.skuId);
      const held = ws.inventory.heldOf(hold.skuId);
      return {
        holdId: hold.id,
        skuCode: sku?.skuCode ?? hold.skuId,
        quantity: hold.quantity,
        total,
        held,
        available: total - held,
      };
    },
  };

  const inventoryQuery: ToolDefinition<{ skuCode?: string; locationCode?: string }> = {
    id: 'wms.inventory.query',
    label: '查询库存',
    description:
      '查询库存余量（按 SKU 汇总，可下钻库位与批次明细；分组形态含 held 冻结合计与 available 可用量 = 总量 − 冻结）。给 skuCode 查单个 SKU（返回 total 总量与 byLocation 分库位明细，库位内再列 batches 批次明细）；都不给列出全部 SKU 的分组清单；给 locationCode 查该库位内有哪些货（平铺行，含批次号与效期）。库位 DEFAULT 是默认库位、批次 DEFAULT 是虚拟批次（未指定维度的库存归宿）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选，缺省查全部）' },
        locationCode: { type: 'string', description: '库位编码（可选，给定时返回该库位的平铺清单）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const loc = resolveLocation(ws, params.locationCode); // 库位存在性校验（含 DEFAULT 直通）
      const nameOf = (locationId: string): string =>
        locationId === DEFAULT_LOCATION_ID
          ? '默认库位'
          : (ws.locations.byId(locationId)?.name ?? '(未知库位)');

      // 形态一：按库位平铺——「这个库位里有什么」（行含批次与效期）
      if (params.locationCode) {
        let rows = ws.inventory.list().filter((r) => r.locationId === loc.locationId);
        if (params.skuCode) {
          const sku = ws.skus.byCode(params.skuCode);
          if (!sku) throw new SkuNotFoundError(params.skuCode);
          rows = rows.filter((r) => r.skuId === sku.id);
        }
        return rows.map((r) => {
          const sku = ws.skus.byId(r.skuId);
          return {
            skuId: r.skuId,
            skuCode: sku?.skuCode ?? '(已删除)',
            name: sku?.name ?? '',
            locationCode: loc.locationCode,
            locationName: nameOf(loc.locationId),
            batchNo: r.batchNo,
            batchExpiryDate: r.batchExpiryDate,
            quantity: r.quantity,
          };
        });
      }

      // 形态二：按 SKU 分组——total 总量 + byLocation 分库位明细（内嵌 batches 批次明细）
      //   + M19 冻结三件套：held 冻结合计 / available 可用量（= total − held）
      const groupOf = (skuId: string) => {
        const sku = ws.skus.byId(skuId);
        const rows = ws.inventory.list().filter((r) => r.skuId === skuId);
        // 库位聚合（批次维度行 → 库位行），库位内保留批次明细
        const byLoc = new Map<
          string,
          { quantity: number; batches: { batchNo: string; batchExpiryDate: string | null; quantity: number }[] }
        >();
        for (const r of rows) {
          const cur = byLoc.get(r.locationId) ?? { quantity: 0, batches: [] };
          cur.quantity += r.quantity;
          cur.batches.push({
            batchNo: r.batchNo,
            batchExpiryDate: r.batchExpiryDate,
            quantity: r.quantity,
          });
          byLoc.set(r.locationId, cur);
        }
        const total = rows.reduce((a, r) => a + r.quantity, 0);
        const held = ws.inventory.heldOf(skuId);
        return {
          skuId,
          skuCode: sku?.skuCode ?? '(已删除)',
          name: sku?.name ?? '',
          total,
          held,
          available: total - held,
          byLocation: [...byLoc.entries()].map(([locationId, l]) => ({
            locationCode: codeOfLocation(ws, locationId),
            locationName: nameOf(locationId),
            quantity: l.quantity,
            batches: l.batches.sort((a, b) => a.batchNo.localeCompare(b.batchNo)),
          })),
        };
      };
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        return groupOf(sku.id); // 无库存 → { total: 0, byLocation: [] }
      }
      return ws.inventory
        .list()
        .map((r) => r.skuId)
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .map(groupOf)
        .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    },
  };

  const inventoryHolds: ToolDefinition<{ skuCode?: string }> = {
    id: 'wms.inventory.holds',
    label: '查询冻结',
    description:
      '查询活动冻结清单（每行一笔冻结：holdId、SKU、数量、原因、时间）。给 skuCode 只查该 SKU；不给查全部。已释放的冻结不在此列（历史在事件账本）。释放冻结（wms.inventory.release）前先经本工具拿 holdId。纯读操作，不产生事件。',
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
      let skuId: string | undefined;
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        skuId = sku.id;
      }
      return ws.inventory.listHolds(skuId).map((h) => {
        const sku = ws.skus.byId(h.skuId);
        return {
          holdId: h.id,
          skuCode: sku?.skuCode ?? h.skuId,
          name: sku?.name ?? '',
          quantity: h.quantity,
          reason: h.reason,
          createdAt: h.createdAt,
        };
      });
    },
  };

  const inventoryLowstock: ToolDefinition<{ skuCode?: string }> = {
    id: 'wms.inventory.lowstock',
    label: '低库存预警',
    description:
      '低库存预警清单：列出安全库存（reorderPoint，经 sku.create/update 设置）大于 0 且可用量低于它的 SKU——可用量 = 全库位合计余量 − 冻结合计（M19 同一口径，冻结会吃掉可用量触发预警）。每行含 total 余量 / held 冻结 / available 可用量 / reorderPoint 阈值 / shortage 缺口（阈值 − 可用），按缺口降序（最缺的在前）。给 skuCode 只查该 SKU（可用于确认单品的预警状态）。补货建议的入口数据源；纯读操作，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选，缺省查全部预警项）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      let skus = ws.skus.list();
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        skus = [sku];
      }
      return skus
        .filter((s) => s.reorderPoint > 0)
        .map((s) => {
          const total = ws.inventory.totalOf(s.id);
          const held = ws.inventory.heldOf(s.id);
          return {
            skuCode: s.skuCode,
            name: s.name,
            total,
            held,
            available: total - held,
            reorderPoint: s.reorderPoint,
            shortage: s.reorderPoint - (total - held),
          };
        })
        .filter((r) => r.available < r.reorderPoint)
        .sort((a, b) => b.shortage - a.shortage || a.skuCode.localeCompare(b.skuCode));
    },
  };

  const inventoryExpiring: ToolDefinition<{ days?: number }> = {
    id: 'wms.inventory.expiring',
    label: '临期查询',
    description:
      '查询临期/过期的批次库存：列出效期在 N 天内（含已过期）的批次余量——SKU、库位、批次号、效期、剩余天数、数量，按效期升序（最先到期的排前面）。days 缺省 30。未指定批次的库存（虚拟批次 DEFAULT）无效期，不出现在结果中；未声明效期的真批次同样不出现在结果中。出库遇过期批次 v1 不拦截，本工具用于临期可见性（提醒先进先出）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 0, maximum: 3650, description: '临期阈值天数（缺省 30，含已过期）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const days = params.days ?? 30;
      if (!Number.isInteger(days) || days < 0) {
        throw new Error('TOOL_REJECTED: days 必须是非负整数');
      }
      const today = new Date().toISOString().slice(0, 10); // UTC 日期（与自动单号同源）
      const nameOf = (locationId: string): string =>
        locationId === DEFAULT_LOCATION_ID
          ? '默认库位'
          : (ws.locations.byId(locationId)?.name ?? '(未知库位)');
      return ws.inventory.listExpiring(days, today).map((r) => {
        const sku = ws.skus.byId(r.skuId);
        return {
          skuId: r.skuId,
          skuCode: sku?.skuCode ?? '(已删除)',
          name: sku?.name ?? '',
          locationCode: codeOfLocation(ws, r.locationId),
          locationName: nameOf(r.locationId),
          batchNo: r.batchNo,
          batchExpiryDate: r.batchExpiryDate,
          daysLeft: Math.round((Date.parse(r.batchExpiryDate!) - Date.parse(today)) / 86400000),
          quantity: r.quantity,
        };
      });
    },
  };

  return [
    def(inventoryAdjust),
    def(inventoryMove),
    def(inventoryHold),
    def(inventoryRelease),
    def(inventoryQuery),
    def(inventoryHolds),
    def(inventoryLowstock),
    def(inventoryExpiring),
  ];
}
