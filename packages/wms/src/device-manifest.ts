import type { ModuleManifest } from '@one/core';

/**
 * module.device —— 设备接口（骨架占位，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程，不贡献状态。当前版本只建设备档案与事件映射表，
 * 不做真实协议对接（电子秤 / DWS / 立库的对接走集成扩展）。
 * 实现期补：设备表、心跳检测、事件 → 工具入参源的映射消费。
 */
export function deviceManifest(): ModuleManifest {
  return {
    id: 'module.device',
    name: '设备接口',
    description:
      '外部设备的接入通道（占位）。启用后，可以登记设备（电子秤 / DWS / 立库等）与连接方式，把设备事件映射到工具入参源进总线；有心跳与离线提示。当前版本只建档案与映射表，不做真实协议对接，对接由集成扩展补。停用本模块后设备事件不再消费；设备档案与历史保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['设备', '外设'],
    records: [
      {
        id: 'device',
        label: '设备',
        aliases: ['外设'],
        note: '设备档案。占位：只登记与映射，不做协议对接。这些是固定列，不能增删。',
        fields: [
          { key: 'deviceNo', label: '编号', description: '全库唯一' },
          { key: 'name', label: '名称', description: '如 1 号电子秤' },
          { key: 'type', label: '类型', description: 'scale 电子秤、dws DWS、vlm 立库' },
          { key: 'connection', label: '连接方式', description: '占位：HTTP 回调 / 串口（未实现）' },
          { key: 'mapping', label: '事件映射', description: 'JSON：设备事件 → 工具入参源的路由表' },
          { key: 'lastHeartbeat', label: '最近心跳', description: '超时未心跳在设备页标离线' },
          { key: 'status', label: '状态', description: '启用或停用。停用后事件不消费' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.device.list',
        label: '查设备',
        description: '查设备清单与在线状态（最近心跳）',
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
