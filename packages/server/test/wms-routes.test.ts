import { describe, it, expect, afterEach } from 'vitest';
import type { PatchOp } from '@one/core';
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
  // 这些端点测的是收货、上架、拣货和发货。质检、波次、复核、打包、装车默认开着且必做，先关掉。
  const snapshot = ctx.ws.profile.getSnapshot();
  const patch: PatchOp[] = ['module.qc', 'module.wave', 'module.review', 'module.pack', 'module.load']
    .filter((id) => snapshot.modules[id]?.enabled === true)
    .map((id) => ({ op: 'replace', path: `/modules/${id}/enabled`, value: false }));
  if (patch.length > 0) {
    const proposed = ctx.ws.profile.propose('user:tester', patch, '测试跳过质检、波次、复核、打包、装车');
    ctx.ws.profile.confirm(proposed.proposalId, 'user:tester');
  }
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

  it('缺名称 → 400（schema 校验器拒绝）', async () => {
    const app = setup();
    const res = await post(app, '/api/skus', { skuCode: 'A-1' });
    expect(res.status).toBe(400);
  });

  // ── 条码（M18）──────────────────────────────────────

  it('建 SKU 带条码 → GET ?barcode= 精确命中 / ?q= 三字段模糊', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1001', name: '轴承', barcode: '6901000000018' });
    await post(app, '/api/skus', { skuCode: 'B-2002', name: '机油' });

    // 条码精确匹配（扫码枪入口）
    const byBarcode = await app.request('/api/skus?barcode=6901000000018');
    const hit = (await byBarcode.json()) as Array<{ skuCode: string; barcode: string | null }>;
    expect(hit).toHaveLength(1);
    expect(hit[0]!.skuCode).toBe('A-1001');
    expect(hit[0]!.barcode).toBe('6901000000018');

    // q 模糊：编码 / 名称 / 条码 三字段
    const byCode = (await (await app.request('/api/skus?q=1001')).json()) as unknown[];
    const byName = (await (await app.request('/api/skus?q=机')).json()) as unknown[];
    const byBc = (await (await app.request('/api/skus?q=000018')).json()) as unknown[];
    expect(byCode).toHaveLength(1);
    expect(byName).toHaveLength(1);
    expect(byBc).toHaveLength(1);

    // 无条码 SKU 不命中条码查询
    const none = (await (await app.request('/api/skus?barcode=9999')).json()) as unknown[];
    expect(none).toHaveLength(0);
  });

  it('条码冲突 → 400 WMS_SKU_BARCODE_EXISTS', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝', barcode: '6901' });
    const res = await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母', barcode: '6901' });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('WMS_SKU_BARCODE_EXISTS');
  });

  // ── 软停用 + 单位（A2/A3）────────────────────────────

  it('archive 端点：停用后默认列表隐藏，includeArchived=1 回全量，条码查询不受过滤', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝', barcode: '6901', unit: 'kg' });
    await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母' });

    const archiveRes = await app.request('/api/skus/A-1/archive', { method: 'POST' });
    expect(archiveRes.status).toBe(200);
    expect(((await archiveRes.json()) as { status: string }).status).toBe('archived');

    // 默认只回 active
    const def = (await (await app.request('/api/skus')).json()) as Array<{ skuCode: string }>;
    expect(def.map((s) => s.skuCode)).toEqual(['B-2']);

    // includeArchived=1 回全量
    const all = (await (await app.request('/api/skus?includeArchived=1')).json()) as Array<{
      skuCode: string;
      status?: string;
    }>;
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.skuCode === 'A-1')!.status).toBe('archived');

    // 条码精确查询不过滤（扫码定位语义）
    const byBc = (await (await app.request('/api/skus?barcode=6901')).json()) as Array<{
      skuCode: string;
    }>;
    expect(byBc.map((s) => s.skuCode)).toEqual(['A-1']);

    // unarchive 恢复
    await app.request('/api/skus/A-1/unarchive', { method: 'POST' });
    const restored = (await (await app.request('/api/skus')).json()) as Array<{ skuCode: string }>;
    expect(restored).toHaveLength(2);
  });

  it('创建/更新带 unit → 投影返回带 unit（null 兜底）', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '散装螺丝', unit: 'kg' });
    const putRes = await app.request('/api/skus/A-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '散装螺丝改' }),
    });
    expect(putRes.status).toBe(200);
    const list = (await (await app.request('/api/skus')).json()) as Array<{
      skuCode: string;
      unit: string | null;
    }>;
    expect(list[0]!.unit).toBe('kg');
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
      lines: Array<{ skuCode: string; name: string; quantity: number; locationCode: string; batchNo: string }>;
    }>;
    expect(orders).toHaveLength(1);
    // M21：行携带目标库位/批次（上架归位的源桶维度）；A1/A3：unit + batchExpiryDate
    expect(orders[0]!.lines).toEqual([
      {
        skuCode: 'A-1',
        name: '螺丝',
        quantity: 100,
        unit: null,
        locationCode: 'DEFAULT',
        batchNo: 'DEFAULT',
        batchExpiryDate: null,
        fulfilledQty: null,
      },
      {
        skuCode: 'B-2',
        name: '螺母',
        quantity: 50,
        unit: null,
        locationCode: 'DEFAULT',
        batchNo: 'DEFAULT',
        batchExpiryDate: null,
        fulfilledQty: null,
      },
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

  it('上架端点（M21）：收货 → 纯确认；归位 → 移库流水；重复上架 400', async () => {
    const app = setup();
    await seedSku(app, 'A-1', '螺丝');
    // 库位经工具通道建（POST /api/locations 未设路由——库位管理走 AI/工具）
    await ctx!.ws.tools.invoke(
      'wms.location.create',
      { locationCode: 'A-01', name: 'A 区 01' },
      `user:local@${ctx!.core.nodeId}`,
    );
    const created = (await (await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 10 }],
    })).json()) as { orderNo: string };
    await post(app, `/api/orders/${created.orderNo}/transition`, { to: 'received' });

    // 归位上架：DEFAULT → A-01（一对 ± 流水）
    const r = await (await post(app, `/api/orders/${created.orderNo}/putaway`, {
      targets: [{ skuCode: 'A-1', toLocationCode: 'A-01' }],
    })).json() as {
      from: string;
      to: string;
      movedLines: { toLocationCode: string; quantity: number }[];
    };
    expect(r).toMatchObject({ from: 'received', to: 'putaway' });
    expect(r.movedLines[0]).toMatchObject({ toLocationCode: 'A-01', quantity: 10 });

    // 库存落在 A-01（效期看板行带库位桶明细，联查可见）
    const board = (await (await app.request('/api/inventory/expiry')).json()) as {
      rows: { skuCode: string; batchNo: string; buckets: { locationCode: string; quantity: number }[] }[];
    };
    expect(board.rows.find((row) => row.skuCode === 'A-1')?.buckets).toEqual([
      { locationCode: 'A-01', quantity: 10 },
    ]);

    // 重复上架（已不是 received）→ 400
    const again = await post(app, `/api/orders/${created.orderNo}/putaway`, {});
    expect(again.status).toBe(400);
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
    // M19：行含冻结三件套（无冻结时 held 0 / available = quantity）；M20 附 reorderPoint；A3 附 unit
    expect(rows).toEqual([
      {
        skuId: expect.any(String),
        skuCode: 'A-1',
        name: '螺丝',
        quantity: 30,
        held: 0,
        reserved: 0,
        available: 30,
        reorderPoint: 0,
        unit: null,
      },
    ]);

    const badView = await app.request('/api/inventory/slices?view=bin&limit=50');
    expect(badView.status).toBe(400);
    expect(((await badView.json()) as { code: string }).code).toBe('BAD_QUERY');

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
        buckets: { locationCode: string; quantity: number }[];
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
    // 过期批：daysLeft 负、余量跨库位合计、库位明细（余量降序；虚拟默认兜底直出 id）
    expect(old).toMatchObject({
      skuCode: 'A-1',
      level: 'expired',
      daysLeft: -3,
      quantity: 8,
    });
    expect(old.buckets).toEqual([
      { locationCode: 'DEFAULT', quantity: 5 },
      { locationCode: 'LOC-01', quantity: 3 },
    ]);
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

  // ── M15：阈值 settings 化（慢通道改值 → 看板分层即时变化）──

  /** 慢通道改 core.wms 设置（propose → confirm——配置变更的唯一路径，§7.3） */
  function setWmsSettings(patch: PatchOp[]): void {
    const { proposalId } = ctx!.ws.profile.propose('user:tester', patch, 'M15 阈值测试');
    ctx!.ws.profile.confirm(proposalId, 'user:tester');
  }

  /** 拉看板并解析成 batchNo → level 映射（阈值用例只关心分层归属） */
  async function boardLevels(
    app: ReturnType<typeof createApp>,
  ): Promise<Record<string, string>> {
    const res = await app.request('/api/inventory/expiry');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ batchNo: string; level: string }> };
    return Object.fromEntries(body.rows.map((r) => [r.batchNo, r.level]));
  }

  it('慢通道改阈值（critical=2 / warning=10）→ 分层即时变化', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await seedBatch(app, 'A-1', 'B-5', dateOffset(5), 10); // 缺省：5 ≤ 7 → critical
    await seedBatch(app, 'A-1', 'B-15', dateOffset(15), 10); // 缺省：15 ≤ 30 → warning

    expect(await boardLevels(app)).toEqual({ 'B-5': 'critical', 'B-15': 'warning' });

    setWmsSettings([
      { op: 'replace', path: '/modules/core.wms/settings/expiryCriticalDays', value: 2 },
      { op: 'replace', path: '/modules/core.wms/settings/expiryWarningDays', value: 10 },
    ]);
    // 5 > 2 且 ≤ 10 → warning；15 > 10 → safe（边界含等号：+2 仍 critical、+10 仍 warning）
    await seedBatch(app, 'A-1', 'B-2', dateOffset(2), 10);
    await seedBatch(app, 'A-1', 'B-10', dateOffset(10), 10);
    expect(await boardLevels(app)).toEqual({
      'B-2': 'critical',
      'B-10': 'warning',
      'B-5': 'warning',
      'B-15': 'safe',
    });
  });

  it('脏值 / 次序不合法 → 阈值联动回落缺省 7/30（分层与缺省一致）', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await seedBatch(app, 'A-1', 'B-7', dateOffset(7), 10); // critical 上界（7 ≤ 7）
    await seedBatch(app, 'A-1', 'B-8', dateOffset(8), 10); // warning（8 ≤ 30）
    await seedBatch(app, 'A-1', 'B-31', dateOffset(31), 10); // safe（31 > 30）

    // 字符串脏值（慢通道不校验类型）→ 非 number 整体回落
    setWmsSettings([
      { op: 'replace', path: '/modules/core.wms/settings/expiryCriticalDays', value: '2' },
      { op: 'replace', path: '/modules/core.wms/settings/expiryWarningDays', value: 10 },
    ]);
    expect(await boardLevels(app)).toEqual({
      'B-7': 'critical',
      'B-8': 'warning',
      'B-31': 'safe',
    });

    // 次序不合法（critical=20 > warning=10）→ 联动回落，不出交叉边界
    setWmsSettings([
      { op: 'replace', path: '/modules/core.wms/settings/expiryCriticalDays', value: 20 },
      { op: 'replace', path: '/modules/core.wms/settings/expiryWarningDays', value: 10 },
    ]);
    expect(await boardLevels(app)).toEqual({
      'B-7': 'critical',
      'B-8': 'warning',
      'B-31': 'safe',
    });
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

describe('盘点端点（M17：清单进度 / 明细联查 / 录实盘 / 关单差异）', () => {
  /** 灌基础数据：两个 SKU + 一个实体库位 + 三桶库存 */
  async function seed(app: ReturnType<typeof createApp>) {
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母' });
    await ctx!.ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' }, 'user:test');
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10, reason: '期初' });
    await post(app, '/api/inventory/adjust', { skuCode: 'B-2', delta: 6, reason: '期初', locationCode: 'A-01' });
    await post(app, '/api/inventory/adjust', { skuCode: 'B-2', delta: 4, reason: '期初' });
  }

  it('创建（全场）→ 清单携带范围/进度；GET /api/locations 供范围勾选', async () => {
    const app = setup();
    await seed(app);

    const locRes = await app.request('/api/locations');
    const locs = (await locRes.json()) as Array<{ locationCode: string; name: string }>;
    expect(locs).toEqual([{
      id: expect.any(String),
      locationCode: 'A-01',
      name: '一号架',
      warehouseId: null,
      warehouseCode: null,
      warehouseName: null,
      zoneId: null,
      zoneCode: null,
      zoneName: null,
      zoneKind: null,
      zoneKindLabel: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    }]);

    const res = await post(app, '/api/stocktakes', { note: '月度大盘' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { stocktakeNo: string; state: string; lineCount: number };
    expect(created.stocktakeNo).toMatch(/^ST-/);
    expect(created.state).toBe('created');
    expect(created.lineCount).toBe(3); // 三个有余量的桶

    const listRes = await app.request('/api/stocktakes');
    const list = (await listRes.json()) as Array<{
      stocktakeNo: string;
      state: string;
      scope: string[] | '全场';
      lineCount: number;
      countedCount: number;
      note: string | null;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      state: 'created',
      scope: '全场',
      lineCount: 3,
      countedCount: 0,
      note: '月度大盘',
    });
  });

  it('明细：联查 SKU/库位 + 账面快照 + 差异；范围外录实盘 → 400 WMS_STOCKTAKE_SCOPE_VIOLATION', async () => {
    const app = setup();
    await seed(app);
    await post(app, '/api/stocktakes', { stocktakeNo: 'ST-SCOPED', locationCodes: ['A-01'] });

    const detailRes = await app.request('/api/stocktakes/ST-SCOPED');
    const detail = (await detailRes.json()) as {
      scope: string[];
      lines: Array<{ skuCode: string; name: string; locationCode: string; batchNo: string; expectedQty: number; countedQty: number | null; bookQty: number; delta: number | null }>;
    };
    expect(detail.scope).toEqual(['A-01']);
    expect(detail.lines).toEqual([
      { skuCode: 'B-2', name: '螺母', locationCode: 'A-01', batchNo: 'DEFAULT', unit: null, expectedQty: 6, countedQty: null, bookQty: 6, delta: null },
    ]);

    // 范围外库位（B-2@DEFAULT 桶不在 A-01 范围）→ 拒
    const bad = await post(app, '/api/stocktakes/ST-SCOPED/count', {
      skuCode: 'B-2',
      locationCode: 'DEFAULT',
      countedQty: 4,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('WMS_STOCKTAKE_SCOPE_VIOLATION');
  });

  it('录实盘 → 未盘完关单 400 WMS_STOCKTAKE_LINES_UNCOUNTED；盘完关单 → 差异调整库存', async () => {
    const app = setup();
    await seed(app);
    await post(app, '/api/stocktakes', { stocktakeNo: 'ST-1' });

    // 未盘完 → 拒关
    const early = await post(app, '/api/stocktakes/ST-1/close', {});
    expect(early.status).toBe(400);
    expect(((await early.json()) as { code: string }).code).toBe('WMS_STOCKTAKE_LINES_UNCOUNTED');

    // 逐桶录实盘：A-1 亏 3；B-2@A-01 平；B-2@DEFAULT 盘盈 1
    await post(app, '/api/stocktakes/ST-1/count', { skuCode: 'A-1', countedQty: 7 });
    await post(app, '/api/stocktakes/ST-1/count', { skuCode: 'B-2', locationCode: 'A-01', countedQty: 6 });
    await post(app, '/api/stocktakes/ST-1/count', { skuCode: 'B-2', countedQty: 5 });

    const close = await post(app, '/api/stocktakes/ST-1/close', {});
    expect(close.status).toBe(200);
    const result = (await close.json()) as {
      state: string;
      totalLines: number;
      adjustedLines: number;
      adjustments: Array<{ skuCode: string; locationCode: string; delta: number }>;
    };
    expect(result.state).toBe('closed');
    expect(result.adjustedLines).toBe(2);
    expect(result.adjustments).toEqual([
      { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', expectedQty: 10, countedQty: 7, bookQty: 10, delta: -3 },
      { skuCode: 'B-2', locationCode: 'DEFAULT', batchNo: 'DEFAULT', expectedQty: 4, countedQty: 5, bookQty: 4, delta: 1 },
    ]);

    // 库存收敛 = 实盘数（清单页即时可见；M19 冻结三件套 + M20 reorderPoint，均无值）
    const inv = (await (await app.request('/api/inventory')).json()) as Array<{ skuCode: string; quantity: number }>;
    expect(inv).toEqual([
      {
        skuId: expect.any(String),
        skuCode: 'A-1',
        name: '螺丝',
        quantity: 7,
        held: 0,
        reserved: 0,
        available: 7,
        reorderPoint: 0,
        unit: null,
      },
      {
        skuId: expect.any(String),
        skuCode: 'B-2',
        name: '螺母',
        quantity: 11,
        held: 0,
        reserved: 0,
        available: 11,
        reorderPoint: 0,
        unit: null,
      }, // 6 + 5
    ]);
  });

  it('取消 → 状态 canceled、库存零调整；终态单再操作 → 400 WMS_STOCKTAKE_NOT_OPEN', async () => {
    const app = setup();
    await seed(app);
    await post(app, '/api/stocktakes', { stocktakeNo: 'ST-1' });
    await post(app, '/api/stocktakes/ST-1/count', { skuCode: 'A-1', countedQty: 99 }); // 故意盘歪

    const cancel = await post(app, '/api/stocktakes/ST-1/cancel', {});
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { state: string }).state).toBe('canceled');

    // 取消不动账面（99 是干扰值——若误调整，库存会变成 99）
    const inv = (await (await app.request('/api/inventory')).json()) as Array<{ skuCode: string; quantity: number }>;
    expect(inv.find((r) => r.skuCode === 'A-1')!.quantity).toBe(10);

    const reClose = await post(app, '/api/stocktakes/ST-1/close', {});
    expect(reClose.status).toBe(400);
    expect(((await reClose.json()) as { code: string }).code).toBe('WMS_STOCKTAKE_NOT_OPEN');
  });

  it('明细查不存在的单 → 400 WMS_STOCKTAKE_NOT_FOUND', async () => {
    const app = setup();
    const res = await app.request('/api/stocktakes/ST-404');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('WMS_STOCKTAKE_NOT_FOUND');
  });
});

// ── 冻结（M19：GET /api/inventory 三件套 + holds 端点）──────────

describe('冻结端点（M19）', () => {
  it('POST /api/holds 冻结 → GET /api/inventory 带 held/available；GET /api/holds 按 skuCode 过滤', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10, reason: '期初' });

    const hold = await post(app, '/api/holds', { skuCode: 'A-1', quantity: 4, reason: '质检隔离' });
    expect(hold.status).toBe(201);
    const created = (await hold.json()) as { holdId: string; held: number; available: number };
    expect(created.holdId).toBeTruthy();
    expect(created.held).toBe(4);
    expect(created.available).toBe(6);

    // 库存清单三件套（+ M20 reorderPoint，该测试未设安全库存 → 0）
    const inv = (await (await app.request('/api/inventory')).json()) as Array<{
      skuCode: string;
      quantity: number;
      held: number;
      available: number;
    }>;
    expect(inv).toEqual([
      {
        skuId: expect.any(String),
        skuCode: 'A-1',
        name: '螺丝',
        quantity: 10,
        held: 4,
        reserved: 0,
        available: 6,
        reorderPoint: 0,
        unit: null,
      },
    ]);

    // 活动冻结清单（过滤 + 形状）
    const holds = (await (await app.request('/api/holds?skuCode=A-1')).json()) as Array<{
      id: string;
      skuCode: string;
      quantity: number;
      reason: string;
    }>;
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ skuCode: 'A-1', quantity: 4, reason: '质检隔离' });

    // 未知编码 → 空清单（过滤器不报错）
    const none = (await (await app.request('/api/holds?skuCode=X-9')).json()) as unknown[];
    expect(none).toHaveLength(0);
  });

  it('POST /api/holds/:id/release 释放 → held 归零；重复释放 → 400 WMS_HOLD_NOT_FOUND', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10 });
    const { holdId } = (await (await post(app, '/api/holds', { skuCode: 'A-1', quantity: 5 })).json()) as {
      holdId: string;
    };

    const rel = await post(app, `/api/holds/${holdId}/release`, {});
    expect(rel.status).toBe(200);
    expect(((await rel.json()) as { held: number; available: number })).toMatchObject({
      held: 0,
      available: 10,
    });

    const again = await post(app, `/api/holds/${holdId}/release`, {});
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe('WMS_HOLD_NOT_FOUND');
  });

  it('冻结超量 → 400 WMS_HOLD_EXCEEDS_STOCK；出库单撞冻结 → 400 WMS_STOCK_HELD', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10 });

    const over = await post(app, '/api/holds', { skuCode: 'A-1', quantity: 11 });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { code: string }).code).toBe('WMS_HOLD_EXCEEDS_STOCK');

    // 冻结 6 → 可用 4；出库 5 在建单就被拦
    await post(app, '/api/holds', { skuCode: 'A-1', quantity: 6 });
    const order = await post(app, '/api/orders', {
      direction: 'out',
      lines: [{ skuCode: 'A-1', quantity: 5 }],
    });
    expect(order.status).toBe(400);
    expect(((await order.json()) as { code: string }).code).toBe('WMS_STOCK_HELD');
  });
});

