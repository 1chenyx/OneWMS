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

describe('效期看板端点（M14：临期分层预警）', () => {
  /** 相对今天的日期（UTC）：与端点/工具层的 today 判定同源 */
  const dateOffset = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const today = dateOffset(0);

  /** 经 HTTP adjust 灌一个批次桶（正数入库声明批次 + 效期） */
  async function seedBatch(
    app: ReturnType<typeof createApp>,
    skuCode: string,
    batchNo: string,
    expiry: string,
    delta: number,
    locationCode?: string,
  ) {
    const res = await post(app, '/api/inventory/adjust', {
      skuCode,
      delta,
      batchNo,
      batchExpiryDate: expiry,
      reason: '期初上架',
      ...(locationCode ? { locationCode } : {}),
    });
    expect(res.status).toBe(200);
  }

  it('SKU×批次 聚合 + 五层分级 + 效期升序（未登记殿后）+ 零余量桶不上板', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母' });
    // 实体库位（默认库位 DEFAULT 是虚拟保留词，不经创建）
    await ctx!.ws.tools.invoke(
      'wms.location.create',
      { locationCode: 'LOC-01', name: '一号架' },
      'user:test',
    );

    // 过期批次（today-3）跨两库位：默认 5 + LOC-01 3 → 聚合 8
    await seedBatch(app, 'A-1', 'B-OLD', dateOffset(-3), 5);
    await seedBatch(app, 'A-1', 'B-OLD', dateOffset(-3), 3, 'LOC-01');
    // 今天到期（critical 边界：今天 = 临期，未过期——与 M13 拦截同界）
    await seedBatch(app, 'A-1', 'B-TODAY', dateOffset(0), 4);
    // critical 上界（+7）/ warning 上界（+30）/ safe 下界（+31）
    await seedBatch(app, 'B-2', 'B-SOON', dateOffset(7), 10);
    await seedBatch(app, 'B-2', 'B-MID', dateOffset(30), 20);
    await seedBatch(app, 'B-2', 'B-LATE', dateOffset(31), 30);
    // 零余量桶（+10 后 -10）：出清的批次不上板
    await seedBatch(app, 'A-1', 'B-ZERO', dateOffset(5), 10);
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: -10, batchNo: 'B-ZERO' });
    // 未指定批次 → DEFAULT 虚拟批次（未登记效期 → unknown）
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 2, reason: '期初' });

    const res = await app.request('/api/inventory/expiry');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: string;
      rows: Array<{
        skuCode: string;
        batchNo: string;
        batchExpiryDate: string | null;
        daysLeft: number | null;
        level: string;
        quantity: number;
        locations: string[];
      }>;
    };
    expect(body.today).toBe(today);

    // 排序：效期升序（最紧急在上），未登记效期殿后；B-ZERO 零余量被过滤
    expect(body.rows.map((r) => r.batchNo)).toEqual([
      'B-OLD',
      'B-TODAY',
      'B-SOON',
      'B-MID',
      'B-LATE',
      'DEFAULT',
    ]);

    const [old, todayRow, soon, mid, late, unknown] = body.rows;
    // 过期批：daysLeft 负、余量跨库位合计、库位清单（虚拟默认兜底直出 id）
    expect(old).toMatchObject({
      skuCode: 'A-1',
      level: 'expired',
      daysLeft: -3,
      quantity: 8,
    });
    expect([...old.locations].sort()).toEqual(['DEFAULT', 'LOC-01']);
    // 今天到期 → critical（0 天）
    expect(todayRow).toMatchObject({ level: 'critical', daysLeft: 0, quantity: 4 });
    // critical 上界 +7；warning 上界 +30；safe 下界 +31
    expect(soon).toMatchObject({ skuCode: 'B-2', level: 'critical', daysLeft: 7 });
    expect(mid).toMatchObject({ level: 'warning', daysLeft: 30 });
    expect(late).toMatchObject({ level: 'safe', daysLeft: 31 });
    // DEFAULT 虚拟批次：未登记效期
    expect(unknown).toMatchObject({
      batchNo: 'DEFAULT',
      batchExpiryDate: null,
      daysLeft: null,
      level: 'unknown',
    });
  });

  it('空库存 → 空板（rows: []，today 仍在——前端可展示截至日期）', async () => {
    const app = setup();
    const res = await app.request('/api/inventory/expiry');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; rows: unknown[] };
    expect(body.today).toBe(today);
    expect(body.rows).toEqual([]);
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
