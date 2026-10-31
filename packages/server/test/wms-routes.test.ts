import { describe, it, expect, afterEach } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * 管理界面业务端点直测（读写分治的契约验证）：
 *  - 读直查投影：列表形状（extData / lines 联查 / direction 过滤）；
 *  - 写走工具总线：护栏错误（WMS_*）映射 400 + code，actor 审计免费（user:local）。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

function setup(): ReturnType<typeof createApp> {
  ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-wms-routes-test' });
  return createApp(ctx);
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

describe('SKU 端点', () => {
  it('POST 建SKU（含扩展字段）→ GET 列表直查投影', async () => {
    const app = setup();
    const res = await post(app, '/api/skus', {
      skuCode: 'A-1001',
      name: '轴承',
      extData: { spec: '6204-2RS', category: '标准件' },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { skuId: string; skuCode: string };
    expect(created.skuCode).toBe('A-1001');
    expect(created.skuId).toBeTruthy();

    const listRes = await app.request('/api/skus');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      skuCode: string;
      name: string;
      extData: Record<string, unknown>;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.extData['spec']).toBe('6204-2RS');
  });

  it('重复编码 → 400 WMS_SKU_EXISTS（工具护栏经错误映射透传）', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    const res = await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝二号' });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('WMS_SKU_EXISTS');
  });

  it('缺必填字段 → 400（schema 校验器拒绝）', async () => {
    const app = setup();
    const res = await post(app, '/api/skus', { name: '没有编码' });
    expect(res.status).toBe(400);
  });
});

describe('单据端点', () => {
  async function seedSku(app: ReturnType<typeof createApp>, code: string, name: string) {
    await post(app, '/api/skus', { skuCode: code, name });
  }

  it('建单 → 列表附带明细行（联查 skuCode/name）+ direction 过滤', async () => {
    const app = setup();
    await seedSku(app, 'A-1', '螺丝');
    await seedSku(app, 'B-2', '螺母');

    const res = await post(app, '/api/orders', {
      direction: 'in',
      lines: [
        { skuCode: 'A-1', quantity: 100 },
        { skuCode: 'B-2', quantity: 50 },
      ],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { orderNo: string; state: string };
    expect(created.orderNo).toMatch(/^IN-/);
    expect(created.state).toBe('created');

    const listRes = await app.request('/api/orders');
    const orders = (await listRes.json()) as Array<{
      orderNo: string;
      direction: string;
      state: string;
      lines: Array<{ skuCode: string; name: string; quantity: number }>;
    }>;
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lines).toEqual([
      { skuCode: 'A-1', name: '螺丝', quantity: 100 },
      { skuCode: 'B-2', name: '螺母', quantity: 50 },
    ]);

    // 方向过滤：out 为空
    const outRes = await app.request('/api/orders?direction=out');
    const outOrders = (await outRes.json()) as unknown[];
    expect(outOrders).toHaveLength(0);
  });

  it('状态流转：合法转移成功，非法转移 400 WMS_INVALID_TRANSITION', async () => {
    const app = setup();
    await seedSku(app, 'A-1', '螺丝');
    const created = (await (await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })).json()) as { orderNo: string };

    // 入库单 created → received 合法
    const ok = await post(app, `/api/orders/${created.orderNo}/transition`, { to: 'received' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { to: string }).to).toBe('received');

    // received → picking 非法（那是出库单的路径）
    const bad = await post(app, `/api/orders/${created.orderNo}/transition`, { to: 'picking' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('WMS_INVALID_TRANSITION');
  });

  it('明细引用不存在的 SKU → 400 WMS_SKU_NOT_FOUND', async () => {
    const app = setup();
    const res = await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: '幽灵', quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('WMS_SKU_NOT_FOUND');
  });
});

describe('库存端点', () => {
  it('调整 → 清单联查 SKU 信息；负库存防线 400', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });

    const inRes = await post(app, '/api/inventory/adjust', {
      skuCode: 'A-1',
      delta: 30,
      reason: '期初上架',
    });
    expect(inRes.status).toBe(200);
    expect(((await inRes.json()) as { quantity: number }).quantity).toBe(30);

    const listRes = await app.request('/api/inventory');
    const rows = (await listRes.json()) as Array<{
      skuCode: string;
      name: string;
      quantity: number;
    }>;
    expect(rows).toEqual([{ skuId: expect.any(String), skuCode: 'A-1', name: '螺丝', quantity: 30 }]);

    // 出库超余量 → 拒绝（库存不可为负）
    const bad = await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: -100 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('WMS_INSUFFICIENT_STOCK');
  });

  it('delta = 0 → 400 TOOL_REJECTED（handler 深层校验的普通 Error 也映射 400）', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    const res = await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 0 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('TOOL_REJECTED');
  });
});

describe('写操作的审计（人与 AI 同通道的红利）', () => {
  it('全部业务事件的 actor = user:local@nodeId（同步通道节点唯一）', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/orders', { direction: 'in', lines: [{ skuCode: 'A-1', quantity: 5 }] });

    const events = ctx!.ws.events.byActor(`user:local@${ctx!.core.nodeId}`, 0);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const env of events) {
      expect(env.type.startsWith('wms.')).toBe(true);
    }
  });
});
