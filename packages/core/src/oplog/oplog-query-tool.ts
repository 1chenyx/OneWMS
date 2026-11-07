import type { ToolDefinition } from '../bus/tool-bus.js';
import type { OplogStore } from './oplog-store.js';

/**
 * core.oplog.query —— 审计账本只读查询（事件是唯一真相，§8）。
 *
 * 边界：只读，不产生任何事件；append-only 账本没有删改路径。
 * 消费者是 AI（用户问「今天做了什么操作」「AI 助手动过哪些数据」），
 * 结果按分页壳裁剪：行只带识别字段 + payloadSummary（300 字符），
 * 不回全文——大 payload 装进 LLM 上下文就是污染。
 * 注册先例同 profile.propose（core.ts 构造器，OneCore 自注册）。
 */
export function createOplogQueryTool(store: OplogStore): ToolDefinition {
  return {
    id: 'core.oplog.query',
    label: '查询操作日志',
    description:
      '查询系统操作日志（审计账本：谁在何时做了什么，每条记录一次事件）。' +
      'type 是事件类型精确匹配（如 wms.inventory.adjusted）；typePrefix 是前缀匹配（如 "wms.order." 查该域全部事件，二选一）。' +
      'actor 是操作者（ai:general 等 ai: 前缀 = AI 助手操作；node-xxx = 本地节点/界面操作）。' +
      'from/to 是 ISO 时间（YYYY-MM-DD 或完整时间戳）的闭区间。' +
      '最新在前；limit 默认 20（上限 200）、offset 翻页；返回 { total, limit, offset, hasMore, rows }。' +
      '每行含 eventId / type / actor / createdAt / lamport / payloadSummary（事件内容摘要，300 字符）。纯读操作。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '事件类型（精确匹配，如 wms.inventory.adjusted）' },
        typePrefix: { type: 'string', description: '事件类型前缀（如 "wms.order." 命中该域全部事件）' },
        actor: { type: 'string', description: '操作者（如 ai:general、node-xxx）' },
        from: { type: 'string', description: '起始时间（ISO，含）' },
        to: { type: 'string', description: '结束时间（ISO，含）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页行数（缺省 20）' },
        offset: { type: 'integer', minimum: 0, description: '跳过行数（缺省 0，翻页用）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const p = params as {
        type?: string;
        typePrefix?: string;
        actor?: string;
        from?: string;
        to?: string;
        limit?: number;
        offset?: number;
      };
      const limit = p.limit ?? 20;
      const offset = p.offset ?? 0;
      const { rows, total } = store.listEventsPage(ctx.workspaceId, {
        type: p.type || undefined,
        typePrefix: p.typePrefix || undefined,
        actor: p.actor || undefined,
        from: p.from || undefined,
        to: p.to || undefined,
        limit,
        offset,
      });
      return {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
        rows: rows.map((env) => ({
          eventId: env.eventId,
          type: env.type,
          actor: env.actor,
          createdAt: env.createdAt,
          lamport: env.lamport,
          payloadSummary: JSON.stringify(env.payload ?? null).slice(0, 300),
        })),
      };
    },
  };
}
