import type { ModuleManifest } from '@one/core';

/**
 * module.scenario —— 场景作业（骨架，见 docs/ROADMAP.md §3.1）。
 *
 * 不新建流程，也不向出入库贡献状态：场景只是表单 / AI 之外的第三种作业入口，
 * 每一步确认都走工具总线，与表单、AI 同一条 oplog 事实流。
 * 实现期补：场景档案存储、种子场景五个（收货/上架/拣选/盘点/移库）、场景页前端。
 */
export function scenarioManifest(): ModuleManifest {
  return {
    id: 'module.scenario',
    name: '场景作业',
    description:
      '面向库工的移动端扫码场景作业。启用后，收货、上架、拣货、盘点、移库可以在场景页按「扫单→扫货→确认」的向导一步步做，入口只在手机/扫码枪浏览器显示，电脑端管理界面不出现（现场作业在手上做，管理在电脑上做）。场景里的每一次确认走的是和表单、AI 同一条工具总线，账目同源。停用本模块后移动端场景入口收回，作业回到表单页；进行中的场景会话作废，已经确认过的动作都在账上。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['场景', '扫码作业'],
    settings: {
      schema: {
        type: 'object',
        properties: {
          defaultScenario: {
            type: 'string',
            // 取值域与前端 ScenarioId（packages/app/src/components/scenario/shared.tsx）逐字一致：
            // 写错一个字母，场景页只会静默回落到第一个场景，配置项等于白配。
            enum: ['receive', 'putaway', 'pick', 'stocktake', 'move'],
            description:
              '场景页打开时默认进入哪个场景。receive 收货、putaway 上架、pick 拣选、stocktake 盘点、move 移库。改这一项走 profile.propose，路径 /modules/module.scenario/settings/defaultScenario',
            default: 'receive',
          },
          pickPathStrategy: {
            type: 'string',
            enum: ['locationCode', 'pickZoneFirst'],
            description:
              '拣选与批次拣货场景的行走路径怎么排。locationCode 按库位编码排序；pickZoneFirst 拣货区优先、存储区在后。只影响场景内向导的步序，不影响拣货单本身',
            default: 'locationCode',
          },
          feedbackSound: {
            type: 'boolean',
            description: '场景页扫码成功 / 失败是否播声音反馈（配合扫码枪的听觉确认习惯）',
            default: true,
          },
        },
      },
    },
  };
}
