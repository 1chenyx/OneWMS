import type { ModuleManifest } from '@one/core';
import { extraRecord } from './builtin-records.js';

/**
 * module.qcdisposition —— 质检处置（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 需质检开着。不新建流程、不贡献状态：判定发生在质检确认那一步内部，
 * 不合格的处置生成既有单据（退货出库 / 报损单）或转冻结库位。
 * 实现期补：判定工具 handler（挂在质检确认上）、批次标记、合格率报表。
 */
export function qcdispositionManifest(): ModuleManifest {
  return {
    id: 'module.qcdisposition',
    name: '质检处置',
    description:
      '质检不合格的处置流。启用后（需质检开着），质检确认从只有通过扩展为判定三选：合格照旧上架；让步接收的批次打标记入库，效期看板可见；不合格三路处置——退供应商生成退货出库、转不合格品库位并冻结、报废生成报损单。报表多一张按供应商的月度来料合格率。停用本模块后质检回到只有通过；已生成的处置单据照常走完。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms', 'module.qc'] },
    aliases: ['质检处置', '不合格处置'],
    records: [
      extraRecord('order', '单据', [
        {
          key: 'qcVerdict',
          label: '质检判定',
          description:
            '质检处置启用时记录判定：pass 合格、concession 让步接收、reject 不合格。判定后带处置说明',
        },
      ]),
    ],
    tools: [
      {
        id: 'wms.qc.disposition',
        label: '质检判定',
        description:
          '对已收货的入库单做质检判定。pass 合格（照旧流程）；concession 让步接收（批次打标记，正常入位）；reject 不合格必选动作：return 退供应商、quarantine 转不合格品库位冻结、scrap 报废',
        parameters: {
          type: 'object',
          properties: {
            orderNo: { type: 'string', description: '入库单号' },
            verdict: { type: 'string', enum: ['pass', 'concession', 'reject'], description: '判定结果' },
            action: {
              type: 'string',
              enum: ['return', 'quarantine', 'scrap'],
              description: '不合格时的处置动作。verdict=reject 必填',
            },
            note: { type: 'string', description: '判定说明' },
          },
          required: ['orderNo', 'verdict'],
        },
        permission: 'write',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          rejectLocation: {
            type: 'string',
            description:
              '不合格品库位编码。reject+quarantine 时货转到这个库位并冻结。空串表示没配，用 DEFAULT 并冻结。改这一项走 profile.propose，路径 /modules/module.qcdisposition/settings/rejectLocation',
            default: '',
          },
          autoReturn: {
            type: 'boolean',
            description: '判定退供应商时是否直接生成退货出库草稿（待确认），关着则只记判定，人工后续开单',
            default: false,
          },
        },
      },
    },
  };
}
