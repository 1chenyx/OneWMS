import type { ModuleManifest } from '@one/core';
import { extraRecord } from './builtin-records.js';

/** 建单后进入待释放。停用后这条边不再生效。 */
export const RELEASE_ENTRY_WHEN = 'module.release.enabled';

/** 出库扇出：released 的行为镜像 created（拣货开进拣货，波次开进波次，否则直发）。 */
const RELEASE_FANOUT_WHEN_PICKING = 'module.picking.enabled';
const RELEASE_FANOUT_WHEN_WAVE = 'module.wave.enabled';
const RELEASE_FANOUT_WHEN_DIRECT = '!module.picking.enabled';

/**
 * module.release —— 订单释放（骨架，见 docs/ROADMAP.md §3.2）。
 *
 * 向 outbound 贡献待释放 / 已释放两个状态。判定按行算可用量（余量−冻结−预占−已释放未拣），
 * 放行后镜像 created 的既有扇出。
 * 实现期待办：把 created 直达 picking / waved / shipped 的进入谓词收紧为
 * 「对应模块开 && !module.release.enabled」（装车 / 打包的 created 进入边同理），
 * 由本模块贡献否决；缺量明细联动 replenish 生成补货单。
 */
export function releaseManifest(): ModuleManifest {
  return {
    id: 'module.release',
    name: '订单释放',
    description:
      '出库单的可承诺量闸门。启用后，新建出库单先进待释放，不直接可拣：按行算可用量（余量−冻结−预占−已释放未拣），够数的整单放行进已释放，不够的排队等货，可以一键按缺口生成补货单。出库单可以设优先级（1 最先），缺量时高优先级先放。放行可以手动点，也可以开着自动定时跑；部分释放默认关，开了允许只放满足的部分。放行后按既有流程走：拣货开着进拣货，波次开着进波次，都关着直接发货。停用本模块后新的出库单跳过待释放直接按原流程走，已经在待释放的单自动放行，已释放的照常拣货发货。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['释放', 'ATP'],
    records: [
      extraRecord('order', '单据', [
        {
          key: 'priority',
          label: '优先级',
          description: '订单释放启用时 1-9，数字越小越先放行。缺省 5。不启用释放时不参与排序',
        },
      ]),
    ],
    tools: [
      {
        id: 'wms.release.check',
        label: '查释放缺口',
        description:
          '查一张待释放出库单（缺省全查）的放行判定：每行可用量够不够、缺多少、排在谁后面。只读不动单',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '出库单号。缺省查全部待释放单' },
          },
        },
        permission: 'read',
      },
      {
        id: 'wms.release.run',
        label: '执行释放',
        description:
          '按可用量与优先级放行待释放的出库单。orderNo 给了只放那一张（可用量不足时按设置决定部分放或拒绝）；不给按队列从高优先级放起。部分释放关着且量不够的单保持待释放',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '指定放行的出库单号。缺省按队列批量放' },
          },
        },
        permission: 'write',
      },
    ],
    workflows: {
      contributes: {
        outbound: {
          states: [
            { id: 'pending_release', label: '待释放' },
            { id: 'released', label: '已释放' },
          ],
          transitions: [
            { from: 'created', to: 'pending_release', when: RELEASE_ENTRY_WHEN, effect: 'none' },
            { from: 'pending_release', to: 'released', effect: 'none' },
            { from: 'pending_release', to: 'canceled', effect: 'none' },
            { from: 'released', to: 'picking', when: RELEASE_FANOUT_WHEN_PICKING, effect: 'check' },
            { from: 'released', to: 'waved', when: RELEASE_FANOUT_WHEN_WAVE, effect: 'none' },
            { from: 'released', to: 'shipped', when: RELEASE_FANOUT_WHEN_DIRECT },
            { from: 'released', to: 'canceled', effect: 'none' },
          ],
        },
      },
    },
    settings: {
      schema: {
        type: 'object',
        properties: {
          autoRelease: {
            type: 'boolean',
            description:
              '是否自动释放。开着时定时（每几分钟）按可用量与优先级自动放行待释放单；关着只在手动点或调 wms.release.run 时放。改这一项走 profile.propose，路径 /modules/module.release/settings/autoRelease',
            default: false,
          },
          partialRelease: {
            type: 'boolean',
            description:
              '量不够时允不允许部分释放。开着时行内拆分，只放满足的数量，剩余留在待释放；关着则整单等待',
            default: false,
          },
          excludeLocations: {
            type: 'array',
            items: { type: 'string' },
            description:
              '不参与可用量计算的库位编码（自用 / 展示 / 借存等缓冲位）。这些库位上的货不算可承诺量，但实物仍可被显式指定库位的行拣走',
            default: [],
          },
        },
      },
    },
  };
}
