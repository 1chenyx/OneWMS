import { describe, it, expect, afterEach } from 'vitest';
import type { ModuleManifest } from '@one/core';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * B.3 声明式实体记录端点直测。核心契约是**白名单纪律**：
 *  - module/type/字段没在「生效 manifest ∩ 已安装」里声明 → 404，不兜底、不返回空列表；
 *  - 分页/排序/过滤只作用于 queryable 列，查询串按列类型转值；
 *  - 写路径乐观并发（409）、列校验（422）、参数不合法（400）三档分得清。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

const MODULE = 'vendor.extra';
const TYPE = 'qualification';
const BASE = `/api/dyn/${MODULE}/${TYPE}`;

/** 声明式模块：cert_level 刻意不标 queryable，用来验「已声明但不可查」也走 404 */
function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: MODULE,
    name: '供应商扩展档案',
    description: '纯 JSON 声明，无本地代码',
    version: '1.0.0',
    capabilities: ['db.read'],
    records: [
      {
        id: `dyn.${MODULE}.${TYPE}`,
        label: '供应商资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string', queryable: true },
          { key: 'score', label: '评分', type: 'number', queryable: true },
          { key: 'cert_level', label: '资质等级', type: 'string' },
        ],
      },
    ],
    ...overrides,
  };
}

function setup(opts: { install?: boolean } = {}): ReturnType<typeof createApp> {
  ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-dyn-routes-test' });
  if (opts.install !== false) ctx.ws.modules.install(manifest());
  return createApp(ctx);
}

const json = { 'content-type': 'application/json' };
const send = (app: ReturnType<typeof createApp>, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: json,
  });

async function create(app: ReturnType<typeof createApp>, id: string, data: unknown): Promise<number> {
  const res = await send(app, 'POST', BASE, { recordId: id, data });
  expect(res.status).toBe(201);
  return ((await res.json()) as { version: number }).version;
}

interface ListEnvelope {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  rows: Array<{ recordId: string; data: Record<string, unknown>; version: number }>;
}

