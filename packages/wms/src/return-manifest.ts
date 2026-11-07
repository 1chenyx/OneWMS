import type { ModuleManifest } from '@one/core';

/**
 * module.return —— 退货。
 *
 * 不新增状态、不改库存效应。启用后，建单可以带 returnOf 指向原单：
 * 客退是入库单（原出库单已发货），退供是出库单（原入库单已收货）。
 * 停用后拒绝再开退货单；已经开出的退货单仍按入库/出库流转，历史保留。
 */
export function returnManifest(): ModuleManifest {
  return {
    id: 'module.return',
    name: '退货',
    description:
      '按原单退货。客退：对已发货的出库单开一张入库单，收货时把货加回。退供：对已收货的入库单开一张出库单，发货时把货扣走。数量按 SKU 和批次不能超过原单已入账、再减去还没取消的退货。库位可以和原单不同。停用本模块后不能再开新的退货单，已有退货单仍可继续收货或发货。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
  };
}
