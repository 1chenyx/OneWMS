import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OneCore,
  buildEnvelope,
  DynRecordConflictError,
  DynRecordNotFoundError,
  DynRecordValidationError,
  RECORD_CREATED_EVENT,
  RECORD_UPDATED_EVENT,
  RECORD_DELETED_EVENT,
  type ModuleManifest,
  type WorkspaceFacade,
} from '../src/index.js';

/**
 * B.2 通用记录存储：写路径校验 → record.* 事件 → dyn_records/dyn_index 投影 →
 * 追账/重放/重装重投影/孤儿保留。全部经 facade 公共 API 验证行为契约（服务层测试策略）。
 */

const dirs: string[] = [];
afterEach(() => {
  // Windows：better-sqlite3 句柄释放有延迟，清理临时目录需重试
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 清理失败不影响测试判定，留给系统临时目录回收
    }
  }
});

/** 文件库（重开验证持久化与追账自愈必须落盘；内存库无法跨实例） */
function openFileCore() {
  const dir = mkdtempSync(join(tmpdir(), `onewms-dynrec-${randomUUID().slice(0, 8)}-`));
  dirs.push(dir);
  const path = join(dir, 'wms.db');
  const core = OneCore.open(path);
  return { core, ws: core.workspace('ws-dyn'), path };
}

/** 声明式模块 manifest：覆盖全部字段类型 + queryable 开关 */
function dynManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'vendor.extra',
    name: '供应商扩展档案',
    description: '供应商资质等辅助档案（纯 JSON 声明，无本地代码）',
    version: '1.0.0',
    capabilities: ['db.read'],
    records: [
      {
        id: 'dyn.vendor.extra.qualification',
        label: '供应商资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string', queryable: true },
          { key: 'cert_level', label: '资质等级', type: 'string' },
          { key: 'valid_until', label: '有效期至', type: 'date' },
          { key: 'score', label: '评分', type: 'number', queryable: true },
          { key: 'active', label: '是否启用', type: 'boolean' },
          { key: 'extra', label: '附加信息', type: 'json' },
        ],
      },
    ],
    ...overrides,
  };
}

/** 变更 queryable 布局的 v2：vendor_code 撤索引、cert_level 上索引——验证重装重投影 */
function dynManifestV2(): ModuleManifest {
  return dynManifest({
    version: '2.0.0',
    records: [
      {
        id: 'dyn.vendor.extra.qualification',
        label: '供应商资质',
        fields: [
          { key: 'vendor_code', label: '供应商编码', type: 'string' },
          { key: 'cert_level', label: '资质等级', type: 'string', queryable: true },
          { key: 'valid_until', label: '有效期至', type: 'date' },
          { key: 'score', label: '评分', type: 'number', queryable: true },
          { key: 'active', label: '是否启用', type: 'boolean' },
          { key: 'extra', label: '附加信息', type: 'json' },
        ],
      },
    ],
  });
}

const QUAL = 'dyn.vendor.extra.qualification';

function countEvents(ws: WorkspaceFacade, type: string): number {
  let n = 0;
  ws.events.forEach((env) => {
    if (env.type === type) n++;
  });
  return n;
}

