import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { OplogStore } from '../oplog/oplog-store.js';
import { AI_RESULT_MAX_BYTES, fitResultForAi } from '../bus/ai-result-guard.js';
import type { ToolBus, ToolContext, ToolDefinition } from '../bus/tool-bus.js';

/**
 * 工具总线的工作区绑定视图（ToolsView）。
 *
 * 除参数绑定外做两件事：
 *  1. 构造 ToolContext 注入 appendEvent——工具写业务事件的**受控入口**
 *     （工具只能经此落账，拿不到数据库句柄）；
 *  2. 幂等去重：params 里带 idempotencyKey 时，同 (工具, 键) 的二次提交
 *     直接回放首次结果，不进 handler——UI 双击、AI 重试、网络重发都不会
 *     把同一笔业务落两遍账（重复扣减/重复移库这类事故的调用层防线）。
 */

/** 调用方在 params 里带这个字段即启用幂等（本类消费后剥离，handler 看不到） */
export const IDEMPOTENCY_KEY_PARAM = 'idempotencyKey';

export class ToolsView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly bus: ToolBus,
    private readonly oplog: OplogStore,
    private readonly db: SqliteDatabase,
  ) {}

  /** 注册工具（注册表全工作区共享——工具是代码） */
  register(tool: ToolDefinition): void {
    this.bus.register(tool);
  }

  unregister(toolId: string): void {
    this.bus.unregister(toolId);
  }

  /** 元数据列表（handler 不可见，AI 上下文安全） */
  list(): Omit<ToolDefinition, 'handler'>[] {
    return this.bus.listTools();
  }

  /** 调用工具；actor 默认本节点，AI 调用时传 'ai:xxx'（审计可追溯） */
  async invoke(toolId: string, params: unknown, actor = this.nodeId): Promise<unknown> {
    const ctx: ToolContext = {
      workspaceId: this.workspaceId,
      actor,
      appendEvent: (type: string, payload: unknown) =>
        this.oplog.append({ workspaceId: this.workspaceId, actor, type, payload }),
    };
    const key = readIdempotencyKey(params);
    if (key === null) return this.bus.invoke(toolId, params, ctx);

    const { [IDEMPOTENCY_KEY_PARAM]: _dropped, ...effective } = params as Record<string, unknown>;
    const cached = this.db
      .prepare(
        `SELECT result_json FROM tool_idempotency
         WHERE workspace_id = ? AND tool_id = ? AND idem_key = ?`,
      )
      .get(this.workspaceId, toolId, key) as { result_json: string } | undefined;
    if (cached) return this.#fitForActor(JSON.parse(cached.result_json), actor);

    const result = await this.bus.invoke(toolId, effective, ctx);
    // 只缓存成功：业务拒绝/异常不钉死在一个键上，调用方修好参数还能用同键重试
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_idempotency (workspace_id, tool_id, idem_key, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.workspaceId, toolId, key, JSON.stringify(result ?? null), new Date().toISOString());
    return result;
  }

  /** 缓存里存的是首次调用的结果；命中时按当前 actor 再过一次 AI 上下文守门 */
  #fitForActor(result: unknown, actor: string): unknown {
    if (typeof actor === 'string' && actor.startsWith('ai:')) {
      return fitResultForAi(result, AI_RESULT_MAX_BYTES);
    }
    return result;
  }
}

/** 取出幂等键：只认非空字符串；没带（或不是对象 params）返回 null = 不去重 */
function readIdempotencyKey(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const raw = (params as Record<string, unknown>)[IDEMPOTENCY_KEY_PARAM];
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key === '' ? null : key;
}
