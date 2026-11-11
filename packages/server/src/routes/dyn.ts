import { Hono } from 'hono';
import {
  DynRecordNotFoundError,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  coerceQueryValue,
  type DynRecordSchema,
  type ManifestRecord,
  type ManifestRecordField,
} from '@one/core';
import { resolveActor } from '../actor.js';
import type { AppContext } from '../context.js';
import { BadQueryError } from '../errors.js';

/**
 * 声明式实体的通用记录端点（B.3）——「客户提交一份 JSON 就能新增业务对象」的读写口。
 *
 * 路径 `/api/dyn/:module/:type[/:id]`，`:module` + `:type` 拼成实体 id `dyn.{module}.{type}`
 * （命名空间规则见 manifest-types.ts :: dynamicRecordId）。
 *
 * 白名单纪律（本节的核心，不要放宽）：
 *  - module/type 未在「生效 manifest ∩ 已安装」里声明 → 404，不建表、不兜底、不返回空列表。
 *    「返回空列表」会让前端以为实体存在只是没数据，配置漂移就再也发现不了；
 *  - 过滤/排序字段必须 manifest 声明 queryable:true，否则同样 404——白名单外的字段
 *    在这个端点上「不存在」，不区分「没这个字段」和「有但不许查」（少一个信息泄露面）；
 *  - 白名单取自 ModulesView.dynRecords()，与 DynStore 解析 schema 是同一个入口，两层不会错位。
 *
 * ⚠️ 未安装 ≠ 数据没了：卸载模块后这里一律 404，但 dyn_records 的行仍在库里，
 *    重装即恢复（§B.2 的「卸载不丢业务数据」承诺）。
 */

/** 声明式模块的记录端点（B.3）：分页/排序/过滤一律只作用于 manifest 声明 queryable 的列 */
export function dynRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** 实体白名单解析：未声明或模块未安装 → 404（不做任何兜底） */
  const resolveRecord = (module: string, type: string): DynRecordSchema => {
    const recordType = `dyn.${module}.${type}`;
    const schema = ctx.ws.modules
      .dynRecords()
      .find((s) => s.record.id === recordType && s.moduleId === module);
    if (!schema) {
      throw new DynRecordNotFoundError(`实体 ${recordType} 未声明，或所属模块未安装/已卸载`);
    }
    return schema;
  };

  app.get('/:module/:type', (c) => {
    const schema = resolveRecord(c.req.param('module'), c.req.param('type'));
    const limit = readInt(c.req.query('limit'), 'limit', LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = readInt(c.req.query('offset'), 'offset', 0, 0, undefined);
    const filter = readFilter(schema.record, c.req.query('filter'), c.req.query('equals'));
    const sort = readSort(schema.record, c.req.query('sort'), c.req.query('dir'));
    const { rows, total } = ctx.ws.dyn.list(schema.record.id, { limit, offset, filter, sort });
    return c.json({
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      rows,
    });
  });

  app.get('/:module/:type/:id', (c) => {
    const schema = resolveRecord(c.req.param('module'), c.req.param('type'));
    const recordId = c.req.param('id');
    const record = ctx.ws.dyn.get(schema.record.id, recordId);
    if (!record) {
      throw new DynRecordNotFoundError(`记录 ${schema.record.id}/${recordId} 不存在`);
    }
    return c.json(record);
  });

  app.post('/:module/:type', async (c) => {
    const schema = resolveRecord(c.req.param('module'), c.req.param('type'));
    const body = await readJsonObject(c);
    const { recordId, version } = ctx.ws.dyn.create(
      schema.record.id,
      body.recordId as string | undefined,
      body.data,
      { actor: resolveActor(ctx, c) },
    );
    return c.json({ recordId, version }, 201);
  });

  /**
   * 整替更新（不是 JSON patch）。语义与 DynStore.update 一致：body.data 就是记录的新全量。
   * ⚠️ manifest 没有 required/default 概念（列全部可选），所以「没带上的列」= 该键从 JSON 里消失，
   *    不会被默认值补回来——前端/AI 必须带上没改的列，否则等于把它们清空。
   */
  app.patch('/:module/:type/:id', async (c) => {
    const schema = resolveRecord(c.req.param('module'), c.req.param('type'));
    const body = await readJsonObject(c);
    const recordId = c.req.param('id');
    const { version } = ctx.ws.dyn.update(
      schema.record.id,
      recordId,
      body.data,
      readExpectedVersion(body.expectedVersion),
      { actor: resolveActor(ctx, c) },
    );
    return c.json({ recordId, version });
  });

  // DELETE 没有 body 惯例，乐观并发的版本号走查询串 ?version=N
  app.delete('/:module/:type/:id', (c) => {
    const schema = resolveRecord(c.req.param('module'), c.req.param('type'));
    const recordId = c.req.param('id');
    const version = c.req.query('version');
    if (version === undefined) {
      throw new BadQueryError('删除必须携带 ?version=（乐观并发：需等于读取时的 version）');
    }
    ctx.ws.dyn.delete(schema.record.id, recordId, readExpectedVersion(version), {
      actor: resolveActor(ctx, c),
    });
    return c.json({ deleted: true, recordId });
  });

  return app;
}

