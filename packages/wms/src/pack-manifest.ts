import type { ModuleManifest } from '@one/core';

/** 进入打包。停用后这几条进入边不再生效。发货边留下，已经打包的单仍可发货。 */
export const PACK_ENTRY_WHEN = 'module.pack.enabled';

/**
 * module.pack —— 出库打包。
 *
 * 启用后，拣货关单后的已拣货要先打包，才能装车或发货。
 * 拣货关着时，从已创建或已组波进入打包，打包本身不扣库存，发货才扣。
 * 拣货开着时，库存已在关单时扣过，打包和之后的发货不再扣第二次。
 * 停用后，新的单跳过打包。已经打包的单仍可装车或发货。
 */
export function packManifest(): ModuleManifest {
  return {
    id: 'module.pack',
    name: '打包',
    description:
      '出库的打包步骤。启用后，必须先在打包页确认打包，才能装车或发货。拣货开着时，拣货单关单进入已拣货并扣库存，再打包。拣货关着时，从已创建或已组波打包，发货才扣库存。停用后，新的出库单跳过打包。已经打包的单仍可装车或发货。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['打包'],
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'packed', label: '已打包' }],
          transitions: [
            { from: 'picked', to: 'packed', when: PACK_ENTRY_WHEN, effect: 'none' },
            { from: 'waved', to: 'packed', when: PACK_ENTRY_WHEN, effect: 'none' },
            { from: 'created', to: 'packed', when: PACK_ENTRY_WHEN, effect: 'none' },
            { from: 'packed', to: 'shipped' },
          ],
        },
      },
    },
  };
}