// ── 安全库存（M20：SKU 主数据带 reorderPoint，/api/inventory 附带）──────────

describe('安全库存端点（M20）', () => {
  it('建 SKU 带 reorderPoint → /api/skus 透传；/api/inventory 行携带 reorderPoint', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝', reorderPoint: 20 });
    await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10 });
    await post(app, '/api/inventory/adjust', { skuCode: 'B-2', delta: 5 });

    const skus = (await (await app.request('/api/skus')).json()) as Array<{
      skuCode: string;
      reorderPoint: number;
    }>;
    expect(skus.find((s) => s.skuCode === 'A-1')!.reorderPoint).toBe(20);
    expect(skus.find((s) => s.skuCode === 'B-2')!.reorderPoint).toBe(0);

    const inv = (await (await app.request('/api/inventory')).json()) as Array<{
      skuCode: string;
      reorderPoint: number;
      available: number;
    }>;
    // A-1：可用 10 < 阈值 20（前端据此标红/过滤）
    expect(inv.find((r) => r.skuCode === 'A-1')!).toMatchObject({
      reorderPoint: 20,
      available: 10,
    });
    expect(inv.find((r) => r.skuCode === 'B-2')!.reorderPoint).toBe(0);
  });
});

describe('列表 SQL 分页', () => {
  it('不传 limit 仍是数组；传 limit 返回分页壳；非法 limit 400', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/skus', { skuCode: 'B-2', name: '螺母' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 3, reason: '期初' });
    await post(app, '/api/orders', { direction: 'in', lines: [{ skuCode: 'A-1', quantity: 1 }] });

    const all = (await (await app.request('/api/skus')).json()) as unknown[];
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(2);

    const page = (await (await app.request('/api/skus?limit=1&offset=1')).json()) as {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      rows: { skuCode: string }[];
    };
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1, hasMore: false });
    expect(page.rows).toHaveLength(1);

    const bad = await app.request('/api/skus?limit=0');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('BAD_QUERY');

    const inv = (await (await app.request('/api/inventory?limit=10')).json()) as {
      total: number;
      rows: { skuCode: string; quantity: number; reserved: number }[];
      hasReserved: boolean;
    };
    expect(inv.total).toBe(1);
    expect(inv.hasReserved).toBe(false);
    expect(inv.rows[0]).toMatchObject({ skuCode: 'A-1', quantity: 3, reserved: 0 });

    const orders = (await (await app.request('/api/orders?limit=10')).json()) as {
      total: number;
      rows: { lines: unknown[] }[];
    };
    expect(orders.total).toBe(1);
    expect(orders.rows[0]!.lines).toHaveLength(1);

    const barcode = (await (await app.request('/api/skus?barcode=nope')).json()) as unknown[];
    expect(Array.isArray(barcode)).toBe(true);
  });
});

