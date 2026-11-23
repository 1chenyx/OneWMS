import type { ModuleManifest } from '@one/core';

/**
 * module.dock —— 月台预约（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程，不贡献状态。月台档案 + 预约排队，同月台同时段互斥。
 * 与到货预报是软联动（asn 开着时预约可关联预报单并显示在详情页），
 * 不写进 dependencies——asn 没开也照常按月台排队。
 * 实现期补：月台与预约表、互斥校验、ASN 详情页联动。
 */
export function dockManifest(): ModuleManifest {
  return {
    id: 'module.dock',
    name: '月台预约',
    description:
      '月台档案与到车预约。启用后，可以登记月台（收货或发货、可用时段），给供应商或承运商约车：预计到达时间、关联到货预报或出库单；同一月台同一时段互斥，迟到提示顺延。到货预报开着时，预报单详情能看到约的月台。停用本模块后不再做月台约束，收发货照常；存量预约自动关闭。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['月台', '预约', '排队'],
    records: [
      {
        id: 'dock',
        label: '月台',
        aliases: ['道口'],
        note: '月台档案。约车时选月台与时段，同月台同时段只约一车。这些是固定列，不能增删。',
        fields: [
          { key: 'dockNo', label: '编号', description: '全库唯一' },
          { key: 'type', label: '类型', description: 'receiving 收货月台、shipping 发货月台' },
          { key: 'availableHours', label: '可用时段', description: '每天可约的时段数组，如 ["08:00~12:00","13:00~17:00"]' },
          { key: 'note', label: '备注' },
        ],
      },
      {
        id: 'dockappointment',
        label: '月台预约',
        aliases: ['约车'],
        note: '一车一约：谁的车、几点到、停哪个月台。状态由到车与离场动作推进。这些是固定列，不能增删。',
        fields: [
          { key: 'appointmentNo', label: '预约号', description: '不填则自动生成' },
          { key: 'partner', label: '供应商 / 承运商' },
          { key: 'dockNo', label: '月台' },
          { key: 'eta', label: '预计到达', description: 'YYYY-MM-DD HH:mm' },
          { key: 'state', label: '状态', description: 'booked 预约、arrived 到车、working 作业中、done 离场、canceled 取消' },
          { key: 'refNo', label: '关联单据', description: '到货预报号或出库单号。可以不填' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.dock.book',
        label: '约车',
        description:
          '给供应商或承运商约一个月台时段。同月台同时段已约过会拒绝，可看相邻空档；关联到货预报号后预约显示在预报详情',
        parameters: {
          type: 'object',
          properties: {
            partner: { type: 'string', description: '供应商或承运商名称' },
            dockNo: { type: 'string', description: '月台编号' },
            eta: { type: 'string', description: '预计到达时间，YYYY-MM-DD HH:mm' },
            refNo: { type: 'string', description: '关联到货预报号或出库单号' },
          },
          required: ['partner', 'dockNo', 'eta'],
        },
        permission: 'write',
      },
      {
        id: 'wms.dock.arrive',
        label: '到车登记',
        description: '预约的车到了：预约进到车（或直接作业中）。比预计晚超过 30 分钟提示顺延或改约',
        parameters: {
          type: 'object',
          properties: {
            appointmentNo: { type: 'string', description: '预约号' },
          },
          required: ['appointmentNo'],
        },
        permission: 'write',
      },
      {
        id: 'wms.dock.list',
        label: '查预约',
        description: '按日期 / 月台 / 状态查预约排队，看今天哪些车在等、哪些月台空',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '按日期筛，YYYY-MM-DD。缺省今天' },
            dockNo: { type: 'string', description: '按月台筛' },
            state: { type: 'string', description: '按状态筛' },
          },
        },
        permission: 'read',
      },
    ],
  };
}
