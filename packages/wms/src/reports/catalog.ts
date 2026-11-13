import type { ReportCatalog, ReportFilterOp, ReportValueType } from './types.js';

/**
 * 报表能连的表。
 *
 * 每张明细表从自己的粒度出发，只做多对一：单据行带出单据、客户、商品、库位、仓库。
 * 不把一行乘上这个商品的每一个库存桶。库存、流水各自是另一张表。
 * sql 只来自这里，用户和助手提交的字段 id 对上了才允许进查询。
 */

export type FieldLookup = 'skuCode' | 'orderNo' | 'partnerCode';

export interface FieldSpec {
  id: string;
  label: string;
  type: ReportValueType;
  sql: string;
  selective?: boolean;
  /** eq / in 改写成主键条件 */
  lookup?: FieldLookup;
}

export interface GrainSpec {
  id: string;
  label: string;
  row: string;
  requireSelective: boolean;
  fields: FieldSpec[];
  defaultSort: { field: string; dir: 'asc' | 'desc' };
  /** 翻页时垫在用户排序后面，避免同值抖动 */
  tieBreak: string;
  fromLine: string;
  /** 单据行按客户、单号或日期收窄时，从单据表驱动再接到行 */
  fromOrder?: string;
  workspaceLine: string;
  workspaceOrder?: string;
  /** eq / in 收窄时改写到这些列，走已有索引 */
  skuIdExpr?: string;
  orderIdExpr?: string;
  partnerIdExpr?: string;
}

const TEXT_OPS: ReportFilterOp[] = ['eq', 'neq', 'contains', 'in'];
const NUMBER_OPS: ReportFilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const DATE_OPS: ReportFilterOp[] = ['eq', 'gt', 'gte', 'lt', 'lte'];

export const REPORT_FILTER_OPS: Record<ReportValueType, ReportFilterOp[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  date: DATE_OPS,
};

export const REPORT_SECTION_MAX = 8;
export const REPORT_COLUMN_MAX = 30;
export const REPORT_FILTER_MAX = 20;
export const REPORT_PARAM_MAX = 12;
export const REPORT_IN_MAX = 50;
export const REPORT_HTTP_PAGE_MAX = 200;
export const REPORT_TOOL_PAGE_MAX = 30;

type FieldInit = [
  id: string,
  label: string,
  type: ReportValueType,
  sql: string,
  extra?: Pick<FieldSpec, 'selective' | 'lookup'>,
];

function fields(rows: FieldInit[]): FieldSpec[] {
  return rows.map(([id, label, type, sql, extra]) => ({ id, label, type, sql, ...extra }));
}

const SKU: FieldInit[] = [
  ['sku.skuCode', '商品编码', 'text', 'sku.sku_code', { selective: true, lookup: 'skuCode' }],
  ['sku.name', '商品名称', 'text', 'sku.name'],
  ['sku.barcode', '条码', 'text', 'sku.barcode'],
  ['sku.unit', '单位', 'text', 'sku.unit'],
];

const LOC: FieldInit[] = [
  ['location.locationCode', '库位编码', 'text', "COALESCE(loc.location_code, line.location_id)"],
  ['location.name', '库位名称', 'text', 'loc.name'],
];

const WH: FieldInit[] = [
  ['warehouse.warehouseCode', '仓库编码', 'text', 'wh.warehouse_code'],
  ['warehouse.name', '仓库名称', 'text', 'wh.name'],
];

const PARTNER: FieldInit[] = [
  ['partner.partnerCode', '往来单位编码', 'text', 'partner.partner_code', { selective: true, lookup: 'partnerCode' }],
  ['partner.name', '往来单位名称', 'text', 'partner.name', { selective: true }],
  ['partner.phone', '电话', 'text', 'partner.phone'],
];

