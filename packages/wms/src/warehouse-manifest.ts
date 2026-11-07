import type { ModuleManifest, ToolDefinition } from '@one/core';

function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.warehouse —— 多仓。
 *
 * 不新建流程，也不改库存主键。仓库是库位的上一层。
 * 停用后不能再新建仓库，也不能把库位划进仓库；已经划好的保持原样。
 * 工具不进 core.wms 的 tools 数组。
 */
export function warehouseManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.warehouse',
    name: '多仓',
    description:
      '在平铺库位之上增加仓库。库位可以划进某个仓库，库存仍记在库位上，库位编码全库唯一。不划仓的库位和虚拟库位 DEFAULT 保持未分仓。停用本模块后不能再新建仓库或划仓；已经划好的库位和库存仍留在原库位。低库存和补货仍按整个工作区计算。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
