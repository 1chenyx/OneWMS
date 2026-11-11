import type { ModuleManifest } from '@one/core';

/** 进入复核。停用后这几条进入边不再生效。后面的边留下，已经复核的单仍可继续。 */
export const REVIEW_ENTRY_WHEN = 'module.review.enabled';

/**
 * module.review —— 出库复核。
 *
 * 启用后，拣货关单后的已拣货要先复核，才能打包、装车或发货。
 * 拣货关着时，从已创建或已组波进入复核。复核本身不扣库存。
 * 停用后，新的单跳过复核。已经复核的单仍可打包、装车或发货。
 */
export function reviewManifest(): ModuleManifest {
  return {
    id: 'module.review',
    name: '复核',
    description:
      '出库的复核步骤。启用后，必须先在复核页确认复核，才能打包、装车或发货。拣货开着时，拣货单关单进入已拣货并扣库存，再复核。拣货关着时，从已创建或已组波复核，发货才扣库存。复核不扣库存。停用后，新的出库单跳过复核。已经复核的单仍可继续。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    aliases: ['复核'],
    dependencies: { modules: ['core.wms'] },
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'reviewed', label: '已复核' }],
          transitions: [
            { from: 'picked', to: 'reviewed', when: REVIEW_ENTRY_WHEN, effect: 'none' },
            { from: 'waved', to: 'reviewed', when: REVIEW_ENTRY_WHEN, effect: 'none' },
            { from: 'created', to: 'reviewed', when: REVIEW_ENTRY_WHEN, effect: 'none' },
            { from: 'reviewed', to: 'packed', when: 'module.pack.enabled', effect: 'none' },
            { from: 'reviewed', to: 'loaded', when: 'module.load.enabled', effect: 'none' },
            { from: 'reviewed', to: 'shipped' },
          ],
        },
      },
    },
  };
}
