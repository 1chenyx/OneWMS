import type { ModuleManifest } from '@one/core';

/**
 * module.reservation —— 拣货占用。
 *
 * 不新增状态。启用后，出库单进入只预检的转移（缺省 picking）时按行占用可用量，
 * 物理库存仍到发货才扣。发货或取消释放占用。停用后新的拣货不再占用；
 * 已经占用的数量保留到发货或取消。调整、移库、盘点不看占用。
 */
export function reservationManifest(): ModuleManifest {
  return {
    id: 'module.reservation',
    name: '拣货占用',
    description:
      '出库单进入拣货时按行占用可用量，其他出库单不能再拿走这部分货；物理库存仍在发货时扣减。发货或取消拣货中的单据会释放占用。不经过拣货、直接发货的单据不产生占用。停用本模块后，新的拣货不再占用，已有占用保留到发货或取消。手工调整、移库和盘点不看占用。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
  };
}
