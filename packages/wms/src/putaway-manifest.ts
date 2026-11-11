import type { ModuleManifest, PatchOp, ToolDefinition, WorkflowDef } from '@one/core';

/** 进入上架的边。停用模块后这条边不再生效。 */
export const PUTAWAY_ENTRY_WHEN = 'module.putaway.enabled';

/** 收货直接完成。只在上架模块未启用时生效。 */
export const PUTAWAY_BYPASS_WHEN = '!module.putaway.enabled';

/** 工具定义 → manifest 声明（剥离 handler；与 wms-manifest 同款） */
function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.putaway —— 入库上架步骤。
 *
 * 向既有 inbound 流程贡献状态与转移（模块不创建流程）：
 *  - states: putaway（已上架，providedBy=module.putaway——卸载时按此摘除）；
 *  - transitions: received→putaway 挂 when: module.putaway.enabled；
 *    putaway→done 无条件，已经上架的单在停用后仍可收尾。
 * 收货落账不变。启用后，已收货不能直接完成，上架用 wms.order.putaway
 * （纯确认或归位）。基础边 received→done 挂 !module.putaway.enabled，
 * 由种子和 inboundPutawayPatch 写上，不在本贡献里重复声明。
 * 工具不进 core.wms 的 tools 数组（双声明冲突）——单独在本 manifest 声明。
 */
export function putawayManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.putaway',
    name: '上架作业',
    description:
      '入库的上架步骤。启用后，已收货的入库单必须先上架才能完成，上架在上架页做：可以只确认，也可以把货从收货库位移到目标库位。停用后，新的入库单收货后直接完成。已经上架的单仍可完成。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['上架'],
    tools: toolDefs.map((tool) => detachHandler(tool)),
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'putaway', label: '已上架' }],
          transitions: [
            { from: 'received', to: 'putaway', when: PUTAWAY_ENTRY_WHEN },
            { from: 'putaway', to: 'done' },
          ],
        },
      },
    },
  };
}

/**
 * 把老的入库流程补成可开关。
 * 只补一处：received→done 还没有 when 时挂上「上架未启用才走」。
 * 已经改过的边不动。返回 null 表示不用写配置。
 */
export function inboundPutawayPatch(workflow: WorkflowDef): PatchOp[] | null {
  const transitions = workflow.transitions.map((edge) => ({ ...edge }));
  const bypass = transitions.find((edge) => edge.from === 'received' && edge.to === 'done');
  if (!bypass || bypass.when) return null;
  bypass.when = PUTAWAY_BYPASS_WHEN;
  return [{ op: 'replace', path: '/workflows/inbound/transitions', value: transitions }];
}
