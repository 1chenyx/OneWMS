import type { Context } from 'hono';
import type { AppContext } from './context.js';
import type { PublicUser } from './rbac/auth-store.js';

/**
 * 人操作 actor 的唯一解析点。
 *
 * 单机版没有登录，记为 `user:local@{nodeId}`。oplog 的
 * `(workspace_id, actor, seq)` 要求每个通道只有一个写者。
 *
 * 启用了 module.rbac 且请求带有效会话时，记登录人的账号
 * （`user:{username}@{nodeId}`）——谁做的每一步都要能在操作日志里查到。
 *
 * 平台进程设置 `ONE_TRUST_ACTOR_HEADER=1` 后，才读取它自己写入的
 * `x-one-user-id` 与 `x-one-node-id`，拼成 `user:{userId}@{nodeId}`。
 * 这两个头都是 uuid。客户端直接带来的头，在单机版里被忽略。
 *
 * 已落盘的 `user:local` 事件不改写。
 */
const ACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveActor(ctx: AppContext, c: Context): string {
  if (process.env.ONE_TRUST_ACTOR_HEADER === '1') {
    const userId = c.req.header('x-one-user-id')?.trim() ?? '';
    const nodeId = c.req.header('x-one-node-id')?.trim() ?? '';
    if (ACTOR_ID.test(userId) && ACTOR_ID.test(nodeId)) return `user:${userId}@${nodeId}`;
  }
  // 鉴权中间件只在 rbac 启用时才写入 authUser；停用时这里恒为 undefined
  const authed = c.get('authUser') as PublicUser | undefined;
  if (authed?.username) return `user:${authed.username}@${ctx.core.nodeId}`;
  return `user:local@${ctx.core.nodeId}`;
}
