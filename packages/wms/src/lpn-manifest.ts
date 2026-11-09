import type { ModuleManifest, ToolDefinition } from '@one/core';
import { LPN_RECORD } from './builtin-records.js';

function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.lpn —— 托盘。
 *
 * 不新建流程，也不改库存主键。托盘是库位上的搬运单元，占用已有桶里的件数。
 * 停用后不能再装托或整托移动；已经装好的记录还在，库存仍按库位收发。
 * 工具不进 core.wms 的 tools 数组。
 */
export function lpnManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.lpn',
    name: '托盘',
    description:
      '把已经在库位上的货装进托盘，再整托移到另一个库位。托盘不是新的库存桶，件数仍记在库位和批次上。停用本模块后不能再装托或按托盘移库；已经装好的托盘记录还在，库存仍按原来的库位收发。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['托'],
    records: [LPN_RECORD],
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
