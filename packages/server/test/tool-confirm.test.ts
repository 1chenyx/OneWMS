import { describe, it, expect, afterEach } from 'vitest';
import type { ModuleManifest } from '@one/core';
import { createApp, createAppContext, ConfirmGate, type AppContext } from '../src/index.js';

/**
 * B.5 写操作二次确认：read 直通 / write 只发令牌不执行 / confirm 才落地。
 *
 * 用 B.4 的声明式实体工具当被测对象——它们正好一个 read（.list）一个 write（.create），
 * 且写路径有唯一约束，能把「幂等键防双写」测出真凭实据：
 * 没有幂等回放的话，同令牌确认第二次必然撞 DYN_RECORD_CONFLICT。
 */

const contexts: AppContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.close();
});

const MODULE = 'vendor.extra';
const TYPE = 'qualification';
const RECORD = `dyn.${MODULE}.${TYPE}`;
const CREATE = `${RECORD}.create`;
const LIST = `${RECORD}.list`;
const UPDATE = `${RECORD}.update`;

function manifest(): ModuleManifest {
  return {
    id: MODULE,
    name: '供应商扩展档案',
    description: '纯 JSON 声明，无本地代码',
    version: '1.0.0',
    capabilities: ['db.read'],
    records: [
      {
        id: RECORD,
        label: '供应商资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string', queryable: true },
          { key: 'score', label: '评分', type: 'number', queryable: true },
        ],
      },
    ],
  };
}

/** @param ttlMs 令牌有效期；测过期时传 0（签发即到期） */
function setup(opts: { ttlMs?: number } = {}): ReturnType<typeof createApp> {
  const ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-tool-confirm',
    ...(opts.ttlMs === undefined ? {} : { confirmTokenTtlMs: opts.ttlMs }),
  });
  contexts.push(ctx);
  ctx.ws.modules.install(manifest());
  return createApp(ctx);
}

const json = { 'content-type': 'application/json' };
function send(app: ReturnType<typeof createApp>, url: string, body?: unknown, method = 'POST') {
  return app.request(url, {
    method,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: json,
  });
}

const invoke = (app: ReturnType<typeof createApp>, toolId: string, params?: unknown) =>
  send(app, `/api/tools/${toolId}/invoke`, params === undefined ? {} : { params });
const confirm = (app: ReturnType<typeof createApp>, toolId: string, token: unknown) =>
  send(app, `/api/tools/${toolId}/confirm`, { token });

interface PendingBody {
  pending: boolean;
  token: string;
  expiresAt: string;
  label: string;
  permission: string;
  params: Record<string, unknown>;
}
interface DoneBody {
  pending: boolean;
  toolId: string;
  label: string;
  result: unknown;
}
interface ErrorBody {
  code: string;
  message: string;
}

/** 库里的记录条数（用 read 工具查，顺带证明 read 直通可用） */
async function recordCount(app: ReturnType<typeof createApp>): Promise<number> {
  const res = await invoke(app, LIST, {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as DoneBody;
  return (body.result as { total: number }).total;
}

describe('B.5 permission 分流', () => {
  it('read 工具直通执行：200 + pending:false + 结果当场返回，不发令牌', async () => {
    const app = setup();
    const res = await invoke(app, LIST, { limit: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DoneBody;
    expect(body.pending).toBe(false);
    expect(body.toolId).toBe(LIST);
    expect(body.label).toBe('查询供应商资质');
    expect((body.result as { total: number }).total).toBe(0);
  });

  it('write 工具只发令牌不执行：202 + pending:true，库里一条没多', async () => {
    const app = setup();
    const res = await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001' } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as PendingBody;
    expect(body.pending).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.permission).toBe('write');
    expect(body.label).toBe('新建供应商资质');
    // 确认框要能自解释：令牌把「即将执行什么」原样带回去
    expect(body.params).toEqual({ recordId: 'Q1', data: { vendor_code: 'V-001' } });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    // ⚠️ B.5 的全部意义就在这一步的「不执行」
    expect(await recordCount(app)).toBe(0);
  });

  it('confirm 带令牌才落地：记录出现，version=1', async () => {
    const app = setup();
    const issued = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001', score: 90 } })
    ).json()) as PendingBody;

    const res = await confirm(app, CREATE, issued.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DoneBody;
    expect(body.pending).toBe(false);
    expect((body.result as { recordId: string; version: number }).version).toBe(1);
    expect(await recordCount(app)).toBe(1);
  });
});

describe('B.5 令牌纪律', () => {
  it('过期令牌 → 409 CONFIRM_TOKEN_INVALID，且不执行', async () => {
    const app = setup({ ttlMs: 0 }); // 签发即到期
    const issued = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001' } })
    ).json()) as PendingBody;
    const res = await confirm(app, CREATE, issued.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe('CONFIRM_TOKEN_INVALID');
    expect(await recordCount(app)).toBe(0);
  });

  it('令牌串工具 → 409：create 的令牌不能拿去执行 update', async () => {
    const app = setup();
    const issued = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001' } })
    ).json()) as PendingBody;
    const res = await confirm(app, UPDATE, issued.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).message).toMatch(/不能用于/);
    expect(await recordCount(app)).toBe(0);
  });

  it('伪造/缺失令牌：不存在的 → 409，空串与非字符串 → 400', async () => {
    const app = setup();
    const bogus = await confirm(app, CREATE, 'not-a-real-token');
    expect(bogus.status).toBe(409);
    expect(((await bogus.json()) as ErrorBody).code).toBe('CONFIRM_TOKEN_INVALID');

    expect((await confirm(app, CREATE, '')).status).toBe(400);
    expect((await confirm(app, CREATE, 123)).status).toBe(400);
    expect((await send(app, `/api/tools/${CREATE}/confirm`, {})).status).toBe(400);
  });

  it('read 工具调 confirm → 400（读操作不需要确认）', async () => {
    const app = setup();
    const res = await confirm(app, LIST, 'whatever');
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).message).toMatch(/不需要确认/);
  });

  it('工具不存在 → 404 TOOL_NOT_FOUND（invoke 与 confirm 同口径）', async () => {
    const app = setup();
    for (const url of ['/api/tools/nope.invoke', `/api/tools/${RECORD}.nope`]) {
      const res = await send(app, `${url}/invoke`, {});
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).code).toBe('TOOL_NOT_FOUND');
    }
    expect((await confirm(app, 'nope.create', 'x')).status).toBe(404);
  });

  it('write 工具 params 自带 idempotencyKey → 400（幂等键只能由令牌充当）', async () => {
    const app = setup();
    const res = await invoke(app, CREATE, {
      recordId: 'Q1',
      data: { vendor_code: 'V-001' },
      idempotencyKey: 'caller-own-key',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).message).toMatch(/idempotencyKey/);
  });

  it('请求体不合法 → 400：params 非对象 / body 非 JSON / body 是数组', async () => {
    const app = setup();
    expect((await invoke(app, LIST, 'not-an-object')).status).toBe(400);
    expect((await invoke(app, LIST, [1, 2])).status).toBe(400);
    expect((await send(app, `/api/tools/${LIST}/invoke`, '{oops')).status).toBe(400);
    expect((await send(app, `/api/tools/${LIST}/invoke`, [1])).status).toBe(400);
    // 空 body 合法：无参工具（list 的 required 是空数组）
    expect((await send(app, `/api/tools/${LIST}/invoke`)).status).toBe(200);
  });
});

