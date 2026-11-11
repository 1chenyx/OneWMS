import type { Context } from 'hono';
import type { AppContext } from './context.js';

/**
 * 人操作 actor 的唯一解析点（扩展性方案 Phase 0.2：审计口子）。
 *
 * **今天**：本仓库（单机版 / 私有部署服务器版）没有任何认证中间件，所有人类操作
 * 统一记为 `user:local@{nodeId}`。节点后缀不是装饰——oplog 的
 * `(workspace_id, actor, seq)` 唯一约束要求每个同步通道单写者。
 *
 * **将来**：私有部署版本身就有多用户（局域网多个瘦客户端连同一锚点节点，
 * 「谁改的库存」是真实审计需求）。届时只改这里——从 `c.req` 取身份拼成
 * `user:{userId}@{nodeId}`，全部调用点一行不改。这也是把 `c` 现在就放进签名的
 * 唯一理由：不预留请求面，将来仍要改三十多处调用点。
 *
 * ③ SaaS 平台版另起代码但复用账本模型，actor 命名规范必须跨代码库一致。
 *
 * ⚠️ 账本不可变：已落盘的 `user:local` 事件永远洗不掉，本函数只能影响新事件。
 * 改历史事件 = 破坏账本完整性 = 同步指纹全变，绝对禁止。
 *
 * @param c 触发本次写操作的 HTTP 上下文（身份尚未接入，占位以固定调用点签名）
 */
export function resolveActor(ctx: AppContext, c: Context): string {
  void c; // 身份接入前不读请求——占位，保证调用点签名稳定
  return `user:local@${ctx.core.nodeId}`;
}