describe('退货端点（module.return）', () => {
  it('未发货不能退；发货后可退数量可查，returnOf 开出客退单', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 10 });
    const created = (await (
      await post(app, '/api/orders', {
        direction: 'out',
        orderNo: 'OUT-1',
        lines: [{ skuCode: 'A-1', quantity: 10 }],
      })
    ).json()) as { orderNo: string };
    expect(created.orderNo).toBe('OUT-1');

    const early = await app.request('/api/orders/OUT-1/returnable');
    expect(early.status).toBe(400);
    expect(((await early.json()) as { code: string }).code).toBe('WMS_RETURN_NOT_POSTED');

    const rejected = await post(app, '/api/orders', {
      direction: 'in',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe('WMS_RETURN_NOT_POSTED');

    const plain = await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    expect(plain.status).toBe(201);

    await post(app, '/api/orders/OUT-1/transition', { to: 'picking' });
    const proposed = ctx!.ws.profile.propose(
      'user:tester',
      [{ op: 'replace', path: '/modules/module.picking/enabled', value: false }],
      '测试直接发货',
    );
    ctx!.ws.profile.confirm(proposed.proposalId, 'user:tester');
    const shipped = await post(app, '/api/orders/OUT-1/transition', { to: 'shipped' });
    expect(shipped.status).toBe(200);

    const view = (await (await app.request('/api/orders/OUT-1/returnable')).json()) as {
      sourceOrderNo: string;
      direction: string;
      lines: { skuCode: string; remaining: number; postedQty: number }[];
    };
    expect(view).toMatchObject({ sourceOrderNo: 'OUT-1', direction: 'in' });
    expect(view.lines[0]).toMatchObject({ skuCode: 'A-1', postedQty: 10, remaining: 10 });

    const ret = await post(app, '/api/orders', {
      direction: 'in',
      orderNo: 'RT-1',
      returnOf: 'OUT-1',
      lines: [{ skuCode: 'A-1', quantity: 4 }],
    });
    expect(ret.status).toBe(201);

    const orders = (await (await app.request('/api/orders')).json()) as {
      orderNo: string;
      returnOfOrderNo: string | null;
    }[];
    expect(orders.find((o) => o.orderNo === 'RT-1')!.returnOfOrderNo).toBe('OUT-1');
    expect(orders.find((o) => o.orderNo === 'OUT-1')!.returnOfOrderNo).toBeNull();
  });
});

