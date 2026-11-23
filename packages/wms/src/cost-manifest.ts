import type { ModuleManifest } from '@one/core';

/**
 * module.cost —— 库存成本（骨架，见 docs/ROADMAP.md §3.4）。
 *
 * 不新建流程，不贡献状态。商品加计价字段，出入库流水带金额，
 * 收发存汇总与盘点差异折金额。重估走成本调整单（慢通道确认）。
 * 实现期补：成本流水表、加权价计算、金额报表、调整单确认流。
 */
export function costManifest(): ModuleManifest {
  return {
    id: 'module.cost',
    name: '库存成本',
    description:
      '库存金额化。启用后，商品档案多出计价方式（移动加权平均或固定单价）与默认单价；入库行可以录单价（不录按商品默认价，两者都没有就不计价）；出库、报损、调拨按当时的加权平均价出成本流水；库存汇总和报表出现金额列；盘点差异自动折算金额影响；要重估走成本调整单，确认后生效。停用本模块后不再要求单价、金额列隐藏；已算好的成本流水保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['成本', '金额'],
    fields: {
      provides: [
        {
          entity: 'sku',
          key: 'valuation',
          label: '计价方式',
          type: 'string',
          description: 'moving_average 移动加权平均或 fixed 固定单价。缺省按模块设置',
        },
        { entity: 'sku', key: 'defaultPrice', label: '默认单价', type: 'number', description: '入库行没录单价时兜底。0 表示不兜底' },
      ],
    },
    tools: [
      {
        id: 'wms.cost.report',
        label: '成本报表',
        description:
          '查库存金额：按商品 / 分类 / 库区汇总数量、金额与单价；period 给了查区间的收发存汇总（进多少金额、出多少金额、存多少金额）',
        parameters: {
          type: 'object',
          properties: {
            groupBy: { type: 'string', enum: ['sku', 'category', 'zone'], description: '汇总维度' },
            period: { type: 'string', description: '区间，如 2026-11 或 2026-11-01~2026-11-30。缺省查当前余额' },
          },
          required: ['groupBy'],
        },
        permission: 'read',
      },
      {
        id: 'wms.cost.adjust',
        label: '成本调整',
        description:
          '手动重估一批商品的成本单价。生成成本调整单，走人工确认（慢通道）后按新价出调整流水，历史流水不动',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '调整原因，必写' },
            items: {
              type: 'array',
              description: '调整明细数组。元素 { skuCode, newPrice }',
              items: { type: 'object' },
            },
          },
          required: ['reason', 'items'],
        },
        permission: 'write',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          valuationDefault: {
            type: 'string',
            enum: ['moving_average', 'fixed'],
            description:
              '商品没单独设计价方式时用哪种。moving_average 移动加权平均；fixed 固定单价（按默认价）。已算过的流水不追溯。改这一项走 profile.propose，路径 /modules/module.cost/settings/valuationDefault',
            default: 'moving_average',
          },
        },
      },
    },
  };
}
