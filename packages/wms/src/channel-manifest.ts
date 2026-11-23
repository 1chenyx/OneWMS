import type { ModuleManifest } from '@one/core';

/**
 * module.channel —— 释放通道（骨架，见 docs/ROADMAP.md §3.2）。
 *
 * 需订单释放开着。不新建流程、不贡献状态：通道只是 release 的分组放行计划器，
 * 到点调用同一套放行判定。筛选条件支持承运商（carrier 开着才有这个字段可筛）。
 * 实现期补：通道档案表、定时巡检（jobs）、工作台放行计划看板。
 */
export function channelManifest(): ModuleManifest {
  return {
    id: 'module.channel',
    name: '释放通道',
    description:
      '出库的分组放行计划。启用后（需订单释放开着），可以建释放通道：按承运商、承诺日期或客户分组筛出待释放单，配每天几点放行、每次放多少单；到点自动按通道放行，工作台能看到今日各通道的计划与进度。不到放行时间的单安静排队。停用本模块后通道不再定时放行，出库单回到订单释放的默认放行规则（手动或自动全量）；通道档案保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms', 'module.release'] },
    aliases: ['通道', '放行计划'],
    records: [
      {
        id: 'releasechannel',
        label: '释放通道',
        aliases: ['通道'],
        note: '释放通道启用时才有。筛选与时刻表决定一批出库单何时被放行。这些是固定列，不能增删。',
        fields: [
          { key: 'name', label: '名称', description: '如 早班快递车' },
          {
            key: 'filter',
            label: '筛选条件',
            description: 'JSON：{ carrierCode?, promiseDate?, partnerGroup? }，命中条件的待释放单归本通道',
          },
          { key: 'schedule', label: '放行时刻表', description: '每天的放行时刻数组，如 ["08:30","14:00"]' },
          { key: 'maxPerRun', label: '单次上限', description: '一次放行最多放多少张单。0 表示不限' },
          { key: 'status', label: '状态', description: '启用或停用。停用后不参与定时放行' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.channel.run',
        label: '手动放行通道',
        description:
          '立即执行一个通道的放行：按筛选条件挑待释放单，受单次上限约束，从高优先级放起。不定时等时刻表，手动触发同一条判定',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '通道名称' },
          },
          required: ['name'],
        },
        permission: 'write',
      },
      {
        id: 'wms.channel.list',
        label: '查通道计划',
        description: '查通道清单与今日放行计划：每个通道几点放、放多少、已放多少',
        parameters: {
          type: 'object',
          properties: {},
        },
        permission: 'read',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          checkIntervalMinutes: {
            type: 'integer',
            minimum: 1,
            description:
              '定时器多久巡检一次时刻表（分钟）。到点的通道执行放行。改这一项走 profile.propose，路径 /modules/module.channel/settings/checkIntervalMinutes',
            default: 5,
          },
        },
      },
    },
  };
}
