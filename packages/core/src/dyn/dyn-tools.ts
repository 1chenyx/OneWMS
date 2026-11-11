import { ToolNotFoundError, ToolValidationError } from '../errors.js';
import type { ToolBus, ToolDefinition } from '../bus/tool-bus.js';
import type { ParameterSchema } from '../bus/schema-validator.js';
import type { ManifestRecord, ManifestRecordField } from '../modules/manifest-types.js';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, coerceQueryValue } from './dyn-store.js';
import type { DynListOptions, DynRecordSchema, DynStore } from './dyn-store.js';

/**
 * 声明式实体的 AI 工具（B.4）——「配置了新实体，AI 立刻可用」的落地点。
 *
 * 每个已安装模块声明的 dyn 实体注册五个工具：`{实体 id}.list/get/create/update/delete`
 * （实体 id 本身就是 `dyn.{moduleId}.{recordId}`，所以工具 id 形如 `dyn.module.expiry.asset.list`）。
 * 读写都走 DynStore，与 B.3 的 HTTP 端点是同一份白名单、同一套校验——两个适配层，一个存储层。
 *
 * description 从 manifest 动态拼装（本文件的核心要求）：实体中文名、列名、列含义、列类型、
 * 哪些列可过滤排序，全部来自 manifest，没有一处硬编码实体名。这样客户提交一份 JSON、
 * confirm 装上之后，AI 不需要任何人改代码就知道这个对象长什么样、怎么读写。
 *
 * ⚠️ 进程级总线 vs per-workspace manifest（本文件唯一的妥协，别当成 bug 修）：
 *    ToolBus 是进程级单例，而 description / parameters 是**注册期固化**的。
 *    若两个 workspace 装了同 id 模块但 schema 不同，后注册者的文案会覆盖前者。
 *    正确性不受影响——handler 一律按 `ctx.workspaceId` 现取 schema，过滤/排序白名单、
 *    列类型校验都以调用方 workspace 的 manifest 为准；受影响的只是「广告词」可能过时。
 *    ①② 的实际形态是单 workspace（ONE_WORKSPACE），多租户隔离是 ③ 的事（另起代码）。
 *
 * ⚠️ 只做覆盖注册，**从不 unregister**（§A.4 决策）：卸载模块后工具仍在总线上，
 *    但调用会因 schema 解析不到而失败；「AI 看不见已卸载模块的工具」由 A.4 的
 *    授权/可见性层过滤实现，不在这里摘 handler（摘了重装就装不回去，见预检 5）。
 */

/** 列类型 → 给 AI 的填法提示（manifest 无 enum/options 等素材，类型是唯一能给的约束） */
const TYPE_HINT: Record<NonNullable<ManifestRecordField['type']>, string> = {
  string: '文本',
  number: '数字',
  boolean: 'true/false',
  date: '日期字符串（ISO，如 2026-11-11）',
  json: '对象或数组',
};

/** 写工具共用的尾巴：列结构不是 profile 能改的，别把 AI 引到错路上 */
const CONFIG_NOTE =
  '列结构由模块 manifest 定义，不能用 profile.field.propose 增删；' +
  '要改列得用 dyn.module.register 重新注册模块（走用户确认）。';

interface ListParams {
  limit?: number;
  offset?: number;
  filterField?: string;
  filterValue?: string;
  sortField?: string;
  sortDir?: string;
}

interface IdParams {
  recordId?: string;
}

interface WriteParams extends IdParams {
  data?: unknown;
  expectedVersion?: number;
}

/**
 * 按 manifest 生成一个工作区里全部声明式实体的工具定义。
 * 纯函数（不碰总线），便于单测直接断言 description / parameters 的拼装结果。
 */
export function createDynTools(schemas: DynRecordSchema[], store: DynStore): ToolDefinition[] {
  return schemas.flatMap((schema) => entityTools(schema, store));
}

/**
 * 把 schemas 对应的工具覆盖注册到总线上，返回注册到的工具 id。
 * 两个调用时机（缺一个就不成立）：
 *  1. 工作区打开时（WorkspaceFacade 构造）——重启后 manifest 经 config.change 重放回来，
 *     此时进程目录里并没有声明式模块的代码，只能靠这条路径把工具装回去；
 *  2. 模块安装成功后（ModuleRegistry.install）——不重启就生效，这是 B 阶段的验收要求。
 *
 * 同 id 覆盖是幂等的，所以两处都调、重复调都安全。
 */
export function syncDynTools(bus: ToolBus, store: DynStore, schemas: DynRecordSchema[]): string[] {
  const tools = createDynTools(schemas, store);
  for (const tool of tools) bus.register(tool);
  return tools.map((tool) => tool.id);
}

// ── 单个实体的五个工具 ─────────────────────────────────────