describe('到货预报端点（module.asn）', () => {
  it('预报单停在 announced 且不加库存；收货后加库存；不带 asn 仍是 created', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    const asn = await post(app, '/api/orders', {
      direction: 'in',
      orderNo: 'ASN-1',
      asn: true,
      expectedAt: '2026-11-20',
      lines: [{ skuCode: 'A-1', quantity: 6 }],
    });
    expect(asn.status).toBe(201);
    expect(((await asn.json()) as { state: string }).state).toBe('announced');

    const before = (await (await app.request('/api/inventory')).json()) as unknown[];
    expect(before).toHaveLength(0);

    const orders = (await (await app.request('/api/orders')).json()) as {
      orderNo: string;
      state: string;
      expectedAt: string | null;
    }[];
    expect(orders.find((o) => o.orderNo === 'ASN-1')).toMatchObject({
      state: 'announced',
      expectedAt: '2026-11-20',
    });

    const received = await post(app, '/api/orders/ASN-1/transition', { to: 'received' });
    expect(received.status).toBe(200);
    const inv = (await (await app.request('/api/inventory')).json()) as { skuCode: string; quantity: number }[];
    expect(inv.find((row) => row.skuCode === 'A-1')!.quantity).toBe(6);

    const direct = await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    expect(((await direct.json()) as { state: string }).state).toBe('created');

    const rejected = await post(app, '/api/orders', {
      direction: 'out',
      asn: true,
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe('WMS_ASN_DIRECTION');
  });
});

describe('补货端点（module.replenish）', () => {
  it('按缺口开入库单；再建议不再包含该 SKU；再开是空的', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝', reorderPoint: 10 });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 4 });
    const created = await post(app, '/api/replenishment', {});
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      state: string;
      orderNo: string;
      lines: { skuCode: string; quantity: number }[];
    };
    expect(body.state).toBe('created');
    expect(body.lines).toEqual([{ skuCode: 'A-1', quantity: 6 }]);

    const orders = (await (await app.request('/api/orders')).json()) as {
      orderNo: string;
      state: string;
      replenishment: boolean;
    }[];
    expect(orders.find((order) => order.orderNo === body.orderNo)).toMatchObject({
      state: 'created',
      replenishment: true,
    });

    const suggestions = (await (await app.request('/api/replenishment')).json()) as { skuCode: string }[];
    expect(suggestions.find((row) => row.skuCode === 'A-1')).toBeUndefined();

    const again = await post(app, '/api/replenishment', {});
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe('WMS_REPLENISH_EMPTY');
  });
});

