import type { ModuleManifest } from '@one/core';

/**
 * module.partial —— 短收短发。
 *
 * 不新增状态、不改默认效应。启用后，会改库存的转移可以按行声明
 * 不大于订单数量的实收/实发；不声明则仍按订单数量整单入账。
 * 停用后拒绝改少，历史已入账的数量保留，冲销仍按已入账数量回退。
 * 拣货关单不走这条路径，仍要求拣满。
 */
export function partialManifest(): ModuleManifest {
  return {
    id: 'module.partial',
    name: '短收短发',
    description:
      '收货或发货时可以按行录入少于订单数量的实收/实发，库存按实数入账，订单数量保留。不录入则按订单数量整单入账。停用本模块后不能再改少，已入账的历史不变，冲销仍按已入账数量。拣货关单仍要求拣满，不在本模块范围内。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
  };
}
