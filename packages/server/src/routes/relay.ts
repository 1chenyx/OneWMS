import { Hono } from 'hono';
import { CoreError } from '@one/core';
import type { AppContext } from '../context.js';
import { runRelayRound } from '../relay/relay-client.js';

/**
 * 中继回合触发端点（DESIGN §8.8，里程碑 7）。
 * 密钥预检在路由层（缺失 → 400 RELAY_NO_KEY，提示先生成/导入）；
 * 传输编排在 relay-client；密文错误（CRYPTO_ERROR 等）交给全局错误映射。
 */
export function relayRoutes(ctx: AppContext): Hono {
  return new Hono().post('/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { relay?: unknown };
    const relay = String(body.relay ?? process.env.ONE_RELAY_URL ?? '').trim();
    if (!relay) {
      return c.json(
        { code: 'RELAY_NO_URL', message: '未配置中继地址（body.relay 或 ONE_RELAY_URL）' },
        400,
      );
    }
    if (!ctx.core.keys.get(ctx.workspaceId)) {
      return c.json(
        {
          code: 'RELAY_NO_KEY',
          message: '未配置工作区密钥（先 POST /api/keys 生成，或 POST /api/keys/import 导入）',
        },
        400,
      );
    }
    try {
      return c.json(
        await runRelayRound({
          relayBaseUrl: relay,
          workspaceId: ctx.workspaceId,
          core: ctx.core,
          ws: ctx.ws,
        }),
      );
    } catch (err) {
      // CoreError（如解密失败的 CRYPTO_ERROR）交给全局映射；网络等环境错误按 400 回传
      if (err instanceof CoreError) throw err;
      return c.json(
        { code: 'RELAY_ROUND_ERROR', message: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });
}