describe('多仓端点（module.warehouse）', () => {
  it('建仓库、把库位划进去、按仓库看库存', async () => {
    const app = setup();
    const created = await post(app, '/api/warehouses', { warehouseCode: 'WH-1', name: '一号仓' });
    expect(created.status).toBe(201);

    const loc = await post(app, '/api/locations', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
    expect(loc.status).toBe(201);

    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 4, reason: '期初', locationCode: 'A-01' });

    const locs = (await (await app.request('/api/locations')).json()) as {
      locationCode: string;
      warehouseId: string | null;
      warehouseCode: string | null;
      warehouseName: string | null;
    }[];
    expect(locs).toEqual([
      expect.objectContaining({
        locationCode: 'A-01',
        warehouseCode: 'WH-1',
        warehouseName: '一号仓',
      }),
    ]);
    expect(locs[0]!.warehouseId).toEqual(expect.any(String));

    const stockRes = await app.request('/api/warehouses/WH-1/stock');
    expect(stockRes.status).toBe(200);
    const stock = (await stockRes.json()) as {
      warehouseCode: string;
      rows: { skuCode: string; locationCode: string; quantity: number }[];
    };
    expect(stock.warehouseCode).toBe('WH-1');
    expect(stock.rows).toEqual([
      expect.objectContaining({ skuCode: 'A-1', locationCode: 'A-01', quantity: 4 }),
    ]);

    const slices = await app.request('/api/inventory/slices?view=warehouse&warehouseCode=WH-1&limit=50');
    expect(slices.status).toBe(200);
    const sliceBody = (await slices.json()) as {
      view: string;
      rows: { warehouseCode: string; skuCode: string; quantity: number; details: { locationCode: string; quantity: number }[] }[];
    };
    expect(sliceBody.view).toBe('warehouse');
    expect(sliceBody.rows).toEqual([
      expect.objectContaining({
        warehouseCode: 'WH-1',
        skuCode: 'A-1',
        quantity: 4,
        details: [expect.objectContaining({ locationCode: 'A-01', quantity: 4 })],
      }),
    ]);

    const missing = await app.request('/api/warehouses/NOPE/stock');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('WMS_WAREHOUSE_NOT_FOUND');
  });

  it('库位清单按仓库或未分仓筛选，未知仓库不是空清单', async () => {
    const app = setup();
    await post(app, '/api/warehouses', { warehouseCode: 'WH-1', name: '一号仓' });
    await post(app, '/api/locations', { locationCode: 'A-01', name: '一号架', warehouseCode: 'WH-1' });
    await post(app, '/api/locations', { locationCode: 'Z-01', name: '散货' });

    const inWh = await app.request('/api/locations?warehouseCode=WH-1&limit=50');
    expect(inWh.status).toBe(200);
    const inWhBody = (await inWh.json()) as { total: number; rows: { locationCode: string }[] };
    expect(inWhBody.total).toBe(1);
    expect(inWhBody.rows.map((row) => row.locationCode)).toEqual(['A-01']);

    const loose = await app.request('/api/locations?unassigned=1');
    expect(loose.status).toBe(200);
    const looseBody = (await loose.json()) as { locationCode: string }[];
    expect(looseBody.map((row) => row.locationCode)).toEqual(['Z-01']);

    const all = (await (await app.request('/api/locations')).json()) as { locationCode: string }[];
    expect(all.map((row) => row.locationCode)).toEqual(['A-01', 'Z-01']);

    const missing = await app.request('/api/locations?warehouseCode=NOPE&limit=50');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('BAD_QUERY');

    const both = await app.request('/api/locations?warehouseCode=WH-1&unassigned=1&limit=50');
    expect(both.status).toBe(400);
    expect(((await both.json()) as { code: string }).code).toBe('BAD_QUERY');
  });
});

