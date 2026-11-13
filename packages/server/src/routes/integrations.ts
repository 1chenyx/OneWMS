import { Hono } from 'hono';
import {
  IntegrationQueue,
  IntegrationSecretStore,
  catchUpOutbound,
  loadIntegrationSettings,
  pollInbound,
  pushDue,
  receiveWebhook,
  validateIntegrationSettings,
} from '@one/wms';
import type { AppContext } from '../context.js';

/**
 * 外部系统入口：POST /api/integrations/:connectorId/:routeId。
 * 配置在 Profile 的 module.integration。密钥在本机库。写业务走工具总线。
 * 校验和密钥接口是单段路径，不会和两段的 webhook 撞上。
 * 收发由进程定时调用 runIntegrationRound，不在 webhook 这条路由里。
 */
export function integrationRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/check', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = validateIntegrationSettings(body);
    if (!parsed.ok) return c.json({ ok: false, issues: parsed.issues });
    return c.json({ ok: true });
  });

  app.get('/secrets', (c) => {
    const names = secretStore(ctx).names(c.req.query('connectorId') ?? '');
    return c.json({ names });
  });

  app.put('/secrets', async (c) => {
    const body = await readSecretBody(c);
    if (!body) return c.json({ code: 'BAD_QUERY', message: '密钥请求不是对象' }, 400);
    if (typeof body.value !== 'string') return c.json({ code: 'INTEGRATION_SECRET', message: '密钥不能为空' }, 400);
    secretStore(ctx).put(body.connectorId, body.name, body.value);
    return c.json({ ok: true });
  });

  app.delete('/secrets', async (c) => {
    const body = await readSecretBody(c);
    if (!body) return c.json({ code: 'BAD_QUERY', message: '密钥请求不是对象' }, 400);
    secretStore(ctx).delete(body.connectorId, body.name);
    return c.json({ ok: true });
  });

  app.post('/:connectorId/:routeId', async (c) => {
    const loaded = loadIntegrationSettings(ctx.ws.profile.getSnapshot().modules);
    if (!loaded.ok) return c.json({ ok: false, code: loaded.code, message: loaded.message }, loaded.status);

    const text = await c.req.text();
    let body: unknown;
    if (text.trim() === '') {
      body = undefined;
    } else {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return c.json({ ok: false, code: 'MAP_SOURCE', message: '报文不是 JSON' }, 422);
      }
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const db = ctx.core.exposeDb();
    const result = await receiveWebhook({
      settings: loaded.settings,
      connectorId: c.req.param('connectorId'),
      routeId: c.req.param('routeId'),
      headers,
      body,
      secrets: new IntegrationSecretStore(db, ctx.workspaceId),
      queue: new IntegrationQueue(db, ctx.workspaceId),
      codes: codeSource(ctx),
      invoke: (toolId, params) => ctx.ws.tools.invoke(toolId, params, `integration:${c.req.param('connectorId')}`),
    });
    return c.json(result.body, result.status);
  });

  return app;
}

/** 拉取到点的入站，再扫新事件并发送到点的出站。没有对接配置时什么都不做。 */
export async function runIntegrationRound(ctx: AppContext): Promise<void> {
  const loaded = loadIntegrationSettings(ctx.ws.profile.getSnapshot().modules);
  if (!loaded.ok) return;
  const db = ctx.core.exposeDb();
  const queue = new IntegrationQueue(db, ctx.workspaceId);
  const secrets = new IntegrationSecretStore(db, ctx.workspaceId);
  const codes = codeSource(ctx);
  const polled = await pollInbound({
    settings: loaded.settings,
    queue,
    secrets,
    codes,
    invoke: (connectorId, toolId, params) => ctx.ws.tools.invoke(toolId, params, `integration:${connectorId}`),
  });
  const caught = catchUpOutbound({
    ws: ctx.ws,
    settings: loaded.settings,
    queue,
    codes,
  });
  const pushed = await pushDue({
    ws: ctx.ws,
    settings: loaded.settings,
    queue,
    secrets,
  });
  if (polled.fetched > 0 || polled.accepted > 0 || polled.failed > 0) {
    console.log(`[one-server] 对接入站：拉取 ${polled.fetched}，接受 ${polled.accepted}，失败 ${polled.failed}`);
  }
  if (caught.enqueued > 0 || caught.skipped.length > 0 || pushed.sent > 0 || pushed.failed > 0) {
    const held = caught.skipped.length > 0 ? `，映射未过 ${caught.skipped.length}` : '';
    console.log(`[one-server] 对接出站：入队 ${caught.enqueued}，发出 ${pushed.sent}，失败 ${pushed.failed}${held}`);
  }
}

/** 先追账，再按连接器查编码投影。对照不在连接器 JSON 里。 */
function codeSource(ctx: AppContext) {
  ctx.ws.sync();
  return (connectorId: string) => ctx.ws.codes.lookup(connectorId);
}

function secretStore(ctx: AppContext): IntegrationSecretStore {
  return new IntegrationSecretStore(ctx.core.exposeDb(), ctx.workspaceId);
}

async function readSecretBody(c: { req: { json: () => Promise<unknown> } }): Promise<{ connectorId: string; name: string; value?: unknown } | undefined> {
  const body = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return {
    connectorId: typeof record.connectorId === 'string' ? record.connectorId : '',
    name: typeof record.name === 'string' ? record.name : '',
    value: record.value,
  };
}