const ORDER_HEAD: FieldInit[] = [
  ['order.orderNo', '单号', 'text', 'ord.order_no', { selective: true, lookup: 'orderNo' }],
  ['order.direction', '方向', 'text', 'ord.direction'],
  ['order.state', '状态', 'text', 'ord.state'],
  ['order.createdAt', '创建时间', 'date', 'ord.created_at', { selective: true }],
  ['order.note', '备注', 'text', 'ord.note'],
  ['order.expectedAt', '预计到货', 'date', 'ord.expected_at'],
];

const ORDER_JOINS = `
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id
LEFT JOIN wms_partner AS partner ON partner.workspace_id = ord.workspace_id AND partner.id = ord.partner_id
LEFT JOIN wms_warehouse AS wh ON wh.workspace_id = loc.workspace_id AND wh.id = loc.warehouse_id`;

const GRAINS: GrainSpec[] = [
  {
    id: 'order_line',
    label: '单据行',
    row: '一行是一张出入库单上的一行明细',
    requireSelective: true,
    defaultSort: { field: 'order.createdAt', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    workspaceOrder: 'ord.workspace_id',
    skuIdExpr: 'line.sku_id',
    orderIdExpr: 'line.order_id',
    partnerIdExpr: 'ord.partner_id',
    fromLine: `FROM wms_order_line AS line
JOIN wms_order AS ord ON ord.workspace_id = line.workspace_id AND ord.id = line.order_id
${ORDER_JOINS}`,
    fromOrder: `FROM wms_order AS ord
JOIN wms_order_line AS line ON line.workspace_id = ord.workspace_id AND line.order_id = ord.id
${ORDER_JOINS}`,
    fields: fields([
      ...ORDER_HEAD,
      ...PARTNER,
      ...SKU,
      ...LOC,
      ...WH,
      ['line.batchNo', '批次', 'text', 'line.batch_no'],
      ['line.batchExpiryDate', '效期', 'date', 'line.batch_expiry_date'],
      ['line.quantity', '订单数量', 'number', 'line.quantity'],
      ['line.fulfilledQty', '已入账数量', 'number', 'line.fulfilled_qty'],
    ]),
  },
  {
    id: 'inventory',
    label: '库存桶',
    row: '一行是一个商品在一个库位的一个批次上的当前余量',
    requireSelective: false,
    defaultSort: { field: 'sku.skuCode', dir: 'asc' },
    tieBreak: 'line.location_id, line.batch_no',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_inventory AS line
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id
LEFT JOIN wms_warehouse AS wh ON wh.workspace_id = loc.workspace_id AND wh.id = loc.warehouse_id`,
    fields: fields([
      ...SKU,
      ...LOC,
      ...WH,
      ['inventory.batchNo', '批次', 'text', 'line.batch_no'],
      ['inventory.batchExpiryDate', '效期', 'date', 'line.batch_expiry_date'],
      ['inventory.quantity', '余量', 'number', 'line.quantity'],
      [
        'inventory.held',
        '冻结量（按商品）',
        'number',
        `(SELECT COALESCE(SUM(h.quantity), 0) FROM wms_inventory_hold AS h
          WHERE h.workspace_id = line.workspace_id AND h.sku_id = line.sku_id)`,
      ],
      [
        'inventory.reserved',
        '预占（本桶）',
        'number',
        `(SELECT COALESCE(SUM(r.quantity), 0) FROM wms_inventory_reservation AS r
          WHERE r.workspace_id = line.workspace_id AND r.sku_id = line.sku_id
            AND r.location_id = line.location_id AND r.batch_no = line.batch_no)`,
      ],
    ]),
  },
  {
    id: 'ledger',
    label: '库存流水',
    row: '一行是一次库存增减',
    requireSelective: true,
    defaultSort: { field: 'ledger.createdAt', dir: 'desc' },
    tieBreak: 'line.event_id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    orderIdExpr: 'line.order_id',
    partnerIdExpr: 'ord.partner_id',
    fromLine: `FROM wms_inventory_ledger AS line
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id
LEFT JOIN wms_warehouse AS wh ON wh.workspace_id = loc.workspace_id AND wh.id = loc.warehouse_id
LEFT JOIN wms_order AS ord ON ord.workspace_id = line.workspace_id AND ord.id = line.order_id
LEFT JOIN wms_partner AS partner ON partner.workspace_id = ord.workspace_id AND partner.id = ord.partner_id`,
    fields: fields([
      ['ledger.createdAt', '时间', 'date', 'line.created_at', { selective: true }],
      ['ledger.delta', '增减', 'number', 'line.delta'],
      ['ledger.reason', '原因', 'text', 'line.reason'],
      ['ledger.batchNo', '批次', 'text', 'line.batch_no'],
      ['ledger.batchExpiryDate', '效期', 'date', 'line.batch_expiry_date'],
      ...SKU,
      ...LOC,
      ...WH,
      ...ORDER_HEAD.filter((row) => row[0] !== 'order.createdAt'),
      ...PARTNER,
    ]),
  },
  {
    id: 'picking_line',
    label: '拣货行',
    row: '一行是拣货单上的一行',
    requireSelective: false,
    defaultSort: { field: 'picking.pickingNo', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    orderIdExpr: 'line.order_id',
    partnerIdExpr: 'ord.partner_id',
    fromLine: `FROM wms_picking_line AS line
JOIN wms_picking AS picking ON picking.workspace_id = line.workspace_id AND picking.id = line.picking_id
LEFT JOIN wms_order AS ord ON ord.workspace_id = line.workspace_id AND ord.id = line.order_id
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS sug ON sug.workspace_id = line.workspace_id AND sug.id = line.suggested_location_id
LEFT JOIN wms_location AS picked_loc ON picked_loc.workspace_id = line.workspace_id AND picked_loc.id = line.picked_location_id
LEFT JOIN wms_partner AS partner ON partner.workspace_id = ord.workspace_id AND partner.id = ord.partner_id`,
    fields: fields([
      ['picking.pickingNo', '拣货单号', 'text', 'picking.picking_no'],
      ['picking.state', '拣货状态', 'text', 'picking.state'],
      ['order.orderNo', '出库单号', 'text', 'ord.order_no', { lookup: 'orderNo' }],
      ['order.state', '出库状态', 'text', 'ord.state'],
      ...PARTNER,
      ...SKU,
      ['picking.qtyToPick', '应拣', 'number', 'line.qty_to_pick'],
      ['picking.pickedQty', '实拣', 'number', 'line.picked_qty'],
      ['picking.suggestedLocation', '建议库位', 'text', 'COALESCE(sug.location_code, line.suggested_location_id)'],
      ['picking.suggestedBatch', '建议批次', 'text', 'line.suggested_batch_no'],
      ['picking.pickedLocation', '实拣库位', 'text', 'COALESCE(picked_loc.location_code, line.picked_location_id)'],
      ['picking.pickedBatch', '实拣批次', 'text', 'line.picked_batch_no'],
      ['picking.confirmed', '已确认', 'number', 'line.confirmed'],
    ]),
  },
  {
    id: 'stocktake_line',
    label: '盘点行',
    row: '一行是盘点单上的一个库存桶',
    requireSelective: false,
    defaultSort: { field: 'stocktake.stocktakeNo', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_stocktake_line AS line
JOIN wms_stocktake AS st ON st.workspace_id = line.workspace_id AND st.id = line.stocktake_id
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id`,
    fields: fields([
      ['stocktake.stocktakeNo', '盘点单号', 'text', 'st.stocktake_no'],
      ['stocktake.state', '状态', 'text', 'st.state'],
      ...SKU,
      ...LOC,
      ['stocktake.batchNo', '批次', 'text', 'line.batch_no'],
      ['stocktake.expectedQty', '账面', 'number', 'line.expected_qty'],
      ['stocktake.countedQty', '实盘', 'number', 'line.counted_qty'],
    ]),
  },
  {
    id: 'transfer_line',
    label: '调拨行',
    row: '一行是调拨单上的一行',
    requireSelective: false,
    defaultSort: { field: 'transfer.transferNo', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_transfer_line AS line
JOIN wms_transfer AS tr ON tr.workspace_id = line.workspace_id AND tr.id = line.transfer_id
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc_from ON loc_from.workspace_id = line.workspace_id AND loc_from.id = line.from_location_id
LEFT JOIN wms_location AS loc_to ON loc_to.workspace_id = line.workspace_id AND loc_to.id = line.to_location_id
LEFT JOIN wms_warehouse AS wh_from ON wh_from.workspace_id = tr.workspace_id AND wh_from.id = tr.from_warehouse_id
LEFT JOIN wms_warehouse AS wh_to ON wh_to.workspace_id = tr.workspace_id AND wh_to.id = tr.to_warehouse_id`,
    fields: fields([
      ['transfer.transferNo', '调拨单号', 'text', 'tr.transfer_no'],
      ['transfer.state', '状态', 'text', 'tr.state'],
      ...SKU,
      ['transfer.batchNo', '批次', 'text', 'line.batch_no'],
      ['transfer.quantity', '数量', 'number', 'line.quantity'],
      ['transfer.fromLocation', '调出库位', 'text', 'COALESCE(loc_from.location_code, line.from_location_id)'],
      ['transfer.toLocation', '调入库位', 'text', 'COALESCE(loc_to.location_code, line.to_location_id)'],
      ['transfer.fromWarehouse', '调出仓库', 'text', 'wh_from.name'],
      ['transfer.toWarehouse', '调入仓库', 'text', 'wh_to.name'],
    ]),
  },
  {
    id: 'scrap_line',
    label: '报损行',
    row: '一行是报损单上的一行',
    requireSelective: false,
    defaultSort: { field: 'scrap.scrapNo', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_scrap_line AS line
JOIN wms_scrap AS scrap ON scrap.workspace_id = line.workspace_id AND scrap.id = line.scrap_id
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id`,
    fields: fields([
      ['scrap.scrapNo', '报损单号', 'text', 'scrap.scrap_no'],
      ['scrap.state', '状态', 'text', 'scrap.state'],
      ...SKU,
      ...LOC,
      ['scrap.batchNo', '批次', 'text', 'line.batch_no'],
      ['scrap.quantity', '数量', 'number', 'line.quantity'],
    ]),
  },
  {
    id: 'serial',
    label: '序列号',
    row: '一行是一个序列号',
    requireSelective: false,
    defaultSort: { field: 'serial.serialNo', dir: 'asc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_serial AS line
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id`,
    fields: fields([
      ['serial.serialNo', '序列号', 'text', 'line.serial_no'],
      ['serial.status', '状态', 'text', 'line.status'],
      ...SKU,
      ...LOC,
      ['serial.batchNo', '批次', 'text', 'line.batch_no'],
    ]),
  },
  {
    id: 'lpn_line',
    label: '托盘行',
    row: '一行是一个托盘上的一个商品批次',
    requireSelective: false,
    defaultSort: { field: 'lpn.lpnCode', dir: 'asc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_lpn_line AS line
JOIN wms_lpn AS lpn ON lpn.workspace_id = line.workspace_id AND lpn.id = line.lpn_id
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = lpn.workspace_id AND loc.id = lpn.location_id`,
    fields: fields([
      ['lpn.lpnCode', '托盘号', 'text', 'lpn.lpn_code'],
      ...SKU,
      ['location.locationCode', '库位编码', 'text', 'COALESCE(loc.location_code, lpn.location_id)'],
      ['location.name', '库位名称', 'text', 'loc.name'],
      ['lpn.batchNo', '批次', 'text', 'line.batch_no'],
      ['lpn.quantity', '数量', 'number', 'line.quantity'],
    ]),
  },
  {
    id: 'hold',
    label: '冻结',
    row: '一行是一笔还没释放的冻结',
    requireSelective: false,
    defaultSort: { field: 'hold.createdAt', dir: 'desc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    fromLine: `FROM wms_inventory_hold AS line
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id`,
    fields: fields([
      ...SKU,
      ['hold.quantity', '冻结数量', 'number', 'line.quantity'],
      ['hold.reason', '原因', 'text', 'line.reason'],
      ['hold.createdAt', '冻结时间', 'date', 'line.created_at'],
    ]),
  },
  {
    id: 'reservation',
    label: '拣货占用',
    row: '一行是一笔还没释放的拣货占用',
    requireSelective: false,
    defaultSort: { field: 'order.orderNo', dir: 'asc' },
    tieBreak: 'line.id',
    workspaceLine: 'line.workspace_id',
    skuIdExpr: 'line.sku_id',
    orderIdExpr: 'line.order_id',
    partnerIdExpr: 'ord.partner_id',
    fromLine: `FROM wms_inventory_reservation AS line
LEFT JOIN wms_sku AS sku ON sku.workspace_id = line.workspace_id AND sku.id = line.sku_id
LEFT JOIN wms_location AS loc ON loc.workspace_id = line.workspace_id AND loc.id = line.location_id
LEFT JOIN wms_order AS ord ON ord.workspace_id = line.workspace_id AND ord.id = line.order_id
LEFT JOIN wms_partner AS partner ON partner.workspace_id = ord.workspace_id AND partner.id = ord.partner_id`,
    fields: fields([
      ['order.orderNo', '出库单号', 'text', 'ord.order_no', { lookup: 'orderNo' }],
      ...PARTNER,
      ...SKU,
      ...LOC,
      ['reservation.batchNo', '批次', 'text', 'line.batch_no'],
      ['reservation.quantity', '占用数量', 'number', 'line.quantity'],
    ]),
  },
];

const BY_ID = new Map(GRAINS.map((grain) => [grain.id, grain]));

export function reportGrain(id: string): GrainSpec | undefined {
  return BY_ID.get(id);
}

export function reportGrains(): readonly GrainSpec[] {
  return GRAINS;
}

export function fieldOf(grain: GrainSpec, id: string): FieldSpec | undefined {
  return grain.fields.find((field) => field.id === id);
}

/** 这个条件算不算收窄。编码只认等于/属于，名称认等于/包含，日期认比较。 */
export function isSelectiveFilter(field: FieldSpec, op: string): boolean {
  if (!field.selective) return false;
  if (field.type === 'date') return op === 'eq' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
  if (field.lookup) return op === 'eq' || op === 'in';
  return op === 'eq' || op === 'contains';
}

/** 给人和助手看的目录。不含 SQL。 */
export function reportCatalog(): ReportCatalog {
  return {
    grains: GRAINS.map((grain) => ({
      id: grain.id,
      label: grain.label,
      row: grain.row,
      requireSelective: grain.requireSelective,
      fields: grain.fields.map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type,
        ...(field.selective ? { selective: true } : {}),
      })),
    })),
    filterOps: REPORT_FILTER_OPS,
    notes: [
      '一份报表最多 8 张表。每张表先选定粒度，再选这个粒度能连到的列。',
      '只沿主键连接。单据行可以带出单据、客户、商品、库位和仓库，不会乘上每个库存桶。库存和流水要另开一张表。',
      '单据行和流水至少要有一个收窄条件。标了 selective 的字段才算：日期用等于或不早于/不晚于，编码用等于或属于，往来单位名称用等于或包含。',
      '条件的 value 可以是字面量，或 { param: 参数key }。参数写在 parameters，type 取 text、number、date。',
      '一次一页。界面最多 200 行，助手调用请把 limit 放在 30 以内，用 offset 翻页。',
    ],
  };
}
