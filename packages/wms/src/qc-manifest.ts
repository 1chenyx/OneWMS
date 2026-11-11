import type { ModuleManifest } from '@one/core';

/** 收货后进入质检。停用后这条边不再生效。 */
export const QC_ENTRY_WHEN = 'module.qc.enabled';

/**
 * module.qc —— 入库质检。
 *
 * 收货已经加库存。启用后，已收货要先到已质检，才能上架或完成。
 * 质检在质检页确认。上架仍开着时，已质检进入上架；上架关着时，已质检直接完成。
 * 停用后，新的入库单收货后按上架开关上架或完成。已经质检的单仍可继续。
 */
export function qcManifest(): ModuleManifest {
  return {
    id: 'module.qc',
    name: '质检',
    description:
      '入库的质检步骤。启用后，已收货的入库单必须先在质检页确认质检，才能上架或完成。上架开着时，质检后到上架页归位；上架关着时，质检后直接完成。停用后，新的入库单收货后按上架开关继续。已经质检的单仍可上架或完成。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['质检', '验收'],
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'inspected', label: '已质检' }],
          transitions: [
            { from: 'received', to: 'inspected', when: QC_ENTRY_WHEN, effect: 'none' },
            { from: 'inspected', to: 'putaway', when: 'module.putaway.enabled' },
            { from: 'inspected', to: 'done', when: '!module.putaway.enabled' },
          ],
        },
      },
    },
  };
}
