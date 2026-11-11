import type { ModuleManifest } from '@one/core';

/** 建单后进入波次。停用后这条边不再生效。 */
export const WAVE_ENTRY_WHEN = 'module.wave.enabled';

/**
 * module.wave —— 出库波次。
 *
 * 启用后，已创建的出库单先收进一个波次，再拣货或发货。
 * 组波生成波次号，把勾上的单合成一波，并按库位把应拣数量加总。组波不动库存。
 * 拣货开着时，在波次页按整波生成一张拣货单。
 * 拣货开着时，已组波进入拣货中（只预检）。拣货关着时，已组波可以发货，发货才扣库存；
 * 打包或装车开着时，发货前仍要先走那两步。
 * 停用后，新的出库单从已创建直接拣货或发货。已经组波的单仍可拣货、发货或取消。
 */
export function waveManifest(): ModuleManifest {
  return {
    id: 'module.wave',
    name: '波次',
    description:
      '出库的组波步骤。启用后，已创建的出库单必须先在波次页收进一个波次，才能拣货或发货。组波生成波次号，按库位把这几张单的数量加总，不动库存。拣货开着时，在波次页按整波生成一张拣货单。拣货关着时，波次页仍给出按库位的拣货清单，各单再继续打包、装车或发货。停用后，新的出库单从已创建直接拣货或发货。已经组波的单仍可继续或取消。',
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