describe('dyn 端点白名单', () => {
  it('模块未安装：四种方法一律 404（不返回空列表、不建表兜底）', async () => {
    const app = setup({ install: false });
    expect((await send(app, 'GET', BASE)).status).toBe(404);
    expect((await send(app, 'GET', `${BASE}/Q1`)).status).toBe(404);
    expect((await send(app, 'POST', BASE, { data: {} })).status).toBe(404);
    expect((await send(app, 'DELETE', `${BASE}/Q1?version=1`)).status).toBe(404);
    const body = (await (await send(app, 'GET', BASE)).json()) as { code: string };
    expect(body.code).toBe('DYN_RECORD_NOT_FOUND');
  });

  it('未声明的 module / type → 404', async () => {
    const app = setup();
    expect((await send(app, 'GET', `/api/dyn/nope/${TYPE}`)).status).toBe(404);
    expect((await send(app, 'GET', `/api/dyn/${MODULE}/nope`)).status).toBe(404);
    // 命名空间不可冒用：type 里塞点号绕到别的模块实体
    expect((await send(app, 'GET', `/api/dyn/${MODULE}/x.y`)).status).toBe(404);
  });

  it('卸载后 404，数据仍在库里；重装即恢复', async () => {
    const app = setup();
    await create(app, 'Q1', { vendor_code: 'V-001', score: 90 });
    ctx!.ws.modules.uninstall(MODULE, { actor: 'user:tester' });
    expect((await send(app, 'GET', `${BASE}/Q1`)).status).toBe(404);
    ctx!.ws.modules.install(manifest());
    const res = await send(app, 'GET', `${BASE}/Q1`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toEqual({
      vendor_code: 'V-001',
      score: 90,
    });
  });
});

describe('dyn 端点读写', () => {
  it('POST 建 → GET 单条：data 保真、version=1', async () => {
    const app = setup();
    const version = await create(app, 'Q1', { vendor_code: 'V-001', score: 90 });
    expect(version).toBe(1);
    const res = await send(app, 'GET', `${BASE}/Q1`);
    expect(res.status).toBe(200);
    const record = (await res.json()) as { recordId: string; data: Record<string, unknown>; version: number };
    expect(record.recordId).toBe('Q1');
    expect(record.data).toEqual({ vendor_code: 'V-001', score: 90 });
    expect(record.version).toBe(1);
  });

  it('recordId 缺省自动生成；不存在的记录 GET → 404', async () => {
    const app = setup();
    const res = await send(app, 'POST', BASE, { data: { vendor_code: 'V-002' } });
    expect(res.status).toBe(201);
    const { recordId } = (await res.json()) as { recordId: string };
    expect(recordId).toMatch(/^r-[0-9a-f]{12}$/);
    expect((await send(app, 'GET', `${BASE}/missing`)).status).toBe(404);
  });

  it('PATCH 整替 + 乐观并发：版本对 → 200 且 version+1，版本错 → 409', async () => {
    const app = setup();
    await create(app, 'Q1', { vendor_code: 'V-001', score: 90 });
    const ok = await send(app, 'PATCH', `${BASE}/Q1`, {
      data: { vendor_code: 'V-001', score: 95 },
      expectedVersion: 1,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { version: number }).version).toBe(2);

    const stale = await send(app, 'PATCH', `${BASE}/Q1`, {
      data: { vendor_code: 'V-001' },
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('DYN_RECORD_CONFLICT');
  });

  it('PATCH 缺 expectedVersion → 400；数据校验不过 → 422', async () => {
    const app = setup();
    await create(app, 'Q1', { vendor_code: 'V-001' });
    expect((await send(app, 'PATCH', `${BASE}/Q1`, { data: {} })).status).toBe(400);
    const bad = await send(app, 'PATCH', `${BASE}/Q1`, {
      data: { vendor_code: 123 },
      expectedVersion: 1,
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe('DYN_RECORD_VALIDATION');
  });

  it('DELETE 带 ?version → 200，之后 GET 404；缺 version 400；版本错 409', async () => {
    const app = setup();
    await create(app, 'Q1', { vendor_code: 'V-001' });
    await create(app, 'Q2', { vendor_code: 'V-002' });
    expect((await send(app, 'DELETE', `${BASE}/Q1`)).status).toBe(400);
    expect((await send(app, 'DELETE', `${BASE}/Q1?version=9`)).status).toBe(409);
    const ok = await send(app, 'DELETE', `${BASE}/Q1?version=1`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { deleted: boolean }).deleted).toBe(true);
    expect((await send(app, 'GET', `${BASE}/Q1`)).status).toBe(404);
  });

  it('写路径记 actor 审计（resolveActor 单点，不是节点 id 兜底）', async () => {
    const app = setup();
    await create(app, 'Q1', { vendor_code: 'V-001' });
    const actors: string[] = [];
    ctx!.ws.events.forEach((e) => {
      if (e.type === 'record.created') actors.push(e.actor);
    });
    expect(actors).toHaveLength(1);
    // 不是节点 id 兜底（node-xxxxxxxx），而是 actor 单点解析出的用户通道
    expect(actors[0]).toMatch(/^user:local@/);
  });
});

describe('dyn 端点列表：分页 / 过滤 / 排序', () => {
  async function seed(app: ReturnType<typeof createApp>): Promise<void> {
    await create(app, 'R1', { vendor_code: 'V-001', score: 100 });
    await create(app, 'R2', { vendor_code: 'V-002', score: 9 });
    await create(app, 'R3', { vendor_code: 'V-001', score: 50 });
    await create(app, 'R4', { vendor_code: 'V-003' });
  }

  it('分页信封：total/limit/offset/hasMore 与 rows 一致', async () => {
    const app = setup();
    await seed(app);
    const res = await send(app, 'GET', `${BASE}?limit=2&offset=0`);
    const page = (await res.json()) as ListEnvelope;
    expect(page.total).toBe(4);
    expect(page.limit).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.rows.map((r) => r.recordId)).toEqual(['R1', 'R2']);
    const last = (await (await send(app, 'GET', `${BASE}?limit=2&offset=2`)).json()) as ListEnvelope;
    expect(last.hasMore).toBe(false);
  });

  it('过滤：queryable 字段生效，查询串按列类型转值（number/字符串）', async () => {
    const app = setup();
    await seed(app);
    const byCode = (await (
      await send(app, 'GET', `${BASE}?filter=vendor_code&equals=V-001`)
    ).json()) as ListEnvelope;
    expect(byCode.rows.map((r) => r.recordId)).toEqual(['R1', 'R3']);
    // ⚠️ 不转类型就永远匹配不上：索引里存的是 "9"，而 ?equals=9 是字符串
    const byScore = (await (await send(app, 'GET', `${BASE}?filter=score&equals=9`)).json()) as ListEnvelope;
    expect(byScore.rows.map((r) => r.recordId)).toEqual(['R2']);
  });

  it('过滤字段不在白名单（未声明 / 未标 queryable）→ 404', async () => {
    const app = setup();
    await seed(app);
    expect((await send(app, 'GET', `${BASE}?filter=cert_level&equals=A`)).status).toBe(404);
    expect((await send(app, 'GET', `${BASE}?filter=nope&equals=A`)).status).toBe(404);
    // 参数不成对 → 400（这是用法错，不是白名单错）
    expect((await send(app, 'GET', `${BASE}?filter=vendor_code`)).status).toBe(400);
    expect((await send(app, 'GET', `${BASE}?equals=V-001`)).status).toBe(400);
    // 类型对不上 → 400
    expect((await send(app, 'GET', `${BASE}?filter=score&equals=abc`)).status).toBe(400);
  });

  it('排序：number 列按数值排（TEXT 字典序会把 "100" 排在 "9" 前）', async () => {
    const app = setup();
    await seed(app);
    const asc = (await (await send(app, 'GET', `${BASE}?sort=score`)).json()) as ListEnvelope;
    expect(asc.rows.map((r) => r.recordId)).toEqual(['R2', 'R3', 'R1', 'R4']);
    const desc = (await (await send(app, 'GET', `${BASE}?sort=score&dir=desc`)).json()) as ListEnvelope;
    expect(desc.rows.map((r) => r.recordId)).toEqual(['R1', 'R3', 'R2', 'R4']);
  });

  it('排序字段同样受白名单约束 → 404；dir 非法 → 400', async () => {
    const app = setup();
    await seed(app);
    expect((await send(app, 'GET', `${BASE}?sort=cert_level`)).status).toBe(404);
    expect((await send(app, 'GET', `${BASE}?sort=nope`)).status).toBe(404);
    expect((await send(app, 'GET', `${BASE}?sort=score&dir=up`)).status).toBe(400);
    // dir 要拼进 SQL，只接受白名单两个字面量（不接受自由文本）
    expect((await send(app, 'GET', `${BASE}?sort=score&dir=asc;DROP`)).status).toBe(400);
  });

  it('过滤 + 排序 + 分页组合：翻页不重不漏', async () => {
    const app = setup();
    await seed(app);
    const url = `${BASE}?filter=vendor_code&equals=V-001&sort=score&dir=desc&limit=1`;
    const p1 = (await (await send(app, 'GET', `${url}&offset=0`)).json()) as ListEnvelope;
    const p2 = (await (await send(app, 'GET', `${url}&offset=1`)).json()) as ListEnvelope;
    expect(p1.total).toBe(2);
    expect(p1.rows.map((r) => r.recordId)).toEqual(['R1']);
    expect(p2.rows.map((r) => r.recordId)).toEqual(['R3']);
    expect(p2.hasMore).toBe(false);
  });

  it('分页参数不合法 → 400（不静默回落默认值）', async () => {
    const app = setup();
    expect((await send(app, 'GET', `${BASE}?limit=0`)).status).toBe(400);
    expect((await send(app, 'GET', `${BASE}?limit=abc`)).status).toBe(400);
    expect((await send(app, 'GET', `${BASE}?offset=-1`)).status).toBe(400);
    expect((await send(app, 'GET', `${BASE}?limit=9999`)).status).toBe(400);
  });

  it('请求体不是 JSON 对象 → 400', async () => {
    const app = setup();
    const bad = await app.request(BASE, { method: 'POST', body: 'not-json', headers: json });
    expect(bad.status).toBe(400);
    const arr = await app.request(BASE, { method: 'POST', body: '[]', headers: json });
    expect(arr.status).toBe(400);
  });
});
