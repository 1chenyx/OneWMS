import type { ManifestRecord, ManifestRecordField } from '@one/core';

/**
 * 业务对象的固定列。profile.field.query 用它们回答「有哪些字段」。
 * 扩展字段仍在 fields 里，可以隐藏或新增；这里的列不能删。
 * 跟着可选模块才出现的列，写在那个模块的 manifest 上，没装就不列出。
 */

const FIXED = '这些是固定列，不能增删。可配置的扩展字段在 fields；fields 为空表示现在没有、也可以另外加。';

export const SKU_RECORD: ManifestRecord = {
  id: 'sku',
  label: '商品',
  aliases: ['货品', '物料'],
  note: FIXED,
  fields: [
    { key: 'skuCode', label: '编码', description: '全库唯一的商品编码' },
    { key: 'name', label: '名称', description: '商品名称' },
    { key: 'barcode', label: '条码', description: '扫码用，同库唯一。可以不填' },
    { key: 'unit', label: '单位', description: '数量单位，如件、箱、kg。没填则不显示' },
    { key: 'reorderPoint', label: '安全库存', description: '大于 0 且可用量低于它时算低库存。0 表示不预警' },
    { key: 'status', label: '状态', description: '启用或停用。停用后默认清单里不出现' },
  ],
};

export const INVENTORY_RECORD: ManifestRecord = {
  id: 'inventory',
  label: '库存',
  aliases: ['stock', '余量'],
  note: '库存没有单独的档案。清单按商品汇总；库位和批次在下钻里。' + FIXED,
  fields: [
    { key: 'skuCode', label: '编码', description: '商品编码' },
    { key: 'name', label: '名称', description: '商品名称' },
    { key: 'quantity', label: '当前余量', description: '实物数量。清单跨库位、跨批次加总' },
    { key: 'held', label: '冻结量', description: '冻结合计。冻结不减少实物余量' },
    { key: 'reserved', label: '预占', description: '拣货占用合计。没有占用时库存页可能不显示这一列' },
    { key: 'available', label: '可用量', description: '当前余量 − 冻结量 − 预占' },
    { key: 'reorderPoint', label: '安全库存', description: '来自商品主数据' },
    { key: 'unit', label: '单位', description: '来自商品主数据，显示在数量旁边' },
    { key: 'locationCode', label: '库位编码', description: '下钻字段。未指定库位记在 DEFAULT' },
    { key: 'locationName', label: '库位名称', description: '下钻字段。DEFAULT 显示为默认库位' },
    { key: 'batchNo', label: '批次号', description: '下钻字段。未指定批次记在 DEFAULT' },
    { key: 'batchExpiryDate', label: '效期', description: '下钻字段，YYYY-MM-DD。未登记为空' },
  ],
};

export const ORDER_RECORD: ManifestRecord = {
  id: 'order',
  label: '单据',
  aliases: ['订单', '出入库单'],
  note: '状态有哪些、怎么流转，用 profile.workflow.query 查入库和出库。' + FIXED,
  fields: [
    { key: 'orderNo', label: '单号', description: '不填则自动生成' },
    { key: 'direction', label: '方向', description: 'in 入库，out 出库' },
    { key: 'state', label: '状态', description: '由当前流程决定，不是固定词表' },
    { key: 'partner', label: '往来单位', description: '入库单关联供应商，出库单关联客户。可以不填' },
    { key: 'note', label: '备注', description: '可以不填' },
    { key: 'createdAt', label: '创建时间' },
    { key: 'skuCode', label: '行·商品编码', description: '明细行' },
    { key: 'quantity', label: '行·数量', description: '明细行上的订单数量' },
    { key: 'locationCode', label: '行·库位', description: '明细行。不填则 DEFAULT' },
    { key: 'batchNo', label: '行·批次', description: '明细行。不填则 DEFAULT' },
    { key: 'batchExpiryDate', label: '行·效期', description: '入库行可填，YYYY-MM-DD' },
  ],
};

export const LOCATION_RECORD: ManifestRecord = {
  id: 'location',
  label: '库位',
  aliases: ['货位', '仓位'],
  note: '没建库位时，库存归虚拟库位 DEFAULT，DEFAULT 不在库位清单里。' + FIXED,
  fields: [
    { key: 'locationCode', label: '编码', description: '全库唯一' },
    { key: 'name', label: '名称' },
  ],
};

export const PARTNER_RECORD: ManifestRecord = {
  id: 'partner',
  label: '往来单位',
  aliases: ['供应商', '客户'],
  note: '供应商用于入库单，客户用于出库单。种类创建后不能改。' + FIXED,
  fields: [
    { key: 'partnerCode', label: '编码', description: '全库唯一' },
    { key: 'kind', label: '种类', description: 'supplier 供应商或 customer 客户。创建后不能改' },
    { key: 'name', label: '名称' },
    { key: 'contact', label: '联系人' },
    { key: 'phone', label: '电话' },
    { key: 'address', label: '地址' },
    { key: 'note', label: '备注' },
  ],
};

export const BATCH_RECORD: ManifestRecord = {
  id: 'batch',
  label: '批次',
  aliases: ['批号', '效期'],
  note: '批次没有单独的档案页。库存桶和单据行上带着这些列。' + FIXED,
  fields: [
    { key: 'batchNo', label: '批次号', description: '未指定记在 DEFAULT' },
    { key: 'batchExpiryDate', label: '效期', description: 'YYYY-MM-DD。未登记为空' },
  ],
};