function rawRowCount(core: OneCore, table: string): number {
  const row = core.exposeDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = 'ws-dyn'`).get() as {
    n: number;
  };
  return row.n;
}

// ── 写路径与校验 ─────────────────────────────────────────

describe('dyn 记录写路径', () => {
  it('create → get 往返：data 保真、version=1、时间戳为 ISO 字符串', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    const data = {
      vendor_code: 'V-001',
      cert_level: 'A',
      valid_until: '2027-12-31',
      score: 92.5,
      active: true,
      extra: { tags: ['iso', 'gmp'], note: null },
    };
    const { recordId, version } = ws.dyn.create(QUAL, 'Q1', data);
    expect(recordId).toBe('Q1');
    expect(version).toBe(1);
    const stored = ws.dyn.get(QUAL, 'Q1');
    expect(stored?.data).toEqual(data);
    expect(stored?.version).toBe(1);
    expect(typeof stored?.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(stored!.createdAt))).toBe(false);
    core.close();
  });

  it('recordId 缺省自动生成且符合行 id 规则', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    const { recordId } = ws.dyn.create(QUAL, undefined, { vendor_code: 'V-002' });
    expect(recordId).toMatch(/^r-[0-9a-f]{12}$/);
    expect(ws.dyn.get(QUAL, recordId)?.data).toEqual({ vendor_code: 'V-002' });
    core.close();
  });

  it('未声明字段 / 类型不匹配被拒（string/number/boolean/date 全类型白名单）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    expect(() => ws.dyn.create(QUAL, 'Q1', { nope: 'x' })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, 'Q1', { vendor_code: 123 })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, 'Q1', { score: '92' })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, 'Q1', { active: 'yes' })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, 'Q1', { valid_until: 'not-a-date' })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, 'Q1', { score: Number.POSITIVE_INFINITY })).toThrow(DynRecordValidationError);
    // json 列接受任意 JSON 值（对象/数组/标量皆可）
    expect(() => ws.dyn.create(QUAL, 'Q1', { extra: [1, { a: true }] })).not.toThrow();
    core.close();
  });

  it('recordId 非法格式被拒；未声明实体 / 未安装模块 NotFound', () => {
    const { core, ws } = openFileCore();
    expect(() => ws.dyn.create(QUAL, 'Q1', {})).toThrow(DynRecordNotFoundError);
    ws.modules.install(dynManifest());
    expect(() => ws.dyn.create(QUAL, 'bad id!', {})).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create(QUAL, '', {})).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.create('dyn.vendor.extra.unknown', 'Q1', {})).toThrow(DynRecordNotFoundError);
    core.close();
  });

  it('重复 create 冲突；update/delete 需在场且版本匹配', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001' });
    expect(() => ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001' })).toThrow(DynRecordConflictError);

    expect(() => ws.dyn.update(QUAL, 'Q1', { vendor_code: 'V-x' }, 99)).toThrow(DynRecordConflictError);
    expect(() => ws.dyn.update(QUAL, 'missing', {}, 1)).toThrow(DynRecordNotFoundError);
    expect(() => ws.dyn.delete(QUAL, 'missing', 1)).toThrow(DynRecordNotFoundError);

    const { version } = ws.dyn.update(QUAL, 'Q1', { vendor_code: 'V-002', score: 80 }, 1);
    expect(version).toBe(2);
    expect(ws.dyn.get(QUAL, 'Q1')?.data).toEqual({ vendor_code: 'V-002', score: 80 });

    expect(() => ws.dyn.delete(QUAL, 'Q1', 1)).toThrow(DynRecordConflictError); // 版本已到 2
    ws.dyn.delete(QUAL, 'Q1', 2);
    expect(ws.dyn.get(QUAL, 'Q1')).toBeUndefined();
    expect(() => ws.dyn.delete(QUAL, 'Q1', 2)).toThrow(DynRecordNotFoundError);
    core.close();
  });

  it('update 整替字段且 created_at 不变（UPSERT 保留首次建档时间）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001', score: 10 });
    const before = ws.dyn.get(QUAL, 'Q1')!;
    ws.dyn.update(QUAL, 'Q1', { vendor_code: 'V-001', active: false }, before.version);
    const after = ws.dyn.get(QUAL, 'Q1')!;
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.data).toEqual({ vendor_code: 'V-001', active: false }); // score 整替后消失
    expect(after.version).toBe(2);
    core.close();
  });

  it('写路径落 record.created/updated/deleted 事件进账本', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'Q1', { vendor_code: 'V-001' });
    ws.dyn.update(QUAL, 'Q1', { vendor_code: 'V-002' }, 1);
    ws.dyn.delete(QUAL, 'Q1', 2);
    expect(countEvents(ws, RECORD_CREATED_EVENT)).toBe(1);
    expect(countEvents(ws, RECORD_UPDATED_EVENT)).toBe(1);
    expect(countEvents(ws, RECORD_DELETED_EVENT)).toBe(1);
    core.close();
  });
});

// ── 索引表与过滤查询 ─────────────────────────────────────

describe('dyn_index 与列表过滤', () => {
  function seed(ws: WorkspaceFacade): void {
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001', score: 90 });
    ws.dyn.create(QUAL, 'B', { vendor_code: 'V-002', score: 70 });
    ws.dyn.create(QUAL, 'C', { vendor_code: 'V-001', score: 50, active: false });
  }

  it('等值过滤只作用于 queryable 字段并下推到 dyn_index', () => {
    const { core, ws } = openFileCore();
    seed(ws);
    const byCode = ws.dyn.list(QUAL, { filter: { field: 'vendor_code', equals: 'V-001' } });
    expect(byCode.rows.map((r) => r.recordId)).toEqual(['A', 'C']);
    expect(byCode.total).toBe(2);
    const byScore = ws.dyn.list(QUAL, { filter: { field: 'score', equals: 90 } });
    expect(byScore.rows.map((r) => r.recordId)).toEqual(['A']);
    core.close();
  });

  it('过滤非 queryable / 未声明字段被拒', () => {
    const { core, ws } = openFileCore();
    seed(ws);
    expect(() => ws.dyn.list(QUAL, { filter: { field: 'cert_level', equals: 'A' } })).toThrow(
      DynRecordValidationError,
    );
    expect(() => ws.dyn.list(QUAL, { filter: { field: 'nope', equals: 'A' } })).toThrow(
      DynRecordValidationError,
    );
    core.close();
  });

  it('无过滤列表 + 分页（limit/offset/total）', () => {
    const { core, ws } = openFileCore();
    seed(ws);
    const page = ws.dyn.list(QUAL, { limit: 2, offset: 0 });
    expect(page.rows.map((r) => r.recordId)).toEqual(['A', 'B']);
    expect(page.total).toBe(3);
    const rest = ws.dyn.list(QUAL, { limit: 2, offset: 2 });
    expect(rest.rows.map((r) => r.recordId)).toEqual(['C']);
    core.close();
  });

  it('删除后索引行同步消失（过滤不再命中）', () => {
    const { core, ws } = openFileCore();
    seed(ws);
    ws.dyn.delete(QUAL, 'A', 1);
    const hit = ws.dyn.list(QUAL, { filter: { field: 'vendor_code', equals: 'V-001' } });
    expect(hit.rows.map((r) => r.recordId)).toEqual(['C']);
    core.close();
  });
});

// ── 排序（B.3 端点的 sort 参数落到这里）───────────────────

describe('dyn 列表排序', () => {
  /** 种子刻意让 TEXT 字典序与数值序分叉：字典序是 "100" < "50" < "70" < "9"，数值序是 9 < 50 < 70 < 100 */
  function seedSortable(ws: WorkspaceFacade): void {
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'R1', { vendor_code: 'V-001', score: 100 });
    ws.dyn.create(QUAL, 'R2', { vendor_code: 'V-002', score: 9 });
    ws.dyn.create(QUAL, 'R3', { vendor_code: 'V-001', score: 50 });
    ws.dyn.create(QUAL, 'R4', { vendor_code: 'V-003' }); // 没有 score（可选列），用来验 LEFT JOIN 不丢行
  }

  it('number 列按数值排，不按索引值的 TEXT 字典序', () => {
    const { core, ws } = openFileCore();
    seedSortable(ws);
    const asc = ws.dyn.list(QUAL, { sort: { field: 'score' } });
    expect(asc.rows.map((r) => r.recordId)).toEqual(['R2', 'R3', 'R1', 'R4']);
    const desc = ws.dyn.list(QUAL, { sort: { field: 'score', dir: 'desc' } });
    expect(desc.rows.map((r) => r.recordId)).toEqual(['R1', 'R3', 'R2', 'R4']);
    core.close();
  });

  it('缺失排序字段的记录不被 JOIN 丢掉，统一排最后（方向无关）', () => {
    const { core, ws } = openFileCore();
    seedSortable(ws);
    expect(ws.dyn.list(QUAL, { sort: { field: 'score' } }).total).toBe(4);
    expect(ws.dyn.list(QUAL, { sort: { field: 'score', dir: 'desc' } }).total).toBe(4);
    core.close();
  });

  it('string 列按字典序排；排序与过滤可组合', () => {
    const { core, ws } = openFileCore();
    seedSortable(ws);
    const byCode = ws.dyn.list(QUAL, { sort: { field: 'vendor_code' } });
    expect(byCode.rows.map((r) => r.recordId)).toEqual(['R1', 'R3', 'R2', 'R4']);
    const both = ws.dyn.list(QUAL, {
      filter: { field: 'vendor_code', equals: 'V-001' },
      sort: { field: 'score', dir: 'desc' },
    });
    expect(both.rows.map((r) => r.recordId)).toEqual(['R1', 'R3']);
    expect(both.total).toBe(2);
    core.close();
  });

  it('排序字段同样受 queryable 白名单约束（非 queryable / 未声明被拒）', () => {
    const { core, ws } = openFileCore();
    seedSortable(ws);
    expect(() => ws.dyn.list(QUAL, { sort: { field: 'cert_level' } })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.list(QUAL, { sort: { field: 'nope' } })).toThrow(DynRecordValidationError);
    core.close();
  });

  it('排序 + 分页：翻页顺序稳定且不重不漏', () => {
    const { core, ws } = openFileCore();
    seedSortable(ws);
    const p1 = ws.dyn.list(QUAL, { sort: { field: 'score' }, limit: 2, offset: 0 });
    const p2 = ws.dyn.list(QUAL, { sort: { field: 'score' }, limit: 2, offset: 2 });
    expect(p1.rows.map((r) => r.recordId)).toEqual(['R2', 'R3']);
    expect(p2.rows.map((r) => r.recordId)).toEqual(['R1', 'R4']);
    core.close();
  });

  it('offset 不被单页上限截断（深分页仍能翻过去）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    for (let i = 0; i < 3; i += 1) {
      ws.dyn.create(QUAL, `X${i}`, { vendor_code: 'V-001' });
    }
    // offset 250 > 单页上限 200：若被 clamp 就会静默返回第 200 页而不是空页
    const beyond = ws.dyn.list(QUAL, { limit: 2, offset: 250 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(3);
    expect(() => ws.dyn.list(QUAL, { offset: -1 })).toThrow(DynRecordValidationError);
    expect(() => ws.dyn.list(QUAL, { limit: 0 })).toThrow(DynRecordValidationError);
    core.close();
  });
});

// ── 投影一致性：追账 / 重放 / 重开 / 重装 / 孤儿 ───────────

describe('dyn 投影一致性', () => {
  it('replay 全量重放幂等（含 dyn 两表，重建后数据一致）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001', score: 90 });
    ws.dyn.update(QUAL, 'A', { vendor_code: 'V-001', score: 95 }, 1);
    ws.dyn.create(QUAL, 'B', { vendor_code: 'V-002' });
    const before = {
      a: ws.dyn.get(QUAL, 'A'),
      b: ws.dyn.get(QUAL, 'B'),
      list: ws.dyn.list(QUAL, { filter: { field: 'score', equals: 95 } }),
    };
    ws.replay();
    expect(ws.dyn.get(QUAL, 'A')).toEqual(before.a);
    expect(ws.dyn.get(QUAL, 'B')).toEqual(before.b);
    expect(ws.dyn.list(QUAL, { filter: { field: 'score', equals: 95 } })).toEqual(before.list);
    core.close();
  });

  it('文件库重开：记录与 manifest（config 落账）双在场，构造期追账后直接可读', () => {
    const { core, ws, path } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001', score: 90 });
    core.close();

    const core2 = OneCore.open(path);
    const ws2 = core2.workspace('ws-dyn');
    const stored = ws2.dyn.get(QUAL, 'A');
    expect(stored?.data).toEqual({ vendor_code: 'V-001', score: 90 });
    expect(stored?.version).toBe(1);
    core2.close();
  });

  it('摄入远端 record.* 事件后，新门面构造期追账自动可见（含重复摄入幂等）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    const env = buildEnvelope({
      workspaceId: 'ws-dyn',
      actor: 'user:remote@node-b',
      seq: 1,
      lamport: 5000,
      type: RECORD_CREATED_EVENT,
      payload: {
        moduleId: 'vendor.extra',
        recordType: QUAL,
        recordId: 'R-100',
        data: { vendor_code: 'V-009', score: 66 },
        version: 1,
      },
    });
    expect(ws.events.ingest([env]).accepted).toBe(1);
    expect(ws.events.ingest([env]).skipped).toBe(1); // eventId 幂等

    const ws2 = core.workspace('ws-dyn'); // 构造期 sync 追账
    expect(ws2.dyn.get(QUAL, 'R-100')?.data).toEqual({ vendor_code: 'V-009', score: 66 });
    // 索引行也随追账落位
    const hit = ws2.dyn.list(QUAL, { filter: { field: 'score', equals: 66 } });
    expect(hit.rows.map((r) => r.recordId)).toEqual(['R-100']);
    core.close();
  });

  it('per-module 投影组版本戳落 meta（group=dyn.{moduleId}）', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001' });
    // 触发一次新门面构造 → ensureModuleProjection 打戳
    core.workspace('ws-dyn');
    expect(core.getMeta('projection.dyn.vendor.extra.ws-dyn')).toBe('1');
    core.close();
  });

  it('卸载保留数据但不可访问（404 语义）；重装同版本后数据回来且索引重建', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001', score: 90 });
    ws.modules.uninstall('vendor.extra');

    // 白名单严格来自 manifest：卸载后实体解析即 NotFound（数据仍在库里，界面上不可访问）
    expect(() => ws.dyn.get(QUAL, 'A')).toThrow(DynRecordNotFoundError);
    expect(rawRowCount(core, 'dyn_records')).toBe(1); // 行没删——卸载不丢业务数据

    ws.modules.install(dynManifest()); // 重装同版本
    const stored = ws.dyn.get(QUAL, 'A');
    expect(stored?.data).toEqual({ vendor_code: 'V-001', score: 90 });
    expect(ws.dyn.list(QUAL, { filter: { field: 'score', equals: 90 } }).rows.map((r) => r.recordId)).toEqual([
      'A',
    ]);
    core.close();
  });

  it('重装换 schema（v2 调整 queryable）触发整组重投影：索引按新 manifest 重建', () => {
    const { core, ws } = openFileCore();
    ws.modules.install(dynManifest());
    ws.dyn.create(QUAL, 'A', { vendor_code: 'V-001', cert_level: 'AAA', score: 90 });

    ws.modules.uninstall('vendor.extra');
    ws.modules.install(dynManifestV2());

    // v2：cert_level 上索引 → 可过滤；vendor_code 撤索引 → 过滤被拒
    const byLevel = ws.dyn.list(QUAL, { filter: { field: 'cert_level', equals: 'AAA' } });
    expect(byLevel.rows.map((r) => r.recordId)).toEqual(['A']);
    expect(() => ws.dyn.list(QUAL, { filter: { field: 'vendor_code', equals: 'V-001' } })).toThrow(
      DynRecordValidationError,
    );
    // 数据行不受 schema 变化影响
    expect(ws.dyn.get(QUAL, 'A')?.data).toEqual({
      vendor_code: 'V-001',
      cert_level: 'AAA',
      score: 90,
    });
    core.close();
  });
});
