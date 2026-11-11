import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { resolveActor } from '../actor.js';

/**
 * GET /api/profile/snapshot —— Profile 快照（确认界面的「现状」数据源）。
 * GET /api/profile/catalog —— 已安装模块的名字、说明和流程贡献。不含工具与参数。
 * POST /api/profile/propose —— 流程页、模块页的慢通道入口：
 * 经工具总线走 profile.propose（校验管线 + 影响报告免费），actor=user:local。
 * 与 AI 的提议同一队列（GET /api/proposals 待确认列表）；confirm/reject
 * 走 /api/proposals/:id/confirm|reject——确认权在用户，永不注册为工具（§4.1）。
 */
export function profileRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/snapshot', (c) => c.json(ctx.ws.profile.getSnapshot()))
    .get('/catalog', (c) => c.json(catalogOf(ctx)))
    .post('/propose', async (c) => {
      const body = (await c.req.json()) as { patch?: unknown; note?: string };
      return c.json(
        await ctx.ws.tools.invoke(
          'profile.propose',
          { patch: body.patch, note: body.note },
          resolveActor(ctx, c),
        ),
        201,
      );
    });
}

/** 给流程页用的薄目录。基础流程算仓储骨架，不算某个模块「贡献」出来的步骤。 */
function catalogOf(ctx: AppContext) {
  return {
    modules: ctx.ws.modules.listInstalled().map((installed) => {
      const manifest = installed.manifest;
      const contributes = manifest?.workflows?.contributes ?? {};
      return {
        id: installed.id,
        name: manifest?.name ?? installed.id,
        description: manifest?.description ?? '',
        system: installed.id.startsWith('core.'),
        contributions: Object.entries(contributes).map(([workflowKey, contribution]) => ({
          workflowKey,
          states: contribution.states.map((state) => ({ id: state.id, label: state.label })),
          transitions: contribution.transitions.map((edge) => ({
            from: edge.from,
            to: edge.to,
            ...(edge.when ? { when: edge.when } : {}),
            ...(edge.effect ? { effect: edge.effect } : {}),
          })),
        })),
      };
    }),
  };
}
