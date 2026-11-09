import type { ModuleManifest, PatchOp, WorkflowDef } from '@one/core';

/** 进入拣货的边。停用模块后这条边不再生效。 */
export const PICKING_ENTRY_WHEN = 'module.picking.enabled';

/** 建单直接发货。只在拣货模块未启用时生效。 */
export const PICKING_BYPASS_WHEN = '!module.picking.enabled';

/**
 * module.picking —— 出库拣货步骤。
 *
 * 拣货状态本来就在 outbound 基础流程里，模块不能再贡献同名状态。
 * 本模块只提供开关：启用时 created→picking 可走；停用时 created→shipped 可走。
 * picking→shipped 与 picking→canceled 不挂 when，已经在拣货中的单仍可发货或取消。
 * 直接发货按发货的库存约定预检并扣减，不产生拣货占用。
 */
export function pickingManifest(): ModuleManifest {
  return {
    id: 'module.picking',
    name: '拣货',
    description:
      '出库的拣货步骤。启用后，出库单从已创建进入拣货中（只预检余量，不扣库存），再发货时扣减；拣货单页可用。停用后，新的出库单从已创建直接发货，发货时预检并扣减。已经在拣货中的单仍可发货或取消。未关的拣货单可继续做完或取消。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['拣货'],
  };
}

/**
 * 把老的出库流程补成可开关。
 * 只补两处：created→picking 还没有 when 时挂上模块开关；还没有 created→shipped 时补上绕行边。
 * 已经改过的边不动。返回 null 表示不用写配置。
 */
export function outboundPickingPatch(workflow: WorkflowDef): PatchOp[] | null {
  const transitions = workflow.transitions.map((edge) => ({ ...edge }));
  let changed = false;
  const entry = transitions.find((edge) => edge.from === 'created' && edge.to === 'picking');
  if (entry && !entry.when) {
    entry.when = PICKING_ENTRY_WHEN;
    changed = true;
  }
  const bypass = transitions.some((edge) => edge.from === 'created' && edge.to === 'shipped');
  const hasEnds = workflow.states.some((state) => state.id === 'created') && workflow.states.some((state) => state.id === 'shipped');
  if (!bypass && hasEnds) {
    transitions.push({ from: 'created', to: 'shipped', when: PICKING_BYPASS_WHEN });
    changed = true;
  }
  if (!changed) return null;
  return [{ op: 'replace', path: '/workflows/outbound/transitions', value: transitions }];
}
