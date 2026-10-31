import { serve } from '@hono/node-server';
import { createRelayApp } from './relay/relay-app.js';

/**
 * 云中继独立进程入口（DESIGN §8.8「轻量云中继，自建 VPS」，里程碑 7）。
 *
 * 零状态进程：内存暂存密文、不碰业务数据、不经手密钥——
 * E2E 加密下中继无需被信任，部署只需一个端口。
 * env：ONE_RELAY_PORT（默认 3900）。
 */
const port = Number(process.env.ONE_RELAY_PORT ?? 3900);
const app = createRelayApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `[one-relay] http://localhost:${info.port}  密文中继（内存暂存、重启自愈、不存业务数据）`,
  );
});
