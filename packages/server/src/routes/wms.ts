import { Hono } from 'hono';
import type { OrderDirection, OrderRecord } from '@one/wms';
import type { AppContext } from '../context.js';

/**
 * 管理界面业务端点（读写分治，契约见 ARCHITECTURE.md @one/server 章节）：
 *  - 读 = 直查投影视图（投影是缓存，只读安全）；
 *  - 写 = 全部经工具总线（人与 AI 走同一条命令通道，护栏 + 审计免费）。
 * 本文件不做业务校验——那是工具 handler 的职责；错误经 onError 统一映射
 * （WMS_* / TOOL_* → 400 + code，前端按 code 分支提示）。
 */

/** 人操作界面的 actor（带节点后缀：审计可辨「人做的」，且同步通道节点唯一） */
function actorOf(ctx: AppContext): string {
  return `user:local@${ctx.core.nodeId}`;
}

/** GET /api/orders 响应：单据 + 明细行（联查 SKU 补编码/名称，组装不碰 SQL） */
export interface OrderWithLines extends OrderRecord {
  lines: { skuCode: string; name: string; quantity: number }[];
}

export function wmsRoutes(ctx: AppContext): Hono {
  return new Hono()
    // ── SKU ─────────────────────────────────────────────
    .get('/skus', (c) => c.json(ctx.ws.skus.list()))
    .post('/skus', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.sku.create', body, actorOf(ctx)), 201);
    })
    // ── 单据 ────────────────────────────────────────────
    .get('/orders', (c) => {
      const q = c.req.query('direction');
      const direction = q === 'in' || q === 'out' ? (q as OrderDirection) : undefined;
      return c.json(ctx.ws.orders.list(direction).map((o) => withLines(ctx, o)));
    })
    .post('/orders', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.order.create', body, actorOf(ctx)), 201);
    })
    .post('/orders/:orderNo/transition', async (c) => {
      const body = await c.req.json();
      const result = await ctx.ws.tools.invoke(
        'wms.order.transition',
        { orderNo: c.req.param('orderNo'), to: body.to },
        actorOf(ctx),
      );
      return c.json(result);
    })
    // ── 库存 ────────────────────────────────────────────
    .get('/inventory', (c) => {
      // 与 wms.inventory.query 工具同形：仅有流水的 SKU + 联查编码/名称
      const rows = ctx.ws.inventory.list().map((r) => {
        const sku = ctx.ws.skus.byId(r.skuId);
        return { skuId: r.skuId, skuCode: sku?.skuCode ?? '(未知)', name: sku?.name ?? '', quantity: r.quantity };
      });
      return c.json(rows);
    })
    .post('/inventory/adjust', async (c) => {
      const body = await c.req.json();
      return c.json(await ctx.ws.tools.invoke('wms.inventory.adjust', body, actorOf(ctx)));
    });
}

/** 明细行联查：skuId → skuCode/name（经视图 API，不碰 SQL） */
function withLines(ctx: AppContext, order: OrderRecord): OrderWithLines {
  const lines = ctx.ws.orders.lines(order.id).map((l) => {
    const sku = ctx.ws.skus.byId(l.skuId);
    return { skuCode: sku?.skuCode ?? '(未知)', name: sku?.name ?? '', quantity: l.quantity };
  });
  return { ...order, lines };
}
