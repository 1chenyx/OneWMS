import type { ModuleManifest } from '@one/core';

/**
 * module.availability —— 时点可用量（骨架，见 docs/ROADMAP.md §3.4）。
 *
 * 不新建流程，不贡献状态。纯读侧增强：把「现在有多少」升级成「哪天有多少」，
 * 在途入库按预计到货日并入（asn 开着用 expectedAt，没开用单据创建日）。
 * 订单释放可选用「含在途」口径（release 侧消费，本模块只提供数据）。
 * 实现期补：逐日可用量计算、缺货日历报表、release 口径开关接线。
 */
export function availabilityManifest(): ModuleManifest {
  return {
    id: 'module.availability',
    name: '时点可用量',
    description:
      '把「现在有多少」升级成「哪天有多少」。启用后，可用量多一条日期轴：在途入库按预计到货日并入，未来若干天每天的可用量可查；报表出现缺货日历，看哪天开始缺。到货预报关着时在途按入库单创建日并入。订单释放的放行判定可以选择含在途口径（默认不含）。停用本模块后可用量回到当前口径。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['时点可用量', '缺货日历'],
    tools: [
      {
        id: 'wms.availability.byDate',
        label: '查时点可用量',
        description:
          '按商品查未来 N 天逐日可用量：每天的余量、在途到货、已排需求，得出当天可用。skuCode 缺省查低库存商品。days 缺省用设置的天数',
        parameters: {
          type: 'object',
          properties: {
            skuCode: { type: 'string', description: '商品编码。缺省查低库存商品' },
            days: { type: 'integer', description: '查未来多少天。缺省按设置' },
          },
        },
        permission: 'read',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          horizonDays: {
            type: 'integer',
            minimum: 7,
            maximum: 90,
            description:
              '默认往后看多少天。工具没传 days 时用这个值；缺货日历也按这个窗口画。改这一项走 profile.propose，路径 /modules/module.availability/settings/horizonDays',
            default: 30,
          },
        },
      },
    },
  };
}