function entityTools({ moduleId, record }: DynRecordSchema, store: DynStore): ToolDefinition[] {
  const id = record.id;
  const queryable = record.fields.filter((field) => field.queryable).map((field) => field.key);
  const columnKeys = record.fields.map((field) => field.key);
  // 身份行：五个工具都带，deferred 模式下被截到 600 字也要先让 AI 认出「这是哪个对象」
  const identity = describeIdentity(moduleId, record);
  // 列清单只给真正需要照着填/照着查的工具（create/update/list），
  // get/delete 的返回值自解释——五个工具各抄一遍列清单是白烧 token
  const columns = describeFields(record.fields);

  const list: ToolDefinition = {
    id: `${id}.list`,
    label: `查询${record.label}`,
    description:
      `${identity}\n分页列出全部${record.label}。` +
      (queryable.length > 0
        ? `只有这些列能过滤和排序：${queryable.join('、')}。`
        : '本实体没有声明可查询列，只能整表翻页（不能过滤、不能排序）。') +
      `不传过滤条件时按记录 id 升序。\n${columns}\n${CONFIG_NOTE}`,
    permission: 'read',
    parameters: listParameters(queryable),
    handler: (params, ctx) => {
      const p = params as ListParams;
      const limit = p.limit ?? LIST_LIMIT_DEFAULT;
      const offset = p.offset ?? 0;
      const { rows, total } = store.list(ctx.workspaceId, id, {
        limit,
        offset,
        filter: readFilter(record, p.filterField, p.filterValue),
        sort: readSort(p.sortField, p.sortDir),
      });
      const next = offset + rows.length;
      return {
        recordType: id,
        total,
        limit,
        offset,
        ...(next < total ? { nextOffset: next } : {}),
        rows: rows.map((row) => ({
          recordId: row.recordId,
          version: row.version,
          updatedAt: row.updatedAt,
          data: row.data,
        })),
      };
    },
  };

  const get: ToolDefinition = {
    id: `${id}.get`,
    label: `获取${record.label}`,
    description:
      `${identity}\n按记录 id 取一条${record.label}。` +
      `返回里的 version 是乐观并发凭据：更新和删除都必须把它带回去，不一致会被拒绝。`,
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '记录 id' },
      },
      required: ['recordId'],
    },
    handler: (params, ctx) => {
      const recordId = (params as IdParams).recordId ?? '';
      const row = store.get(ctx.workspaceId, id, recordId);
      if (!row) throw new ToolNotFoundError(`${record.label} ${id}/${recordId} 不存在`);
      return {
        recordType: id,
        recordId: row.recordId,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        data: row.data,
      };
    },
  };

  const create: ToolDefinition = {
    id: `${id}.create`,
    label: `新建${record.label}`,
    description:
      `${identity}\n新建一条${record.label}。data 的键必须是下面列出的列，多写一个未声明的列会被整条拒绝；` +
      `值类型要匹配列类型。recordId 可以省略（自动生成）。\n${columns}\n${CONFIG_NOTE}`,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        recordId: {
          type: 'string',
          description: '记录 id（可选，省略则自动生成）。字母数字开头，只能含字母/数字/_/-，最长 64 位',
        },
        data: { type: 'object', description: `记录内容。键只能是：${columnKeys.join('、')}` },
      },
      required: ['data'],
    },
    handler: (params, ctx) => {
      const p = params as WriteParams;
      const created = store.create(ctx.workspaceId, id, p.recordId, p.data, { actor: ctx.actor });
      return { recordType: id, ...created };
    },
  };

  const update: ToolDefinition = {
    id: `${id}.update`,
    label: `更新${record.label}`,
    description:
      `${identity}\n整替更新一条${record.label}——不是增量补丁：data 就是记录的新全量。` +
      `⚠️ 列全部可选且没有默认值，没带上的列会从记录里消失，所以要先 get 再改再整体提交。` +
      `expectedVersion 必须等于读取时拿到的 version，不一致说明别人已经改过，本次会被拒绝。\n${columns}\n${CONFIG_NOTE}`,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '记录 id' },
        expectedVersion: { type: 'integer', minimum: 1, description: '读取时拿到的 version（乐观并发）' },
        data: { type: 'object', description: `记录的新全量。键只能是：${columnKeys.join('、')}` },
      },
      required: ['recordId', 'expectedVersion', 'data'],
    },
    handler: (params, ctx) => {
      const p = params as WriteParams;
      const recordId = p.recordId ?? '';
      const updated = store.update(ctx.workspaceId, id, recordId, p.data, requireVersion(p.expectedVersion), {
        actor: ctx.actor,
      });
      return { recordType: id, recordId, ...updated };
    },
  };

  const remove: ToolDefinition = {
    id: `${id}.delete`,
    label: `删除${record.label}`,
    description:
      `${identity}\n删除一条${record.label}。expectedVersion 同更新（乐观并发）。` +
      `删除只摘掉可查询的投影，账本（oplog）里的事件永久保留，重装模块重放即可恢复。`,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '记录 id' },
        expectedVersion: { type: 'integer', minimum: 1, description: '读取时拿到的 version（乐观并发）' },
      },
      required: ['recordId', 'expectedVersion'],
    },
    handler: (params, ctx) => {
      const p = params as WriteParams;
      const recordId = p.recordId ?? '';
      store.delete(ctx.workspaceId, id, recordId, requireVersion(p.expectedVersion), { actor: ctx.actor });
      return { recordType: id, recordId, deleted: true };
    },
  };

  return [list, get, create, update, remove];
}

