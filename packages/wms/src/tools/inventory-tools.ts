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
  assertNonZeroQty,
  assertPositiveQty,
  bucketLabel,
  codeOfLocation,
  QTY_EPS,
  resolveBatch,
  resolveLocation,
} from '../state/inventory-policy.js';
import { assertLooseEnough } from '../state/lpn-policy.js';
import { appendSerialPlans, planQuantitySerials, rejectSerialKeyWhenOff } from '../state/serial-policy.js';
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
    serials?: string[];
  }> = {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description:
      '对某 SKU 做库存增减：delta 为正数是入库、负数是出库（支持 3 位小数，如 -0.5 表示出半斤）。可选 locationCode 指定库位（缺省为默认库位 DEFAULT）；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——正数入库声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），负数出库只扣指定批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。出库超出该库位该批次当前余量会被拒绝（库存不可为负）。可选关联单据号。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        delta: { type: 'number', minimum: -1000000000, maximum: 1000000000, description: '数量变化：正数入库，负数出库（支持 3 位小数）' },
        reason: { type: 'string', description: '调整原因（可选，如 入库上架 / 盘点 / 报损）' },
        orderNo: { type: 'string', description: '关联单据号（可选）' },
        locationCode: { type: 'string', description: '库位编码（可选，缺省为默认库位 DEFAULT）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT；批次随首条入库流水诞生）' },
        batchExpiryDate: { type: 'string', description: '批次效期 YYYY-MM-DD（可选，仅入库；同批次后继必须一致）' },
        serials: {
          type: 'array',
          items: { type: 'string' },
          description: '序列号（module.serial。SKU 按序列号管理时必填，个数等于本次件数；一件一个号）',
        },
      },
      required: ['skuCode', 'delta'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      rejectSerialKeyWhenOff(ws, params);
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const loc = resolveLocation(ws, params.locationCode);
      const delta = assertNonZeroQty(params.delta, 'delta');
      if (delta < 0 && params.batchExpiryDate) {
        throw new Error('TOOL_REJECTED: 出库（负 delta）不支持批次效期——效期随入库声明');
      }
      const batch = resolveBatch(params.batchNo, params.batchExpiryDate);
      // 批次效期一致性（M11）：新批次登记 / 老批次比对（建批 fail-fast）
      assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
      if (delta < 0) {
        const available = ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo);
        if (available + delta < -QTY_EPS) {
          throw new InsufficientStockError(
            bucketLabel(sku.skuCode, loc.locationCode, batch.batchNo),
            delta,
            available,
          );
        }
        assertLooseEnough(ws, {
          skuCode: sku.skuCode,
          skuId: sku.id,
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          batchNo: batch.batchNo,
          take: -delta,
          onHand: available,
        });
      }
      const serialPlans = planQuantitySerials(ws, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialTracked: sku.serialTracked,
        hasSerials: Object.hasOwn(params, 'serials'),
        serials: params.serials,
        quantity: delta,
        locationId: loc.locationId,
        batchNo: batch.batchNo,
        direction: delta > 0 ? 'receive' : 'issue',
      });
      let orderId: string | undefined;
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        orderId = order.id;
      }
      const writeAdjust = () => {
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta,
          reason: params.reason ?? (delta > 0 ? 'inbound' : 'outbound'),
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          batchNo: batch.batchNo,
          batchExpiryDate: batch.batchExpiryDate,
          orderId,
          orderNo: params.orderNo,
        });
        appendSerialPlans(ctx, serialPlans);
      };
      if (serialPlans.length > 0) ws.runAtomic(writeAdjust);
      else writeAdjust();
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
    serials?: string[];
  }> = {
    id: 'wms.inventory.move',
    label: '移库',
    description:
      '把某 SKU 的库存从一个库位移到另一个库位（同批次数量转移，总量不变，数量支持 3 位小数）。fromLocationCode / toLocationCode 缺省均为默认库位 DEFAULT；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——移的是该批次的货，源与目标不能相同；源库位该批次余量不足会拒绝。移库产生一对 transfer 流水（-源 / +目标），可审计。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        fromLocationCode: { type: 'string', description: '源库位编码（可选，缺省 DEFAULT）' },
        toLocationCode: { type: 'string', description: '目标库位编码（可选，缺省 DEFAULT）' },
        quantity: { type: 'number', minimum: 0.001, maximum: 1000000000, description: '移库数量（正数，支持 3 位小数）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT）' },
        serials: {
          type: 'array',
          items: { type: 'string' },
          description: '序列号（module.serial。SKU 按序列号管理时必填，个数等于移库件数）',
        },
      },
      required: ['skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      rejectSerialKeyWhenOff(ws, params);
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const quantity = assertPositiveQty(params.quantity, 'quantity');
      const from = resolveLocation(ws, params.fromLocationCode);
      const to = resolveLocation(ws, params.toLocationCode);
      const batch = resolveBatch(params.batchNo, undefined); // 移库不带效期（批次属性已在入库登记）
      if (from.locationId === to.locationId) {
        throw new Error('TOOL_REJECTED: 源库位与目标库位相同');
      }
      const available = ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo);
      if (available + QTY_EPS < quantity) {
        throw new InsufficientStockError(
          bucketLabel(sku.skuCode, from.locationCode, batch.batchNo),
          -quantity,
          available,
        );
      }
      assertLooseEnough(ws, {
        skuCode: sku.skuCode,
        skuId: sku.id,
        locationId: from.locationId,
        locationCode: from.locationCode,
        batchNo: batch.batchNo,
        take: quantity,
        onHand: available,
      });
      const serialPlans = planQuantitySerials(ws, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialTracked: sku.serialTracked,
        hasSerials: Object.hasOwn(params, 'serials'),
        serials: params.serials,
        quantity,
        locationId: from.locationId,
        batchNo: batch.batchNo,
        direction: 'move',
        toLocationId: to.locationId,
        toBatchNo: batch.batchNo,
      });
      // 原子落账（M9 runAtomic）：-源 / +目标 两条流水同生共死，杜绝「出旧库位
      // 了没进新库位」的半落账。零新事件类型——移库就是一对普通流水事实。
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: -quantity,
          reason: 'transfer',
          locationId: from.locationId,
          locationCode: from.locationCode,
          batchNo: batch.batchNo,
        });
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: quantity,
          reason: 'transfer',
          locationId: to.locationId,
          locationCode: to.locationCode,
          batchNo: batch.batchNo,
        });
        appendSerialPlans(ctx, serialPlans);
      });
      ws.sync();
      return {
        skuCode: sku.skuCode,
        from: from.locationCode,
        to: to.locationCode,
        batchNo: batch.batchNo,
        quantity,
        fromBalance: ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo),
        toBalance: ws.inventory.quantityOf(sku.id, to.locationId, batch.batchNo),
      };
    },
  };

  const inventoryHold: ToolDefinition<{ skuCode: string; quantity: number; reason?: string }> = {
    id: 'wms.inventory.hold',
    label: '冻结库存',
    description:
      '冻结某 SKU 的一部分数量（如 质检隔离 / 客订预留 / 促销占位，数量支持 3 位小数）。冻结不改物理库存、不产生流水——只是把数量标记为不可出库：单据出库（拣货/发货）会校验可用量 = 全库位合计余量 − 冻结合计，不足即拒。同 SKU 可多笔冻结；已冻结合计 + 本次不能超过账面余量。释放用 wms.inventory.release（按 holdId）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        quantity: { type: 'number', minimum: 0.001, maximum: 1000000000, description: '冻结数量（正数，支持 3 位小数）' },
        reason: { type: 'string', description: '冻结原因（如 质检隔离 / 客订预留）' },
      },
      required: ['skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const quantity = assertPositiveQty(params.quantity, 'quantity');
      const total = ws.inventory.totalOf(sku.id);
      const held = ws.inventory.heldOf(sku.id);
      if (held + quantity > total + QTY_EPS) {
        throw new HoldExceedsStockError(sku.skuCode, quantity, total, held);
      }
      const holdId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryHeld, {
        holdId,
        skuId: sku.id,
        skuCode: sku.skuCode,
        quantity,
        reason: params.reason ?? 'hold',
      });
      ws.sync();
      return {
        holdId,
        skuCode: sku.skuCode,
        quantity,
        total,
        held: held + quantity,
        available: total - held - quantity - ws.inventory.reservedOfSku(sku.id),
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
        available: total - held - ws.inventory.reservedOfSku(hold.skuId),
      };
    },
  };

  const inventoryQuery: ToolDefinition<{ skuCode?: string; locationCode?: string }> = {
    id: 'wms.inventory.query',
    label: '查询库存',
    description:
      '查询库存余量（按 SKU 汇总，可下钻库位与批次明细；分组形态含 held 冻结合计、reserved 拣货占用，以及 available 可用量 = 总量 − 冻结 − 占用）。给 skuCode 查单个 SKU（返回 total 总量与 byLocation 分库位明细，库位内再列 batches 批次明细）；都不给列出全部 SKU 的分组清单；给 locationCode 查该库位内有哪些货（平铺行，含批次号与效期）。库位 DEFAULT 是默认库位、批次 DEFAULT 是虚拟批次（未指定维度的库存归宿）。',
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
      //   + held 冻结合计 / reserved 拣货占用 / available = total − held − reserved
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
        const reserved = ws.inventory.reservedOfSku(skuId);
        return {
          skuId,
          skuCode: sku?.skuCode ?? '(已删除)',
          name: sku?.name ?? '',
          total,
          held,
          reserved,
          available: total - held - reserved,
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
      '低库存预警清单：列出安全库存（reorderPoint，经 sku.create/update 设置）大于 0 且可用量低于它的 SKU——可用量 = 全库位合计余量 − 冻结合计 − 拣货占用。冻结和占用都会吃掉可用量从而触发预警。每行含 total 余量 / held 冻结 / reserved 占用 / available 可用量 / reorderPoint 阈值 / shortage 缺口（阈值 − 可用），按缺口降序（最缺的在前）。给 skuCode 只查该 SKU（可用于确认单品的预警状态）。补货建议的入口数据源；纯读操作，不产生事件。',
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
        .filter((s) => (s.status ?? 'active') === 'active') // A2：停用档退出预警（存量照常可扣）
        .map((s) => {
          const total = ws.inventory.totalOf(s.id);
          const held = ws.inventory.heldOf(s.id);
          const reserved = ws.inventory.reservedOfSku(s.id);
          const available = total - held - reserved;
          return {
            skuCode: s.skuCode,
            name: s.name,
            total,
            held,
            reserved,
            available,
            reorderPoint: s.reorderPoint,
            shortage: s.reorderPoint - available,
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
      return ws.inventory
        .listExpiring(days, today)
        .filter((r) => (ws.skus.byId(r.skuId)?.status ?? 'active') !== 'archived') // A2：停用档退出效期预警
        .map((r) => {
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

  const ledgerQuery: ToolDefinition<{
    skuCode?: string;
    locationCode?: string;
    orderNo?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }> = {
    id: 'wms.ledger.query',
    label: '查询库存流水',
    description:
      '查询库存变动流水（审计账本：每笔 ±变动一事件一行，append-only 不可篡改）。' +
      '支持按 skuCode（SKU 编码）、locationCode（库位编码）、orderNo（关联单据号）过滤，' +
      'from/to 是 ISO 时间闭区间（YYYY-MM-DD 或完整时间戳）。' +
      '最新在前；limit 默认 20（上限 200）、offset 翻页；返回 { total, limit, offset, hasMore, rows }。' +
      '每行含 createdAt / skuCode / locationCode / batchNo / delta（正入负出）/ reason / orderNo。' +
      '查「最近的库存变动」「某 SKU 的出入库历史」「某单据动了哪些库存」用本工具；纯读操作。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选过滤）' },
        locationCode: { type: 'string', description: '库位编码（可选过滤）' },
        orderNo: { type: 'string', description: '关联单据号（可选过滤）' },
        from: { type: 'string', description: '起始时间（ISO，含）' },
        to: { type: 'string', description: '结束时间（ISO，含）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页行数（缺省 20）' },
        offset: { type: 'integer', minimum: 0, description: '跳过行数（缺省 0，翻页用）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      let skuId: string | undefined;
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        skuId = sku.id;
      }
      const loc = params.locationCode ? resolveLocation(ws, params.locationCode) : undefined;
      let orderId: string | undefined;
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        orderId = order.id;
      }

      const { rows, total } = ws.inventory.listLedgerPage({
        skuId,
        locationId: loc?.locationId,
        orderId,
        from: params.from,
        to: params.to,
        limit,
        offset,
      });

      // orderId → orderNo 换算缓存：页内同一单据只查一次投影
      const orderNoOf = new Map<string, string>();
      const resolveOrderNo = (id: string | null): string | null => {
        if (!id) return null;
        let no = orderNoOf.get(id);
        if (no === undefined) {
          no = ws.orders.byId(id)?.orderNo ?? '(未知单据)';
          orderNoOf.set(id, no);
        }
        return no;
      };

      return {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
        rows: rows.map((r) => {
          const sku = ws.skus.byId(r.skuId);
          return {
            createdAt: r.createdAt,
            skuCode: sku?.skuCode ?? '(已删除)',
            locationCode: codeOfLocation(ws, r.locationId),
            batchNo: r.batchNo,
            delta: r.delta,
            reason: r.reason,
            orderNo: resolveOrderNo(r.orderId),
          };
        }),
      };
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
    def(ledgerQuery),
  ];
}
