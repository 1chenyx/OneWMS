import type { ModuleManifest } from '@one/core';

/**
 * module.routing —— 动态改道（骨架，见 docs/ROADMAP.md §3.2）。
 *
 * 不新建流程、不贡献状态：改道是既有上架 / 移库目标库位的运行期覆盖，
 * 越库是入库收货后的特殊去向（暂存区直扣出库需求，不进存储位）。
 * 实现期补：改道指令表、越库标记字段与收货分支、撤销逻辑。
 */
export function routingManifest(): ModuleManifest {
  return {
    id: 'module.routing',
    name: '动态改道',
    description:
      '作业执行中的目的地改道。启用后，上架与移库的目标库位可以临时改道，改道要记原因（爆满 / 越库 / 借道），未执行前可以撤销；入库单或到货预报可以标记直发：收货后不进存储位，暂存区直接对出库需求扣减。停用本模块后目标库位回到静态规则；未执行的改道作废，按原目标走。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['改道', '越库'],
    tools: [
      {
        id: 'wms.routing.divert',
        label: '生成改道',
        description:
          '给一张单（上架 / 移库 / 入库）的目标库位下改道指令：记原因与新目的地。改道只影响尚未执行的作业，已按原目标完成的不能改',
        parameters: {
          type: 'object',
          properties: {
            refNo: { type: 'string', description: '单号（入库单 / 调拨单 / 拣货回执号）' },
            reason: { type: 'string', enum: ['full', 'crossdock', 'detour'], description: '爆满 / 越库 / 借道' },
            toLocationCode: { type: 'string', description: '新目标库位' },
          },
          required: ['refNo', 'reason', 'toLocationCode'],
        },
        permission: 'write',
      },
      {
        id: 'wms.routing.cancel',
        label: '撤销改道',
        description: '撤销一条未执行的改道指令，作业回到原目标库位。已执行的拒绝撤销',
        parameters: {
          type: 'object',
          properties: {
            refNo: { type: 'string', description: '单号' },
          },
          required: ['refNo'],
        },
        permission: 'write',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          allowCrossdock: {
            type: 'boolean',
            description:
              '允不允许标记直发（越库）。开着时入库单 / 预报单可以标直发；关着只允许爆满与借道两种改道。改这一项走 profile.propose，路径 /modules/module.routing/settings/allowCrossdock',
            default: true,
          },
        },
      },
    },
  };
}
