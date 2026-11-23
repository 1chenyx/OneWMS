import type { ModuleManifest } from '@one/core';

/**
 * module.packaging —— 多级包装（骨架，见 docs/ROADMAP.md §3.3）。
 *
 * 不新建流程，不贡献状态。包装层级挂商品扩展字段（JSON 数组），账目恒以基础单位存储，
 * 包装只做录入换算——不改库存口径，是这个模块的铁律。
 * 实现期补：包装层级编辑工具 handler、单据行按包装录入的前端接线、
 * pack 开着时的纸箱推荐（长宽高简单匹配）。
 */
export function packagingManifest(): ModuleManifest {
  return {
    id: 'module.packaging',
    name: '多级包装',
    description:
      '商品的包装层级与按包装收发。启用后，商品档案可以登记包装层级（如中包=6件、箱=24件、托=48箱），每层可以带条码、长宽高和毛重；单据行可以按包装录入，扫箱码等于按含量折成件数，行上双单位展示（箱+件）；收货支持整箱收，拣货建议整箱拆散件；打包开着时按商品与包装尺寸推荐纸箱型号。库存与账目恒以基础单位记，包装只做录入换算，不改库存口径。停用本模块后单据行回到按基础单位录入，未完成单的已录包装行按折算后的件数显示；包装档案保留。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['包装', '箱规'],
    fields: {
      provides: [
        {
          entity: 'sku',
          key: 'packLevels',
          label: '包装层级',
          type: 'json',
          description:
            '包装层级数组：[{ level, name, qtyPerLevel, barcode, l, w, h, weight }]。qtyPerLevel 是一层折多少基础单位；barcode 可与 GTIN 登记（module.gs1）联动',
        },
      ],
    },
    tools: [
      {
        id: 'wms.packaging.convert',
        label: '包装换算',
        description:
          '按商品的包装层级把包装数量折成基础单位数量：给层级名和件数，返回折算结果与反向展示（如 26 件 = 1 箱 + 2 件）。商品没登记该层级时报错',
        parameters: {
          type: 'object',
          properties: {
            skuCode: { type: 'string', description: '商品编码' },
            level: { type: 'string', description: '包装层级名，如 箱' },
            count: { type: 'number', description: '该层级的数量' },
          },
          required: ['skuCode', 'level', 'count'],
        },
        permission: 'read',
      },
      {
        id: 'wms.packaging.set',
        label: '设置包装',
        description:
          '整体覆写一个商品的包装层级数组（每层：名称、含量、可选条码与长宽高毛重）。含量必须为正整数，层级按大小从内到外排。传空数组等于清空',
        parameters: {
          type: 'object',
          properties: {
            skuCode: { type: 'string', description: '商品编码' },
            levels: {
              type: 'array',
              description: '层级数组。元素 { name, qtyPerLevel, barcode?, l?, w?, h?, weight? }',
              items: { type: 'object' },
            },
          },
          required: ['skuCode', 'levels'],
        },
        permission: 'write',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          suggestCarton: {
            type: 'boolean',
            description:
              '打包开着时是否按商品与包装尺寸推荐纸箱型号（长宽高简单匹配，装不下才提示更大箱）。只给建议，不拦操作。改这一项走 profile.propose，路径 /modules/module.packaging/settings/suggestCarton',
            default: false,
          },
        },
      },
    },
  };
}
