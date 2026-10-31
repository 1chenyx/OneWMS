import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/**
 * 工作区密钥端点（DESIGN §8.5 传输安全，里程碑 7）。
 *
 * 密钥交换是人工动作：export 取明文本体 → 用户经任意可信渠道交给新节点 → import。
 * 密钥是边界参数不是业务事实——不经事件、不参与同步，本文件只做参数解析与委托。
 */
export function keysRoutes(ctx: AppContext): Hono {
  return new Hono()
    // 生成（已存在 → 409 KEY_EXISTS，由错误映射中间件处理）
    .post('/', (c) => {
      const key = ctx.core.keys.generate(ctx.workspaceId);
      return c.json({ key: key.keyHex, fingerprint: key.fingerprint, createdAt: key.createdAt }, 201);
    })
    // 存在性 + 指纹 + 时间（不回密钥本体——展示面）
    .get('/', (c) => {
      const key = ctx.core.keys.get(ctx.workspaceId);
      return c.json(
        key
          ? { exists: true, fingerprint: key.fingerprint, createdAt: key.createdAt }
          : { exists: false },
      );
    })
    // 导出明文本体（本地可信域；人工交给新节点）
    .get('/export', (c) => {
      const key = ctx.core.keys.get(ctx.workspaceId);
      if (!key) {
        return c.json({ code: 'KEY_NOT_FOUND', message: '本工作区尚未生成密钥' }, 404);
      }
      return c.json({ key: key.keyHex, fingerprint: key.fingerprint, createdAt: key.createdAt });
    })
    // 导入（格式非法 → 400 CRYPTO_ERROR；已有 → 409 KEY_EXISTS）
    .post('/import', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
      if (typeof body.key !== 'string') {
        return c.json({ code: 'RELAY_BAD_REQUEST', message: 'key 必须是字符串' }, 400);
      }
      const key = ctx.core.keys.importKey(ctx.workspaceId, body.key);
      return c.json({ fingerprint: key.fingerprint, createdAt: key.createdAt });
    });
}
