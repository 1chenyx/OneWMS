import type { ModuleManifest } from '@one/core';

/** 建单后进入波次。停用后这条边不再生效。 */
export const WAVE_ENTRY_WHEN = 'module.wave.enabled';

/**
 * module.wave —— 出库波次。
 *
 * 启用后，已创建的出库单先到已组波，再拣货或发货。组波在波次页确认，不动库存。
 * 拣货开着时，已组波进入拣货中（只预检）。拣货关着时，已组波可以发货，发货才扣库存；
 * 打包或装车开着时，发货前仍要先走那两步。
 * 停用后，新的出库单从已创建直接拣货或发货。已经组波的单仍可拣货、发货或取消。
 */
export function waveManifest(): ModuleManifest {
  return {
    id: 'module.wave',
    name: '波次',
    description:
      '出库的组波步骤。启用后，已创建的出库单必须先在波次页确认组波，才能拣货或发货。组波不动库存。拣货开着时，组波后进入拣货中。拣货关着时，组波后继续打包、装车或发货。停用后，新的出库单从已创建直接拣货或发货。已经组波的单仍可继续或取消。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['波次', '组波'],
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'waved', label: '已组波' }],
          transitions: [
            { from: 'created', to: 'waved', when: WAVE_ENTRY_WHEN, effect: 'none' },
            { from: 'waved', to: 'picking', when: 'module.picking.enabled', effect: 'check' },
            { from: 'waved', to: 'canceled', effect: 'none' },
            { from: 'waved', to: 'shipped', when: '!module.picking.enabled' },
          ],
        },
      },
    },
  };
}
