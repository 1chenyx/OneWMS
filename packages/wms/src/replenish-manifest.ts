import type { ModuleManifest, ToolDefinition } from '@one/core';
import { ORDER_REPLENISH_FIELD, extraRecord } from './builtin-records.js';

/** 工具定义 → manifest 声明（剥离 handler；与 putaway 同款） */
function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.replenish —— 补货。
 *
 * 不新建流程，也不向 inbound 贡献状态。低库存预警仍是 core 的读工具。
 * 本模块只多一个命令：按缺口开一张普通入库单。停用后这条命令拒绝，预警还在。
 * 工具不进 core.wms 的 tools 数组（双声明冲突）。
 */
export function replenishManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.replenish',
    name: '补货',
    description:
      '按安全库存缺口开一张入库单。缺口 = 安全库存 − 可用量 − 尚未收货的入库数量。开出的是普通入库单，收货时才加库存。停用本模块后不能再生成补货单；低库存预警仍在；已经开出的入库单仍可收货。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['补货单'],
    records: [extraRecord('order', '单据', [ORDER_REPLENISH_FIELD])],
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
