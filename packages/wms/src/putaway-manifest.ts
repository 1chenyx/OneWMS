import type { ModuleManifest, ToolDefinition } from '@one/core';

/** 工具定义 → manifest 声明（剥离 handler；与 wms-manifest 同款） */
function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * module.putaway manifest（M21）——上架作业模块。
 *
 * 「流程可配置」的第一个真实模块消费：向既有 inbound 流程**贡献**状态与转移
 * （模块不创建流程，§6.3），收货落账语义零破坏：
 *  - states: putaway（已上架，providedBy=module.putaway——卸载时按此摘除）；
 *  - transitions: received→putaway 挂 when: module.putaway.enabled（停用即
 *    转移不可达，回到 created→received→done 老流程）；putaway→done 无条件。
 * 工具不进 core.wms 的 tools 数组（双声明冲突）——单独在本 manifest 声明。
 * 卸载/停用语义：停用 = 转移被 when 过滤；卸载 = providedBy 摘除状态与两端
 * 转移（module-registry 从数据推导，无需本文件在场）。
 */
export function putawayManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'module.putaway',
    name: '上架作业',
    description:
      '入库流程的可选上架步骤：收货（received）之后确认上架并归位到目标库位。收货落账行为不变——上架只是确认 + 改派目标库位（一对移库流水，批次/效期保留）。停用本模块后入库流程回到「收货即完成」的老流程，历史单据数据不受影响。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    tools: toolDefs.map((tool) => detachHandler(tool)),
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'putaway', label: '已上架' }],
          transitions: [
            { from: 'received', to: 'putaway', when: 'module.putaway.enabled' },
            { from: 'putaway', to: 'done' },
          ],
        },
      },
    },
  };
}
