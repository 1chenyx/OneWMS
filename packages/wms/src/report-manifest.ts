import type { ModuleManifest, ToolDefinition } from '@one/core';

function detachHandler(tool: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = tool;
  return meta;
}

/**
 * module.report —— 自定义明细报表。
 *
 * 不改流程。停用后不能再保存或删除；已经保存的定义还在，重新启用后可以继续看。
 * 工具不进 core.wms 的 tools 数组。
 */
export function reportManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.report',
    name: '报表',
    description:
      '按自己要看的明细保存报表。一张报表里可以有多张表，每张表选定一行是什么，再连上客户、商品、库位这些字段。单据行和流水要先写上日期、商品、单号或客户。停用后不能再改报表；已经保存的还在。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['自定义报表', '明细报表'],
    tools: toolDefs.map((tool) => detachHandler(tool)),
  };
}
