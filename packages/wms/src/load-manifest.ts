import type { ModuleManifest } from '@one/core';

/** 进入装车。停用后这几条进入边不再生效。发货边留下，已经装车的单仍可发货。 */
export const LOAD_ENTRY_WHEN = 'module.load.enabled';

/**
 * module.load —— 出库装车。
 *
 * 启用后，打包之后（打包关着则在已拣货、已组波或已创建）要先装车，才能发货。
 * 装车本身不扣库存。拣货已经扣过的，发货不再扣；还没扣过的，发货才扣。
 * 停用后，新的单跳过装车。已经装车的单仍可发货。
 */
export function loadManifest(): ModuleManifest {
  return {
    id: 'module.load',
    name: '装车',
    description:
      '出库的装车步骤。启用后，必须先在装车页确认装车，才能发货。打包开着时，打包后装车；打包关着时，从已拣货、已组波或已创建装车。装车不扣库存。拣货已经扣过的，发货不再扣。停用后，新的出库单跳过装车。已经装车的单仍可发货。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['装车'],
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'loaded', label: '已装车' }],
          transitions: [
            { from: 'packed', to: 'loaded', when: LOAD_ENTRY_WHEN, effect: 'none' },
            { from: 'picked', to: 'loaded', when: LOAD_ENTRY_WHEN, effect: 'none' },
            { from: 'waved', to: 'loaded', when: LOAD_ENTRY_WHEN, effect: 'none' },
            { from: 'created', to: 'loaded', when: LOAD_ENTRY_WHEN, effect: 'none' },
            { from: 'loaded', to: 'shipped' },
          ],
        },
      },
    },
  };
}
