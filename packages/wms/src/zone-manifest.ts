import type { ModuleManifest, ToolDefinition } from '@one/core';
import { LOCATION_ZONE_FIELD, ZONE_RECORD, extraRecord } from './builtin-records.js';
import { ZONE_KINDS } from './zone-kinds.js';

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
      '在库位之上增加库区，并给库区一个分类：收货区、质检区、存货区、拣货区、暂存区、发货区、退货区、不良品区。分类决定库位能做的事：收货区收货，存货区和拣货区上架，拣货区和发货区出库，退货区走退货。未分区不限制。用哪些分类由设置 enabledKinds 决定，缺省八种都开。关掉的分类不能新建，已有库区不再按这个分类限制作业。库位可以划进某个库区，库存仍记在库位上，库位编码全库唯一。不划的库位保持未分区。多仓打开时，库区可以属于一个仓库，库位的仓库要和库区一致。停用本模块后不能再新建库区或划区，分类也不再限制作业；已经划好的库位和库存仍留在原库位。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['库区分类', '分区', '拣货区', '存货区'],
    records: [ZONE_RECORD, extraRecord('location', '库位', [LOCATION_ZONE_FIELD])],
    tools: toolDefs.map((tool) => detachHandler(tool)),
    settings: {
      schema: {
        type: 'object',
        properties: {
          enabledKinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: ZONE_KINDS.map((kind) => kind.id),
            },
            description:
              '这个工作区启用哪些库区分类。词表固定：receiving 收货区、qc 质检区、storage 存货区、picking 拣货区、staging 暂存区、shipping 发货区、return 退货区、defective 不良品区。缺省八种都启用。空数组表示一种都不启用。关掉某一种后不能再新建这种库区，原来的库区还在，但不再限制收货、上架或发货；还开着的分类仍按各自规则限制。未分区和 DEFAULT 始终不限制。改这一项走 profile.propose，路径 /modules/module.zone/settings/enabledKinds，值是整份字符串数组。键还不存在时用 add，已经有了用 replace。确认后生效。',
            default: ZONE_KINDS.map((kind) => kind.id),
          },
        },
      },
    },
  };
}
