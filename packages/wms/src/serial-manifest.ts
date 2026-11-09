import type { ModuleManifest, ToolDefinition } from '@one/core';
import { SERIAL_RECORD, SKU_SERIAL_FIELD, extraRecord } from './builtin-records.js';

function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.serial —— 序列号。
 *
 * 不新建流程，也不改库存主键。一个号对应一件货。
 * 停用后不能再登记序列号；已经记下的号还在，库存仍按数量收发。
 * 工具不进 core.wms 的 tools 数组。
 */
export function serialManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.serial',
    name: '序列号',
    description:
      '给需要一物一码的商品登记序列号。SKU 可以改成按序列号管理，之后收发、移库都要写上每一件的号。序列号不是库存桶，库存仍按库位和批次记数量。停用本模块后不能再登记序列号或把 SKU 改成按序列号管理；已经记下的号还在，库存仍按数量收发。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['一物一码'],
    records: [SERIAL_RECORD, extraRecord('sku', '商品', [SKU_SERIAL_FIELD])],
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
