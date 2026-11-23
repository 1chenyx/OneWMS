import type { ModuleManifest } from '@one/core';

/**
 * module.weighing —— 称重商品（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程，不贡献状态：称重商品复用既有出入库，只是数量口径从「件」换成「kg」
 * （步进 0.001，累加录入）。成本开着时按重计价（对 module.cost 的软联动，不进依赖）。
 * 实现期补：行重量录入与累加、kg 步进与显示、与 cost 的按重计价接线。
 */
export function weighingManifest(): ModuleManifest {
  return {
    id: 'module.weighing',
    name: '称重商品',
    description:
      '按重量收发的商品（生鲜类）。启用后，商品档案可以把商品标成称重商品：入库按实际称重录入（可以多件累加），出库按称重扣减，数量步进 0.001kg；成本开着时按重量计价。普通商品不受影响。停用本模块后不能再按重量收发新单，称重商品恢复按件；存量库存与流水保留。',
    version: '0.1.0',
    capabilities: ['db.read'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['称重', '生鲜'],
    fields: {
      provides: [
        {
          entity: 'sku',
          key: 'isWeighing',
          label: '称重商品',
          type: 'boolean',
          description: '按重量（kg）收发的商品。收发行的数量按称重录，步进 0.001',
        },
      ],
    },
    settings: {
      schema: {
        type: 'object',
        properties: {
          weightStep: {
            type: 'number',
            description:
              '重量录入的最小步进（kg）。缺省 0.001，秤的精度不同可以调粗。改这一项走 profile.propose，路径 /modules/module.weighing/settings/weightStep',
            default: 0.001,
          },
        },
      },
    },
  };
}
