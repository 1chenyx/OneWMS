import type { ModuleManifest } from '@one/core';

/**
 * module.workstation —— 工位（骨架，见 docs/ROADMAP.md §3.4）。
 *
 * 需场景作业开着。不新建流程、不贡献状态：工位只是场景的过滤与外设绑定维度，
 * 动作记录带工位标识。打印按工位路由任务（模板渲染由集成扩展补）。
 * 实现期补：工位表、场景工位过滤、打印任务队列。
 */
export function workstationManifest(): ModuleManifest {
  return {
    id: 'module.workstation',
    name: '工位',
    description:
      '固定作业位与外设绑定。启用后（需场景作业开着），可以建工位（收货台 / 打包台 / 复核台 / 称重台），给工位配默认场景；现场设备选工位进入对应场景，之后的动作记录都带工位标识；条码标签与面单按工位路由打印任务。停用本模块后场景不再按工位过滤，工位档案与历史保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms', 'module.scenario'] },
    aliases: ['工位', '作业台'],
    records: [
      {
        id: 'workstation',
        label: '工位',
        aliases: ['作业台'],
        note: '工位档案。场景作业开着时，现场设备选工位进场景。这些是固定列，不能增删。',
        fields: [
          { key: 'stationNo', label: '编号', description: '全库唯一' },
          { key: 'name', label: '名称', description: '如 打包台 1' },
          { key: 'type', label: '类型', description: 'receiving 收货台、packing 打包台、review 复核台、weighing 称重台' },
          { key: 'defaultScenario', label: '默认场景', description: '选工位后直接进的场景' },
          { key: 'printer', label: '打印机', description: '绑定的打印机标识。标签 / 面单任务路由到这里' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.workstation.list',
        label: '查工位',
        description: '查工位清单：类型、默认场景、打印机绑定',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: '按类型筛' },
          },
        },
        permission: 'read',
      },
    ],
  };
}
