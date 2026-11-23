import type { ModuleManifest } from '@one/core';

/**
 * module.ticket —— 异常工单（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程，不贡献状态：工单是独立业务对象，处置动作生成既有单据
 * （退供应商 → 退货出库、报损 → 报损单），复用它们的流程。
 * 实现期补：工单表、照片路径占位存储、看板异常块接线、处置联动。
 */
export function ticketManifest(): ModuleManifest {
  return {
    id: 'module.ticket',
    name: '异常工单',
    description:
      '现场异常的登记与流转。启用后，收货、拣货、盘点现场发现短少、破损、错发可以直接开工单：记类型、关联单据与商品、描述与照片；工单从待处理到处理中、已解决、已关闭；处置四选一：让步接收、退供应商（生成退货出库）、报损（生成报损单）、补货重发；工单计入看板异常块统计。停用本模块后不能再开工单；存量工单只读保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['工单', '异常'],
    records: [
      {
        id: 'ticket',
        label: '工单',
        aliases: ['异常单'],
        note: '现场异常的登记。处置动作会生成既有单据（退货出库 / 报损单），工单本身只记事实与结论。这些是固定列，不能增删。',
        fields: [
          { key: 'ticketNo', label: '工单号', description: '不填则自动生成' },
          { key: 'type', label: '类型', description: 'shortage 短少、damage 破损、wrong 错发、other 其他' },
          { key: 'source', label: '来源', description: '发现环节：receiving 收货、picking 拣货、stocktake 盘点、other 其他' },
          { key: 'orderNo', label: '关联单据', description: '出问题的单号。可以不填' },
          { key: 'skuCode', label: '商品', description: '涉及的商品编码。可以不填' },
          { key: 'state', label: '状态', description: '待处理、处理中、已解决或已关闭' },
          { key: 'resolution', label: '处置', description: 'accept 让步接收、return 退供应商、scrap 报损、reissue 补货重发' },
          { key: 'photos', label: '照片', description: '照片文件路径数组。占位，当前版本只存路径' },
          { key: 'note', label: '描述' },
        ],
      },
    ],
    tools: [
      {
        id: 'wms.ticket.create',
        label: '开工单',
        description: '登记一条现场异常：类型、来源环节、关联单据与商品、描述，可带照片路径。开出即待处理',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['shortage', 'damage', 'wrong', 'other'], description: '异常类型' },
            source: { type: 'string', enum: ['receiving', 'picking', 'stocktake', 'other'], description: '发现环节' },
            orderNo: { type: 'string', description: '关联单据号' },
            skuCode: { type: 'string', description: '商品编码' },
            note: { type: 'string', description: '描述' },
            photos: { type: 'array', items: { type: 'string' }, description: '照片路径。占位' },
          },
          required: ['type', 'source'],
        },
        permission: 'write',
      },
      {
        id: 'wms.ticket.resolve',
        label: '处置工单',
        description:
          '给待处理 / 处理中的工单定处置：accept 让步接收（只记结论）、return 退供应商（生成退货出库草稿）、scrap 报损（生成报损单草稿）、reissue 补货重发。生成单据后工单进已解决',
        parameters: {
          type: 'object',
          properties: {
            ticketNo: { type: 'string', description: '工单号' },
            resolution: {
              type: 'string',
              enum: ['accept', 'return', 'scrap', 'reissue'],
              description: '处置动作',
            },
            note: { type: 'string', description: '处置说明' },
          },
          required: ['ticketNo', 'resolution'],
        },
        permission: 'write',
      },
      {
        id: 'wms.ticket.list',
        label: '查工单',
        description: '按状态 / 类型 / 单据查工单。看板异常块的数据源',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'string', description: '按状态筛' },
            type: { type: 'string', description: '按类型筛' },
            orderNo: { type: 'string', description: '按关联单据筛' },
          },
        },
        permission: 'read',
      },
    ],
  };
}
