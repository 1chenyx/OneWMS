import type { ModuleManifest, PatchOp, WorkflowDef } from '@one/core';

/** 进入拣货的边。停用模块后这条边不再生效。 */
export const PICKING_ENTRY_WHEN = 'module.picking.enabled';

/** 建单直接发货。只在拣货模块未启用时生效。 */
export const PICKING_BYPASS_WHEN = '!module.picking.enabled';

/**
 * module.picking —— 出库拣货步骤。
 *
 * 拣货中本来就在 outbound 基础流程里，模块不再贡献同名状态。
 * 本模块贡献「已拣货」：启用时 created→picking，关单走 picking→picked（effect none，
 * 扣减由拣货关单自己写）；picked→shipped 无条件且 effect none，发货不再扣第二次。
 * 停用后 created→shipped 可走。picking→shipped 不挂 when，已经在拣货中的单仍可直接发货。
 * 启用时，不能用单据流转直接发货、标成已拣货或完成。
 */
export function pickingManifest(): ModuleManifest {
  return {
    id: 'module.picking',
    name: '拣货',
    description:
      '出库的拣货步骤。启用后，出库单从已创建进入拣货中（只预检余量，不扣库存），必须在拣货单详情里逐行拣完。关单后出库单进入已拣货，并按实拣扣减库存；再到出库单上发货，发货不再扣减。不能直接发货或完成。停用后，新的出库单从已创建直接发货，发货时预检并扣减。已经在拣货中的单仍可发货或取消，已经是已拣货的单仍可发货。未关的拣货单可继续做完或取消。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['拣货'],
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'picked', label: '已拣货' }],
          transitions: [
            { from: 'picking', to: 'picked', when: PICKING_ENTRY_WHEN, effect: 'none' },
            { from: 'picked', to: 'shipped', effect: 'none' },
          ],
        },
      },
    },
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

/**
 * 老库没有「已拣货」时补上。新库安装贡献已经写过，这里是空操作。
 * 状态和两条边都带 providedBy，卸载拣货模块时一起摘掉。
 */
export function outboundPickedPatch(workflow: WorkflowDef): PatchOp[] | null {
  const ops: PatchOp[] = [];
  if (!workflow.states.some((state) => state.id === 'picked')) {
    ops.push({
      op: 'add',
      path: '/workflows/outbound/states/-',
      value: { id: 'picked', label: '已拣货', providedBy: 'module.picking' },
    });
  }
  const hasEntry = workflow.transitions.some((edge) => edge.from === 'picking' && edge.to === 'picked');
  const hasShip = workflow.transitions.some((edge) => edge.from === 'picked' && edge.to === 'shipped');
  if (!hasEntry || !hasShip) {
    const transitions = workflow.transitions.map((edge) => ({ ...edge }));
    if (!hasEntry) {
      transitions.push({
        from: 'picking',
        to: 'picked',
        when: PICKING_ENTRY_WHEN,
        effect: 'none',
        providedBy: 'module.picking',
      });
    }
    if (!hasShip) {
      transitions.push({
        from: 'picked',
        to: 'shipped',
        effect: 'none',
        providedBy: 'module.picking',
      });
    }
    ops.push({ op: 'replace', path: '/workflows/outbound/transitions', value: transitions });
  }
  return ops.length > 0 ? ops : null;
}