describe('B.5 防双写', () => {
  it('闸门拒绝跨工作区的令牌（单 ctx 只有一个工作区，直接测闸门口）', () => {
    const gate = new ConfirmGate();
    const issued = gate.issue({
      workspaceId: 'ws-a',
      toolId: CREATE,
      label: '新建供应商资质',
      params: {},
      actor: 'user:local',
    });
    expect(() => gate.consume(issued.token, { workspaceId: 'ws-b', toolId: CREATE })).toThrow(
      /另一个工作区/,
    );
    // 串工具同理：令牌只能执行它签发时那一个工具
    expect(() => gate.consume(issued.token, { workspaceId: 'ws-a', toolId: UPDATE })).toThrow(
      /不能用于/,
    );
    expect(gate.consume(issued.token, { workspaceId: 'ws-a', toolId: CREATE }).token).toBe(
      issued.token,
    );
  });

  it('同一令牌确认两次 → 两次都 200 且结果相同，库里只有一条（幂等回放）', async () => {
    const app = setup();
    const issued = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001' } })
    ).json()) as PendingBody;

    const first = (await (await confirm(app, CREATE, issued.token)).json()) as DoneBody;
    // ⚠️ 没有幂等回放的话，这一步必然撞 DYN_RECORD_CONFLICT（409）——重复提交造成双写的对照组
    const second = await confirm(app, CREATE, issued.token);
    expect(second.status).toBe(200);
    expect((await second.json()) as DoneBody).toEqual(first);
    expect(await recordCount(app)).toBe(1);
  });

  it('两张令牌写同一条记录 → 第二张真的撞冲突（闸门不掩盖业务错误）', async () => {
    const app = setup();
    const params = { recordId: 'Q1', data: { vendor_code: 'V-001' } };
    const a = (await (await invoke(app, CREATE, params)).json()) as PendingBody;
    const b = (await (await invoke(app, CREATE, params)).json()) as PendingBody;
    expect(a.token).not.toBe(b.token);

    expect((await confirm(app, CREATE, a.token)).status).toBe(200);
    const res = await confirm(app, CREATE, b.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe('DYN_RECORD_CONFLICT');
    expect(await recordCount(app)).toBe(1);
  });

  it('确认时执行的是令牌里冻结的参数：body 里另塞 params 一律忽略', async () => {
    const app = setup();
    const issued = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-001' } })
    ).json()) as PendingBody;
    // 「确认的和执行的不是一回事」是这类闸门最典型的漏洞：多带一份 params 就想改主意
    const res = await send(app, `/api/tools/${CREATE}/confirm`, {
      token: issued.token,
      params: { recordId: 'HIJACK', data: { vendor_code: 'V-999' } },
    });
    expect(res.status).toBe(200);
    const listed = (await (await invoke(app, LIST, {})).json()) as DoneBody;
    const rows = (listed.result as { rows: Array<{ recordId: string; data: Record<string, unknown> }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recordId).toBe('Q1');
    expect(rows[0]!.data).toEqual({ vendor_code: 'V-001' });
  });

  it('业务失败后同令牌可重试（幂等表只缓存成功，失败不钉死）', async () => {
    const app = setup();
    // 版本冲突：Q1 还不存在，expectedVersion 无处可对 → update 必然失败
    const issued = (await (
      await invoke(app, UPDATE, { recordId: 'Q1', expectedVersion: 1, data: { vendor_code: 'V-001' } })
    ).json()) as PendingBody;
    const failed = await confirm(app, UPDATE, issued.token);
    expect(failed.status).toBe(404); // 记录不存在 → DYN_RECORD_NOT_FOUND
    // 建好记录后，同一张令牌再用一次就能成功（失败没被钉在幂等键上）
    const created = (await (
      await invoke(app, CREATE, { recordId: 'Q1', data: { vendor_code: 'V-000' } })
    ).json()) as PendingBody;
    expect((await confirm(app, CREATE, created.token)).status).toBe(200);
    const retried = await confirm(app, UPDATE, issued.token);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as DoneBody).result).toMatchObject({ version: 2 });
  });
});
