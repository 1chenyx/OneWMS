import type { ModuleManifest } from '@one/core';

/** 进入合批。停用后这两条进入边不再生效。 */
export const BATCH_ENTRY_WHEN = 'module.batchpick.enabled';

/**
 * module.batchpick —— 批次拣货（簇拣，骨架，见 docs/ROADMAP.md §3.1）。
 *
 * 需拣货开着。向 outbound 贡献「已合批」状态：created / released 进合批，合批后进拣货中。
 * 与波次（wave）是两种不同的合单形态：wave 按库位加总出一张拣货单，本模块按人给格口边拣边分，
 * 两者互斥使用（同一张单要么组波要么合批，由进入边谓词与实现层守卫保证）。
 * 实现期补：批次档案表、格口分配、扫批次作业流（场景作业联动）、交接关单。
 */
export function batchpickManifest(): ModuleManifest {
  return {
    id: 'module.batchpick',
    name: '批次拣货',
    description:
      '多单合批、边拣边分。启用后（需拣货开着），可以把多张出库单合成一个拣货批次交给一个库工：扫批次开始，按库位路径逐位拣货，一位多单分别放进对应格口，拣完逐格口交接，各单分别进入已拣货。批次生成可以手动勾单，也可以开着自动按设置聚合（按区域、按单数上限、按格口上限）。分完的格口可以直接生成打包任务。停用本模块后回到按单拣货；已经开的批次仍可拣完交接。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    dependencies: { modules: ['core.wms', 'module.picking'] },
    aliases: ['合批', '簇拣'],
    records: [
      {
        id: 'pickbatch',
        label: '拣货批次',
        aliases: ['合批'],
        note: '批次拣货启用时才有。批次内是若干张出库单，格口表记哪张单放哪个格口。这些是固定列，不能增删。',
        fields: [
          { key: 'batchNo', label: '批次号', description: '不填则自动生成' },
          { key: 'state', label: '状态', description: '待拣、拣货中、已分完、已交接或已取消' },
          { key: 'assignee', label: '指派给', description: '库工。配了用户角色（module.rbac）按人过滤待办' },
          { key: 'orderNos', label: '包含出库单', description: '批次内的出库单清单' },
          { key: 'binCount', label: '格口数', description: '拣选车格口数，上限看设置' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.batch.create',
        label: '生成批次',
        description:
          '把若干张出库单合成一个拣货批次并分配格口。orderNos 给了按勾选合；缺省按设置的聚合策略（区域 / 单数上限 / 格口上限）自动挑单',
        parameters: {
          type: 'object',
          properties: {
            orderNos: {
              type: 'array',
              items: { type: 'string' },
              description: '要合批的出库单号。缺省按聚合策略自动挑',
            },
            assignee: { type: 'string', description: '指派给的库工。可以后补' },
          },
        },
        permission: 'write',
      },
      {
        id: 'wms.batch.close',
        label: '交接关单',
        description:
          '批次分完后逐格口交接：各单按实拣进入已拣货（拣货开着时与拣货关单同口径）。未拣完拒绝关单',
        parameters: {
          type: 'object',
          properties: {
            batchNo: { type: 'string', description: '批次号' },
          },
          required: ['batchNo'],
        },
        permission: 'write',
      },
      {
        id: 'wms.batch.list',
        label: '查批次',
        description: '按批次号 / 状态 / 指派人查拣货批次与格口分配',
        parameters: {
          type: 'object',
          properties: {
            batchNo: { type: 'string', description: '按批次号查' },
            state: { type: 'string', description: '按状态筛' },
            assignee: { type: 'string', description: '按指派人筛' },
          },
        },
        permission: 'read',
      },
    ],
    workflows: {
      contributes: {
        outbound: {
          states: [{ id: 'batched', label: '已合批' }],
          transitions: [
            { from: 'created', to: 'batched', when: BATCH_ENTRY_WHEN, effect: 'none' },
            { from: 'released', to: 'batched', when: BATCH_ENTRY_WHEN, effect: 'none' },
            { from: 'batched', to: 'picking', when: 'module.picking.enabled', effect: 'check' },
            { from: 'batched', to: 'canceled', effect: 'none' },
          ],
        },
      },
    },
    settings: {
      schema: {
        type: 'object',
        properties: {
          autoCreate: {
            type: 'boolean',
            description:
              '是否自动合批。开着时定时按聚合策略自动生成批次；关着只手动勾单生成。改这一项走 profile.propose，路径 /modules/module.batchpick/settings/autoCreate',
            default: false,
          },
          maxOrders: {
            type: 'integer',
            minimum: 2,
            maximum: 100,
            description: '一个批次最多合多少张出库单（自动合批的上限之一，手动不受限但超限提示）',
            default: 10,
          },
          maxBins: {
            type: 'integer',
            minimum: 2,
            maximum: 60,
            description: '拣选车格口数上限，决定一个批次能分多少张单（格口↔单据一一对应）',
            default: 12,
          },
        },
      },
    },
  };
}