describe('库区端点（module.zone）', () => {
  it('建库区、把库位划进去，并按库区或未分区筛选', async () => {
    const app = setup();
    await post(app, '/api/warehouses', { warehouseCode: 'WH-1', name: '一号仓' });
    const created = await post(app, '/api/zones', {
      zoneCode: 'PK-1',
      name: '一层拣货',
      kind: 'picking',
      warehouseCode: 'WH-1',
    });
    expect(created.status).toBe(201);

    const loc = await post(app, '/api/locations', { locationCode: 'A-01', name: '一号架', zoneCode: 'PK-1' });
    expect(loc.status).toBe(201);
    await post(app, '/api/locations', { locationCode: 'Z-01', name: '散货', warehouseCode: 'WH-1' });

    const zones = (await (await app.request('/api/zones')).json()) as {
      zoneCode: string;
      kindLabel: string;
      locationCount: number;
    }[];
    expect(zones).toEqual([
      expect.objectContaining({ zoneCode: 'PK-1', kindLabel: '拣货区', warehouseCode: 'WH-1', locationCount: 1 }),
    ]);

    const inZone = await app.request('/api/locations?zoneCode=PK-1&limit=50');
    expect(inZone.status).toBe(200);
    const inZoneBody = (await inZone.json()) as { total: number; rows: { locationCode: string; zoneKind: string }[] };
    expect(inZoneBody.total).toBe(1);
    expect(inZoneBody.rows[0]).toMatchObject({ locationCode: 'A-01', zoneKind: 'picking', zoneKindLabel: '拣货区' });

    const loose = await app.request('/api/locations?warehouseCode=WH-1&unzoned=1');
    expect(loose.status).toBe(200);
    const looseBody = (await loose.json()) as { locationCode: string }[];
    expect(looseBody.map((row) => row.locationCode)).toEqual(['Z-01']);

    const missing = await app.request('/api/locations?zoneCode=NOPE&limit=50');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('BAD_QUERY');
  });
});