// ── description 拼装（全部素材来自 manifest，没有硬编码实体名）──────────

/** 身份行：实体中文名 + 别名 + 实体 id + 来源模块 + note */
function describeIdentity(moduleId: string, record: ManifestRecord): string {
  const alias = record.aliases?.length ? `，又称 ${record.aliases.join('、')}` : '';
  const note = record.note ? ` ${record.note}` : '';
  return `${record.label}（实体 id ${record.id}${alias}，由声明式模块 ${moduleId} 提供）。${note}`;
}

/**
 * 列清单：`key（中文名，类型，可过滤/排序）：含义`。
 * 这是 AI 生成 data 的唯一依据——manifest 没有 required/default/options 之类素材，
 * 能给的就是列名、中文标签、类型和「能不能拿来查」。
 */
function describeFields(fields: ManifestRecordField[]): string {
  const parts = fields.map((field) => {
    const traits: string[] = [];
    if (field.type) traits.push(TYPE_HINT[field.type]);
    if (field.queryable) traits.push('可过滤/排序');
    const head = traits.length > 0 ? `${field.key}（${field.label}，${traits.join('，')}）` : `${field.key}（${field.label}）`;
    return field.description ? `${head}：${field.description}` : head;
  });
  return `列：${parts.join('；')}。`;
}

/** list 的入参。过滤/排序列用 enum 收窄——AI 少猜一次，白名单外的列压根递不进来 */
function listParameters(queryable: string[]): ParameterSchema {
  const pickable = queryable.length > 0 ? { enum: queryable } : {};
  const pickHint = queryable.length > 0 ? `只能是：${queryable.join('、')}` : '本实体没有可查询列';
  return {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_LIMIT_MAX,
        description: `返回条数上限（默认 ${LIST_LIMIT_DEFAULT}，最大 ${LIST_LIMIT_MAX}）`,
      },
      offset: { type: 'integer', minimum: 0, description: '跳过的条数（默认 0）。翻页时填上一页返回的 nextOffset' },
      filterField: { type: 'string', ...pickable, description: `等值过滤的列，${pickHint}。必须与 filterValue 成对出现` },
      filterValue: {
        type: 'string',
        description: '过滤值（字符串）。按列声明类型解释：数字列填 "9"、布尔列填 "true"/"false"、json 列填紧凑 JSON 串',
      },
      sortField: { type: 'string', ...pickable, description: `排序列，${pickHint}。不传则按记录 id 升序` },
      sortDir: { type: 'string', enum: ['asc', 'desc'], description: '排序方向（默认 asc）' },
    },
    required: [],
  };
}

/**
 * 过滤入参：成对校验 + 按列类型还原值。
 * ⚠️ 列类型取自**注册期**的 manifest 快照，而白名单判定由 DynStore 按调用方 workspace 现做：
 *    列不存在或没标 queryable 时不猜类型，原样透传，让存储层抛权威的白名单错误。
 */
function readFilter(
  record: ManifestRecord,
  field: string | undefined,
  raw: string | undefined,
): DynListOptions['filter'] {
  if (field === undefined && raw === undefined) return undefined;
  if (field === undefined || raw === undefined) {
    throw new ToolValidationError('filterField 与 filterValue 必须成对出现');
  }
  const column = record.fields.find((item) => item.key === field);
  return { field, equals: column ? coerceQueryValue(column, raw) : raw };
}

/** 排序入参：dir 缺省升序（与 B.3 端点同一文法） */
function readSort(field: string | undefined, dir: string | undefined): DynListOptions['sort'] {
  if (field === undefined) {
    if (dir !== undefined) throw new ToolValidationError('sortDir 需要与 sortField 一起给出');
    return undefined;
  }
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') {
    throw new ToolValidationError(`sortDir 只接受 asc / desc，收到 ${JSON.stringify(dir)}`);
  }
  return { field, dir: dir ?? 'asc' };
}

/** 乐观并发版本号必填（写工具入参，schema 已声明 integer，这里只挡「没传」） */
function requireVersion(version: number | undefined): number {
  if (version === undefined) {
    throw new ToolValidationError('缺少 expectedVersion：先用 get 读到 version 再来写（乐观并发）');
  }
  return version;
}