// ── 参数解析（全部经 manifest 白名单，坏参数 400，白名单外 404）─────────

/** 过滤：?filter=<字段>&equals=<值>。只给其一时视为参数缺失（400），不猜意图 */
function readFilter(
  record: ManifestRecord,
  field: string | undefined,
  raw: string | undefined,
): { field: string; equals: unknown } | undefined {
  if (field === undefined && raw === undefined) return undefined;
  if (field === undefined || raw === undefined) {
    throw new BadQueryError('过滤需要同时给出 filter=<字段> 与 equals=<值>');
  }
  const column = requireQueryable(record, field);
  return { field: column.key, equals: coerce(column, raw) };
}

/** 排序：?sort=<字段>&dir=asc|desc（dir 缺省升序） */
function readSort(
  record: ManifestRecord,
  field: string | undefined,
  dir: string | undefined,
): { field: string; dir: 'asc' | 'desc' } | undefined {
  if (field === undefined) {
    if (dir !== undefined) throw new BadQueryError('dir 需要与 sort=<字段> 一起给出');
    return undefined;
  }
  const column = requireQueryable(record, field);
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') {
    throw new BadQueryError(`dir 只接受 asc / desc，收到 ${JSON.stringify(dir)}`);
  }
  return { field: column.key, dir: dir ?? 'asc' };
}

/** 查询白名单闸口：未声明或未标 queryable 一律 404（在这个端点上等同「不存在」） */
function requireQueryable(record: ManifestRecord, key: string): ManifestRecordField {
  const column = record.fields.find((f) => f.key === key);
  if (!column || !column.queryable) {
    throw new DynRecordNotFoundError(`实体 ${record.id} 没有可查询字段 ${key}`);
  }
  return column;
}

/**
 * 查询串按 manifest 声明的列类型转值。转换规则在 core（`coerceQueryValue`）——
 * B.4 的 AI 工具是同一规则的另一个适配层，两处各写一遍必然漂移。
 * 这里只做错误语义映射：存储层抛的是「列校验」（422 语义），
 * 但查询串写错属于「请求不合法」→ 400 Bad Query，两者不能混。
 */
function coerce(column: ManifestRecordField, raw: string): unknown {
  try {
    return coerceQueryValue(column, raw);
  } catch (err) {
    throw new BadQueryError(err instanceof Error ? err.message : `字段 ${column.key} 的值不合法`);
  }
}

/** 乐观并发版本号：必须是正整数（0/负数/小数一律拒，避免「拿脏值当版本」静默成功） */
function readExpectedVersion(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new BadQueryError(`expectedVersion 必须是不小于 1 的整数，收到 ${JSON.stringify(raw)}`);
  }
  return n;
}

function readInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number | undefined,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new BadQueryError(
      `${name} 必须是${max === undefined ? `不小于 ${min}` : `${min}~${max} 之间`}的整数，收到 ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** 请求体必须是 JSON 对象（数组/null/坏 JSON 一律 400，不让存储层去猜） */
async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadQueryError('请求体必须是合法 JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadQueryError('请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}