describe('序列号端点（module.serial）', () => {
  it('按序列号调整后可以查到在库号', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝', serialTracked: true });
    const adjusted = await post(app, '/api/inventory/adjust', {
      skuCode: 'A-1',
      delta: 1,
      reason: '期初',
      serials: ['S-1'],
    });
    expect(adjusted.status).toBe(200);

    const list = (await (await app.request('/api/serials?skuCode=A-1')).json()) as { serialNo: string; status: string }[];
    expect(list).toEqual([expect.objectContaining({ serialNo: 'S-1', skuCode: 'A-1', status: 'in' })]);
    const one = await app.request('/api/serials/S-1');
    expect(one.status).toBe(200);
    expect(((await one.json()) as { serialNo: string }).serialNo).toBe('S-1');
  });
});

describe('托盘端点（module.lpn）', () => {
  it('建托盘、装上、按托盘看库存、整托移库', async () => {
    const app = setup();
    await post(app, '/api/skus', { skuCode: 'A-1', name: '螺丝' });
    await post(app, '/api/locations', { locationCode: 'A-01', name: '一号架' });
    await post(app, '/api/locations', { locationCode: 'B-02', name: '二号架' });
    await post(app, '/api/inventory/adjust', { skuCode: 'A-1', delta: 4, reason: '期初', locationCode: 'A-01' });

    const created = await post(app, '/api/lpns', { lpnCode: 'P-1', locationCode: 'A-01' });
    expect(created.status).toBe(201);
    const packed = await post(app, '/api/lpns/P-1/pack', { skuCode: 'A-1', quantity: 2 });
    expect(packed.status).toBe(200);

    const stock = (await (await app.request('/api/lpns/P-1/stock')).json()) as {
      locationCode: string;
      lines: { skuCode: string; quantity: number }[];
    };
    expect(stock.locationCode).toBe('A-01');
    expect(stock.lines).toEqual([expect.objectContaining({ skuCode: 'A-1', quantity: 2 })]);

    const moved = await post(app, '/api/lpns/P-1/move', { toLocationCode: 'B-02' });
    expect(moved.status).toBe(200);
    const after = (await (await app.request('/api/lpns/P-1/stock')).json()) as { locationCode: string };
    expect(after.locationCode).toBe('B-02');
  });
});

describe('编号', () => {
  it('GET /api/numbering 给出下一号，未知位置 400', async () => {
    const app = setup();
    const res = await app.request('/api/numbering?place=order.in');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      patchOp: string;
      places: { next: string }[];
    };
    expect(body.patchOp).toBe('replace');
    expect(body.places).toHaveLength(1);
    expect(body.places[0]?.next).toMatch(/^IN-\d{8}-0001$/);
    const bad = await app.request('/api/numbering?place=nope');
    expect(bad.status).toBe(400);
  });

  it('不传单号和商品编码时按规则生成', async () => {
    const app = setup();
    const sku = await post(app, '/api/skus', { name: '轴承' });
    expect(sku.status).toBe(201);
    const skuBody = (await sku.json()) as { skuCode: string };
    expect(skuBody.skuCode).toMatch(/^SKU-\d{5}$/);
    const order = await post(app, '/api/orders', {
      direction: 'in',
      lines: [{ skuCode: skuBody.skuCode, quantity: 1 }],
    });
    expect(order.status).toBe(201);
    const orderBody = (await order.json()) as { orderNo: string };
    expect(orderBody.orderNo).toMatch(/^IN-\d{8}-0001$/);
  });
});