export const PICKING_RECORD: ManifestRecord = {
  id: 'picking',
  label: '拣货单',
  aliases: ['拣货'],
  note: '拣货单的步骤是固定的：拣货中 → 关单或取消，不进可配置流程。关单时出库单才按出库流程发货。' + FIXED,
  fields: [
    { key: 'pickingNo', label: '拣货单号' },
    { key: 'state', label: '状态', description: '拣货中、已关单或已取消' },
    { key: 'orderNo', label: '关联出库单' },
    { key: 'skuCode', label: '行·商品编码' },
    { key: 'suggestedLocationCode', label: '行·建议库位' },
    { key: 'suggestedBatchNo', label: '行·建议批次' },
    { key: 'pickedQty', label: '行·已拣数量' },
    { key: 'locationCode', label: '行·实拣库位' },
    { key: 'batchNo', label: '行·实拣批次' },
  ],
};

export const STOCKTAKE_RECORD: ManifestRecord = {
  id: 'stocktake',
  label: '盘点单',
  aliases: ['盘点'],
  note: '盘点单的步骤是固定的：盘点中 → 关单或取消，不进可配置流程。关单按差异调整库存。' + FIXED,
  fields: [
    { key: 'stocktakeNo', label: '盘点单号' },
    { key: 'state', label: '状态', description: '盘点中、已关单或已取消' },
    { key: 'locationCodes', label: '范围', description: '不填表示全场，含 DEFAULT' },
    { key: 'note', label: '备注' },
    { key: 'skuCode', label: '行·商品编码' },
    { key: 'locationCode', label: '行·库位' },
    { key: 'batchNo', label: '行·批次' },
    { key: 'expectedQty', label: '行·账面快照', description: '创建时点的账面数量' },
    { key: 'countedQty', label: '行·实盘数' },
  ],
};

export const WMS_RECORDS: ManifestRecord[] = [
  SKU_RECORD,
  INVENTORY_RECORD,
  ORDER_RECORD,
  LOCATION_RECORD,
  PARTNER_RECORD,
  BATCH_RECORD,
  PICKING_RECORD,
  STOCKTAKE_RECORD,
];

export const ORDER_RETURN_FIELD: ManifestRecordField = {
  key: 'returnOf',
  label: '原单号',
  description: '退货功能启用时，客退或退供要填原单号。停用后不能再开新的退货单',
};

export const ORDER_ASN_FIELD: ManifestRecordField = {
  key: 'expectedAt',
  label: '预计到货日',
  description: '到货预报启用时，预报单可以填预计到货日。收货前不加库存',
};

export const ORDER_REPLENISH_FIELD: ManifestRecordField = {
  key: 'replenishment',
  label: '补货',
  description: '补货功能开出的入库单会标成补货。收货时才加库存',
};

export const ORDER_PARTIAL_FIELD: ManifestRecordField = {
  key: 'fulfilledQty',
  label: '行·已入账',
  description: '短收短发启用时，收货或发货可以按少于订单数量的实数入账',
};

export const LOCATION_WAREHOUSE_FIELD: ManifestRecordField = {
  key: 'warehouseCode',
  label: '所属仓库',
  description: '多仓启用后，库位可以划进某个仓库。不划则未分仓。库存仍记在库位上',
};

export const SKU_SERIAL_FIELD: ManifestRecordField = {
  key: 'serialTracked',
  label: '按序列号管理',
  description: '序列号功能启用后，商品可以改成一物一码。库存仍按数量记',
};

export const WAREHOUSE_RECORD: ManifestRecord = {
  id: 'warehouse',
  label: '仓库',
  aliases: ['仓'],
  note: '仓库是库位的上一层，本身不记库存。' + FIXED,
  fields: [
    { key: 'warehouseCode', label: '编码' },
    { key: 'name', label: '名称' },
  ],
};

export const LPN_RECORD: ManifestRecord = {
  id: 'lpn',
  label: '托盘',
  aliases: ['托'],
  note: '托盘不是新的库存桶，件数仍记在库位和批次上。' + FIXED,
  fields: [
    { key: 'lpnCode', label: '托盘号' },
    { key: 'locationCode', label: '库位' },
    { key: 'skuCode', label: '行·商品编码' },
    { key: 'batchNo', label: '行·批次' },
    { key: 'quantity', label: '行·数量' },
  ],
};

export const SERIAL_RECORD: ManifestRecord = {
  id: 'serial',
  label: '序列号',
  aliases: ['序列', '一物一码'],
  note: '一个号对应一件货。库存仍按库位和批次记数量。' + FIXED,
  fields: [
    { key: 'serialNo', label: '序列号' },
    { key: 'skuCode', label: '商品编码' },
    { key: 'locationCode', label: '库位' },
    { key: 'batchNo', label: '批次' },
    { key: 'status', label: '状态' },
  ],
};

/** 给已有对象追加列。id 必须和基础记录相同，查询时会合并。 */
export function extraRecord(id: string, label: string, fields: ManifestRecordField[]): ManifestRecord {
  return { id, label, fields };
}
