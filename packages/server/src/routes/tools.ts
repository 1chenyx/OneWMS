import { Hono } from 'hono';
import type { Context } from 'hono';
import { IDEMPOTENCY_KEY_PARAM, ToolNotFoundError, ToolValidationError } from '@one/core';
import type { AppContext } from '../context.js';
import { resolveActor } from '../actor.js';

/**
 * 通用工具调用端点（B.5）：按 `permission` 分流。
 *
 *  - `read`  → 直接执行。读操作不留痕，加闸门只是让人多点一次鼠标。
 *  - `write` → **只发令牌不执行**（202），前端弹确认框，用户点确认后
 *              调 `/confirm` 带令牌回来，此刻才落地。
 *
 * 这是「写操作暴露给前端」的唯一确认口。既有点名端点（/api/wms/*、/api/dyn/*）
 * 不走这里——它们各自有业务语义与既有前端契约，B.5 不去动（改动面决策见 §B.5）。
 * AI 通道也不走这里：AI 的写操作护栏是慢通道 propose→confirm（配置类）
 * 与幂等键（数据类），把每个 write 工具都插一次人工确认会直接毁掉对话体验。
 */
export function toolRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** 申请：read 直通执行，write 返回待确认令牌 */
  app.post('/:toolId/invoke', async (c) => {
    const toolId = c.req.param('toolId');
    const tool = requireTool(ctx, toolId);
    const params = readParams(await readBody(c));

    if (tool.permission === 'read') {
      const result = await ctx.ws.tools.invoke(toolId, params, resolveActor(ctx, c));
      return c.json({ pending: false, toolId, label: tool.label, result });
    }

    // ⚠️ 幂等键由令牌充当，调用方不许自带——否则「确认的那次」和「执行的那次」
    //    可能落在不同幂等键上，防双写就失效了。
    if (IDEMPOTENCY_KEY_PARAM in params) {
      throw new ToolValidationError(
        `params 不能自带 ${IDEMPOTENCY_KEY_PARAM}：确认令牌本身就是幂等键`,
      );
    }
    const pending = ctx.confirmations.issue({
      workspaceId: ctx.workspaceId,
      toolId,
      label: tool.label,
      params,
      actor: resolveActor(ctx, c),
    });
    // 202 而不是 200：让「还没执行」在状态码上就看得出来，
    // 只看 res.ok 的粗心客户端不会把它当成写成功。
    return c.json(
      {
        pending: true,
        token: pending.token,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        toolId,
        label: tool.label,
        permission: tool.permission,
        params: pending.params,
      },
      202,
    );
  });

  /** 确认：带令牌二次提交，此刻才真正执行 */
  app.post('/:toolId/confirm', async (c) => {
    const toolId = c.req.param('toolId');
    const tool = requireTool(ctx, toolId);
    if (tool.permission !== 'write') {
      throw new ToolValidationError(`工具 ${toolId} 是读操作，不需要确认——直接调 invoke`);
    }
    const raw = (await readBody(c)).token;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ToolValidationError('缺少确认令牌 token（先调 invoke 拿令牌）');
    }
    const pending = ctx.confirmations.consume(raw.trim(), {
      workspaceId: ctx.workspaceId,
      toolId,
    });
    // ⚠️ 执行用令牌里冻结的 params/actor，不用本次请求体里的任何东西：
    //    「确认的」和「执行的」必须是同一件事，否则确认框就只是装饰。
    const result = await ctx.ws.tools.invoke(
      toolId,
      { ...pending.params, [IDEMPOTENCY_KEY_PARAM]: pending.token },
      pending.actor,
    );
    return c.json({ pending: false, toolId, label: tool.label, result });
  });

  return app;
}

/** 工具不在总线上（未装模块 / id 打错）→ 404，与 dyn 端点的白名单纪律一致 */
function requireTool(ctx: AppContext, toolId: string) {
  const tool = ctx.ws.tools.list().find((t) => t.id === toolId);
  if (!tool) throw new ToolNotFoundError(`工具 ${toolId} 不存在（可能所属模块未安装）`);
  return tool;
}

/** 请求体：空 body 合法（无参工具），但不是 JSON 对象一律 400 */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolValidationError('请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolValidationError('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 取 params：缺省 = 空对象（无参工具）；给了但不是对象 → 400 */
function readParams(body: Record<string, unknown>): Record<string, unknown> {
  const params = body.params;
  if (params === undefined) return {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ToolValidationError('params 必须是 JSON 对象');
  }
  return params as Record<string, unknown>;
}
