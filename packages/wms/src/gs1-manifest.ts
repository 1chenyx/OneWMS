import type { ModuleManifest } from '@one/core';

/**
 * module.gs1 —— GS1 条码（骨架，见 docs/ROADMAP.md §3.1）。
 *
 * 不新建流程，不贡献状态。核心是一个读工具（解析）+ 商品档案上的多 GTIN 字段。
 * 过期码拦截沿用 core.wms 的 blockExpiredOutbound，本模块不另设开关。
 * 实现期补：解析器（AI 位 01/10/17/37 起步）、输入框自动拆填接线、
 * 工具 handler 与本声明比对（detachHandler 模式）。
 */
export function gs1Manifest(): ModuleManifest {
  return {
    id: 'module.gs1',
    name: 'GS1 条码',
    description:
      '解析 GS1 标准条码。启用后，收货、拣货、盘点输入框遇到 GS1-128 或 GTIN 码会自动拆出商品、批次、效期、数量填进表单，操作员只做确认；商品档案可以登记多个 GTIN 包装码，扫到没登记过的码会提示新码，可以一键登记。过期码是否拦截沿用库存基础的过期拦截开关，不另设规则。停用本模块后条码按普通文本处理，已登记的 GTIN 留在商品档案。',
    version: '0.1.0',
    capabilities: ['db.read', 'tools.register'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['GS1', 'GTIN'],
    fields: {
      provides: [
        {
          entity: 'sku',
          key: 'gtinCodes',
          label: 'GTIN 码',
          type: 'json',
          description: '商品的多包装条码（GTIN 数组）。扫这些码等同扫到本商品，可带每码件数',
        },
      ],
    },
    tools: [
      {
        id: 'wms.gs1.parse',
        label: '解析条码',
        description:
          '解析一串条码内容。GS1-128 / 带 AI 位的码拆出商品码、批次、效期、数量；EAN-13 等普通码原样返回并按 GTIN 匹配商品。不是合法 GS1 结构时说明原因',
        parameters: {
          type: 'object',
          properties: {
            barcode: { type: 'string', description: '扫码枪读到的原始码串' },
          },
          required: ['barcode'],
        },
        permission: 'read',
      },
      {
        id: 'wms.gs1.bind',
        label: '登记 GTIN',
        description: '把一个 GTIN 码登记到商品档案，可带每码件数（包装换算）。已存在的码会拒绝',
        parameters: {
          type: 'object',
          properties: {
            skuCode: { type: 'string', description: '商品编码' },
            gtin: { type: 'string', description: '要登记的 GTIN 码' },
            qtyPerCode: { type: 'number', description: '扫一次这个码折多少件。缺省 1' },
          },
          required: ['skuCode', 'gtin'],
        },
        permission: 'write',
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          aiIdentifiers: {
            type: 'array',
            items: { type: 'string' },
            description:
              '启用哪些 GS1 应用标识符（AI 位）。01 商品码、10 批次、17 效期、37 数量是默认集；加 21 序列号、30 数量变体等按需开。只影响解析白名单，不影响登记。改这一项走 profile.propose，路径 /modules/module.gs1/settings/aiIdentifiers',
            default: ['01', '10', '17', '37'],
          },
        },
      },
    },
  };
}
