import type { ModuleManifest } from '@one/core';
import { extraRecord } from './builtin-records.js';

/**
 * module.carrier —— 承运商发运（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程：发货复用既有 shipped，本模块只加承运商档案、运单登记与轨迹。
 * 装车开着时可按承运商分车（对 load 的软联动，不写进 dependencies）。
 * 面单以打印任务（收件人 + 运单号）占位，具体模板走集成扩展。
 * 实现期补：carrier 档案表、轨迹表、发货登记工具 handler。
 */
export function carrierManifest(): ModuleManifest {
  return {
    id: 'module.carrier',
    name: '承运商发运',
    description:
      '出库的物流商与运单登记。启用后，可以建承运商档案（快递 / 专线 / 自提），出库单可以登记承运商和运单号（可配发货必填），装车页可以按承运商分车，发货时录入运单号、件数、重量；发货后可以补登轨迹节点（揽收 / 中转 / 签收）形成时间线，平台模式预留接口回传。面单以打印任务占位（收件人 + 运单号），具体模板由对接扩展。停用本模块后出库单不再要求承运商和运单号，发货回到直接确认；历史运单与轨迹保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['承运商', '物流', '运单'],
    records: [
      {
        id: 'carrier',
        label: '承运商',
        aliases: ['物流商'],
        note: '承运商档案。种类创建后不能改。这些是固定列，不能增删。',
        fields: [
          { key: 'carrierCode', label: '编码', description: '全库唯一' },
          { key: 'name', label: '名称' },
          { key: 'serviceType', label: '服务类型', description: 'express 快递、line 专线、pickup 自提' },
          { key: 'settlement', label: '结算方式', description: '月结 / 票结 / 到付等，仅记录用' },
          { key: 'contact', label: '联系人' },
          { key: 'phone', label: '电话' },
          { key: 'note', label: '备注' },
        ],
      },
      extraRecord('order', '单据', [
        {
          key: 'carrierCode',
          label: '承运商',
          description: '出库单的物流商。承运商发运启用时可登记；发货必填与否看设置',
        },
        { key: 'waybillNo', label: '运单号', description: '承运商给的运单号。发货登记时录入，可后补' },
      ]),
    ],
    tools: [
      {
        id: 'wms.carrier.ship',
        label: '发货登记',
        description:
          '出库单发货时登记承运商信息：运单号、件数、重量。requireCarrierOnShip 开着时运单号与承运商必填；登完单据进入已发货（复用既有发货流转）',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '出库单号' },
            carrierCode: { type: 'string', description: '承运商编码' },
            waybillNo: { type: 'string', description: '运单号' },
            packageCount: { type: 'integer', description: '件数' },
            grossWeight: { type: 'number', description: '毛重 kg' },
          },
          required: ['orderNo'],
        },
        permission: 'write',
      },
      {
        id: 'wms.carrier.trackAdd',
        label: '登记轨迹',
        description: '给出库单的运单补一个轨迹节点：picked_up 揽收、in_transit 中转、signed 签收，可带备注。时间取当前',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '出库单号' },
            node: { type: 'string', enum: ['picked_up', 'in_transit', 'signed'], description: '轨迹节点' },
            note: { type: 'string', description: '备注，如中转站名' },
          },
          required: ['orderNo', 'node'],
        },
        permission: 'write',
      },
      {
        id: 'wms.carrier.list',
        label: '查运单',
        description: '按运单号 / 出库单号 / 承运商查运单登记与轨迹时间线',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '按出库单号查' },
            waybillNo: { type: 'string', description: '按运单号查' },
            carrierCode: { type: 'string', description: '按承运商筛' },
          },
        },
        permission: 'read',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          requireCarrierOnShip: {
            type: 'boolean',
            description:
              '发货登记时承运商与运单号是否必填。开着时缺一项拒绝发货；关着可以后补。只约束本模块的发货登记，不影响既有发货动作。改这一项走 profile.propose，路径 /modules/module.carrier/settings/requireCarrierOnShip',
            default: false,
          },
        },
      },
    },
  };
}
