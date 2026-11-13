import type { ModuleManifest, ToolDefinition } from '@one/core';
import { LOCATION_ZONE_FIELD, ZONE_RECORD, extraRecord } from './builtin-records.js';

function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.zone —— 库区。
 *
 * 不新建流程，也不改库存主键。库区是库位上的分类：拣货区、存货区等。
 * 停用后不能再新建库区，也不能把库位划进库区；已经划好的保持原样。
 * 工具不进 core.wms 的 tools 数组。
 */
export function zoneManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.zone',
    name: '库区',
    description:
      '在库位之上增加库区，并给库区一个分类：收货区、质检区、存货区、拣货区、暂存区、发货区、退货区、不良品区。库位可以划进某个库区，库存仍记在库位上，库位编码全库唯一。不划的库位保持未分区。多仓打开时，库区可以属于一个仓库，库位的仓库要和库区一致。停用本模块后不能再新建库区或划区；已经划好的库位和库存仍留在原库位。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['库区分类', '分区', '拣货区', '存货区'],
    records: [ZONE_RECORD, extraRecord('location', '库位', [LOCATION_ZONE_FIELD])],
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
