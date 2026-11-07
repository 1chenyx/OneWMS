/**
 * 档案与单据的表格契约：表头、模板、导出组表、导入预览。
 * 纯函数，不碰网络——页面负责拉数和提交。库存数量不在导入范围内
 * （库存的真相是流水，直接写数量会绕过护栏）。
 */
import type { InventoryBucketRow, InventoryRow, LedgerRow, Order, Sku } from '../api/wms-api';
import { headerIndex } from './csv';
import type { SheetTable } from './sheet';

export type ImportAction = 'create' | 'update' | 'error';

export interface PreviewRow {
  lineNo: number;
  action: ImportAction;
  reason?: string;
  /** 同一张单的行共用。缺省时按行提交。 */
  groupKey?: string;
}

export interface SkuImportRow extends PreviewRow {
  skuCode: string;
  name: string;
  unit: string;
  barcode: string;
  reorderPoint: number | null;
}

export interface LocationImportRow extends PreviewRow {
  locationCode: string;
  name: string;
}

export interface PartnerImportRow extends PreviewRow {
  partnerCode: string;
  kind: 'supplier' | 'customer' | '';
  name: string;
  contact: string;
  phone: string;
  address: string;
  note: string;
}

export interface OrderImportRow extends PreviewRow {
  groupKey: string;
  orderNo: string;
  direction: 'in' | 'out' | '';
  partnerCode: string;
  note: string;
  skuCode: string;
  quantity: number | null;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string;
}

export interface SkuLookup {
  skuCode: string;
  barcode: string | null;
}

export interface PartnerLookup {
  partnerCode: string;
  kind: 'supplier' | 'customer';
}

export interface OrderImportLookups {
  skuCodes: ReadonlySet<string>;
  partners: ReadonlyMap<string, 'supplier' | 'customer'>;
  locationCodes: ReadonlySet<string>;
  orderNos: ReadonlySet<string>;
}

export interface ExportExtension {
  key: string;
  label: string;
}

export const SKU_IMPORT_HEADERS = ['编码', '名称', '单位', '条码', '安全库存'] as const;
export const LOCATION_HEADERS = ['库位编码', '名称'] as const;
export const PARTNER_HEADERS = ['编码', '种类', '名称', '联系人', '电话', '地址', '备注'] as const;
export const ORDER_IMPORT_HEADERS = ['单号', '方向', '往来单位编码', '备注', 'SKU编码', '数量', '库位', '批次', '效期'] as const;

const SKU_ALIASES = {
  skuCode: ['skucode', '编码', 'sku编码', 'sku 编码'],
  name: ['name', '名称', '品名'],
  unit: ['unit', '单位', '数量单位'],
  barcode: ['barcode', '条码', '条形码'],
  reorderPoint: ['reorderpoint', '安全库存', '预警阈值'],
} as const;

const LOCATION_ALIASES = {
  locationCode: ['locationcode', '库位编码', '编码', '库位'],
  name: ['name', '名称', '库位名称'],
} as const;

const PARTNER_ALIASES = {
  partnerCode: ['partnercode', '编码', '往来单位编码'],
  kind: ['kind', '种类', '类型'],
  name: ['name', '名称'],
  contact: ['contact', '联系人'],
  phone: ['phone', '电话', '联系电话'],
  address: ['address', '地址'],
  note: ['note', '备注'],
} as const;

const ORDER_ALIASES = {
  orderNo: ['orderno', '单号', '单据号'],
  direction: ['direction', '方向'],
  partnerCode: ['partnercode', '往来单位编码', '供应商编码', '客户编码'],
  note: ['note', '备注'],
  skuCode: ['skucode', 'sku编码', 'sku 编码', '编码', '商品编码'],
  quantity: ['quantity', '数量'],
  locationCode: ['locationcode', '库位', '库位编码'],
  batchNo: ['batchno', '批次', '批次号'],
  batchExpiryDate: ['batchexpirydate', '效期', '批次效期'],
} as const;

const REORDER_MAX = 1_000_000_000;

export function pickColumn(headers: string[], aliases: readonly string[]): number | undefined {
  const idx = headerIndex(headers);
  for (const alias of aliases) {
    const hit = idx.get(alias.trim().toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function cell(row: string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (row[index] ?? '').trim();
}

function requireColumn(headers: string[], aliases: readonly string[], label: string): number {
  const index = pickColumn(headers, aliases);
  if (index === undefined) {
    throw new Error(`表头里找不到「${label}」列——先下载模板照着填`);
  }
  return index;
}

function dataRows(table: string[][]): string[][] {
  return table.slice(1);
}

function extCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function buildSkuSheet(list: readonly Sku[], extensions: readonly ExportExtension[]): SheetTable {
  return {
    headers: [...SKU_IMPORT_HEADERS, '状态', ...extensions.map((ext) => ext.label)],
    rows: list.map((sku) => [
      sku.skuCode,
      sku.name,
      sku.unit ?? '',
      sku.barcode ?? '',
      sku.reorderPoint,
      (sku.status ?? 'active') === 'archived' ? '已停用' : '启用',
      ...extensions.map((ext) => extCell(sku.extData[ext.key])),
    ]),
  };
}

export const SKU_TEMPLATE_ROWS: unknown[][] = [
  ['A-1001', '示例商品', '', '6901234567892', 50],
  ['BULK-01', '散装绿豆', 'kg', '', 0],
];

export function parseSkuTable(table: string[][], existing: readonly SkuLookup[]): SkuImportRow[] {
  if (table.length === 0) throw new Error('文件是空的');
  const headers = table[0] ?? [];
  const cCode = requireColumn(headers, SKU_ALIASES.skuCode, '编码');
  const cName = pickColumn(headers, SKU_ALIASES.name);
  const cUnit = pickColumn(headers, SKU_ALIASES.unit);
  const cBar = pickColumn(headers, SKU_ALIASES.barcode);
  const cRp = pickColumn(headers, SKU_ALIASES.reorderPoint);
  const byCode = new Map(existing.map((sku) => [sku.skuCode, sku] as const));
  const barcodeOwner = new Map(
    existing.filter((sku) => sku.barcode).map((sku) => [sku.barcode as string, sku.skuCode] as const),
  );
  const seen = new Map<string, number>();

  return dataRows(table).map((cells, i) => {
    const lineNo = i + 2;
    const skuCode = cell(cells, cCode);
    const name = cell(cells, cName);
    const unit = cell(cells, cUnit);
    const barcode = cell(cells, cBar);
    const rpRaw = cell(cells, cRp);
    const fail = (reason: string): SkuImportRow => ({
      lineNo,
      action: 'error',
      skuCode,
      name,
      unit,
      barcode,
      reorderPoint: null,
      reason,
    });

    if (!skuCode) return fail('编码为空');
    if (seen.has(skuCode)) return fail(`编码在文件内重复（与第 ${seen.get(skuCode)} 行）`);
    seen.set(skuCode, lineNo);

    let reorderPoint: number | null = null;
    if (rpRaw !== '') {
      const n = Number(rpRaw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > REORDER_MAX) {
        return fail(`安全库存「${rpRaw}」不是 0 到 ${REORDER_MAX} 的整数（填 0 或留空 = 不预警）`);
      }
      reorderPoint = n;
    }

    const found = byCode.get(skuCode);
    if (!found && !name) return fail('新建 SKU 必须填名称');
    const owner = barcode ? barcodeOwner.get(barcode) : undefined;
    if (owner && owner !== skuCode) return fail(`条码 ${barcode} 已被 ${owner} 占用`);
    if (barcode) barcodeOwner.set(barcode, skuCode);

    return {
      lineNo,
      action: found ? 'update' : 'create',
      skuCode,
      name,
      unit,
      barcode,
      reorderPoint,
    };
  });
}

export function buildLocationSheet(list: readonly { locationCode: string; name: string }[]): SheetTable {
  return {
    headers: [...LOCATION_HEADERS],
    rows: list.map((row) => [row.locationCode, row.name]),
  };
}

export const LOCATION_TEMPLATE_ROWS: unknown[][] = [
  ['A-01', 'A区01货架'],
  ['B-02', ''],
];

export function parseLocationTable(
  table: string[][],
  existingCodes: ReadonlySet<string>,
): LocationImportRow[] {
  if (table.length === 0) throw new Error('文件是空的');
  const headers = table[0] ?? [];
  const cCode = requireColumn(headers, LOCATION_ALIASES.locationCode, '库位编码');
  const cName = pickColumn(headers, LOCATION_ALIASES.name);
  const seen = new Map<string, number>();

  return dataRows(table).map((cells, i) => {
    const lineNo = i + 2;
    const locationCode = cell(cells, cCode);
    const name = cell(cells, cName);
    const fail = (reason: string): LocationImportRow => ({
      lineNo,
      action: 'error',
      locationCode,
      name,
      reason,
    });
    if (!locationCode) return fail('库位编码为空');
    if (locationCode === 'DEFAULT') return fail('DEFAULT 是保留字（默认库位，不用创建）');
    if (seen.has(locationCode)) return fail(`编码在文件内重复（与第 ${seen.get(locationCode)} 行）`);
    seen.set(locationCode, lineNo);
    return {
      lineNo,
      action: existingCodes.has(locationCode) ? 'update' : 'create',
      locationCode,
      name,
    };
  });
}

function parseKind(raw: string): 'supplier' | 'customer' | null {
  const text = raw.trim().toLowerCase();
  if (text === 'supplier' || text === '供应商') return 'supplier';
  if (text === 'customer' || text === '客户') return 'customer';
  return null;
}

export function kindLabel(kind: 'supplier' | 'customer' | ''): string {
  if (kind === 'supplier') return '供应商';
  if (kind === 'customer') return '客户';
  return '';
}

export function buildPartnerSheet(
  list: readonly {
    partnerCode: string;
    kind: 'supplier' | 'customer';
    name: string;
    contact: string | null;
    phone: string | null;
    address: string | null;
    note: string | null;
  }[],
): SheetTable {
  return {
    headers: [...PARTNER_HEADERS],
    rows: list.map((row) => [
      row.partnerCode,
      kindLabel(row.kind),
      row.name,
      row.contact ?? '',
      row.phone ?? '',
      row.address ?? '',
      row.note ?? '',
    ]),
  };
}

export const PARTNER_TEMPLATE_ROWS: unknown[][] = [
  ['SUP-001', '供应商', '示例供应商', '张三', '13800000000', '', ''],
  ['CUS-001', '客户', '示例客户', '', '', '', ''],
];

export function parsePartnerTable(table: string[][], existing: readonly PartnerLookup[]): PartnerImportRow[] {
  if (table.length === 0) throw new Error('文件是空的');
  const headers = table[0] ?? [];
  const cCode = requireColumn(headers, PARTNER_ALIASES.partnerCode, '编码');
  const cKind = requireColumn(headers, PARTNER_ALIASES.kind, '种类');
  const cName = pickColumn(headers, PARTNER_ALIASES.name);
  const cContact = pickColumn(headers, PARTNER_ALIASES.contact);
  const cPhone = pickColumn(headers, PARTNER_ALIASES.phone);
  const cAddress = pickColumn(headers, PARTNER_ALIASES.address);
  const cNote = pickColumn(headers, PARTNER_ALIASES.note);
  const byCode = new Map(existing.map((row) => [row.partnerCode, row] as const));
  const seen = new Map<string, number>();

  return dataRows(table).map((cells, i) => {
    const lineNo = i + 2;
    const partnerCode = cell(cells, cCode);
    const kindRaw = cell(cells, cKind);
    const kind = kindRaw ? parseKind(kindRaw) : null;
    const name = cell(cells, cName);
    const contact = cell(cells, cContact);
    const phone = cell(cells, cPhone);
    const address = cell(cells, cAddress);
    const note = cell(cells, cNote);
    const fail = (reason: string): PartnerImportRow => ({
      lineNo,
      action: 'error',
      partnerCode,
      kind: kind ?? '',
      name,
      contact,
      phone,
      address,
      note,
      reason,
    });

    if (!partnerCode) return fail('编码为空');
    if (kindRaw && !kind) return fail(`种类「${kindRaw}」无法识别，填「供应商」或「客户」`);

    const found = byCode.get(partnerCode);
    if (!found) {
      if (!kind) return fail('新建往来单位必须填种类（供应商 / 客户）');
      if (!name) return fail('新建往来单位必须填名称');
      if (seen.has(partnerCode)) return fail(`编码在文件内重复（与第 ${seen.get(partnerCode)} 行）`);
      seen.set(partnerCode, lineNo);
      return { lineNo, action: 'create', partnerCode, kind, name, contact, phone, address, note };
    }
    if (kind && kind !== found.kind) {
      return fail(`种类不能改（档案是${kindLabel(found.kind)}，表里写成了${kindLabel(kind)}）`);
    }
    if (seen.has(partnerCode)) return fail(`编码在文件内重复（与第 ${seen.get(partnerCode)} 行）`);
    seen.set(partnerCode, lineNo);
    return {
      lineNo,
      action: 'update',
      partnerCode,
      kind: found.kind,
      name,
      contact,
      phone,
      address,
      note,
    };
  });
}

function parseDirection(raw: string): 'in' | 'out' | null {
  const text = raw.trim().toLowerCase();
  if (text === 'in' || text === '入库') return 'in';
  if (text === 'out' || text === '出库') return 'out';
  return null;
}

/** 正数，最多 3 位小数。空串 / 非法返回原因。 */
function parseQty(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: '数量为空' };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, reason: `数量「${raw}」不是正数` };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `数量「${raw}」必须是正数` };
  const quantized = Math.round(n * 1000) / 1000;
  if (Math.abs(n - quantized) > 1e-9 || quantized <= 0) {
    return { ok: false, reason: `数量「${raw}」最多 3 位小数` };
  }
  return { ok: true, value: quantized };
}

function parseExpiry(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (!raw) return { ok: true, value: '' };
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!match) return { ok: false, reason: `效期「${raw}」要写成 YYYY-MM-DD` };
  const iso = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    return { ok: false, reason: `效期「${raw}」不是有效日期` };
  }
  return { ok: true, value: iso };
}

function mark(row: OrderImportRow, reason: string): void {
  if (row.action === 'error') return;
  row.action = 'error';
  row.reason = reason;
}

function sealOrderGroups(rows: OrderImportRow[], orderNos: ReadonlySet<string>): void {
  const groups = new Map<string, OrderImportRow[]>();
  for (const row of rows) {
    const list = groups.get(row.groupKey) ?? [];
    list.push(row);
    groups.set(row.groupKey, list);
  }
  for (const list of groups.values()) {
    const orderNo = list.find((row) => row.orderNo)?.orderNo ?? '';
    if (orderNo && orderNos.has(orderNo)) {
      for (const row of list) mark(row, `单号 ${orderNo} 已存在，导入只新建单据`);
    }
    const directions = new Set(list.map((row) => row.direction).filter((d) => d !== ''));
    if (directions.size > 1) {
      for (const row of list) mark(row, '同一单号的方向不一致');
    }
    const partners = new Set(list.map((row) => row.partnerCode).filter(Boolean));
    if (partners.size > 1) {
      for (const row of list) mark(row, '同一单号的往来单位不一致');
    }
    const notes = new Set(list.map((row) => row.note).filter(Boolean));
    if (notes.size > 1) {
      for (const row of list) mark(row, '同一单号的备注不一致');
    }
    const seenLine = new Map<string, number>();
    for (const row of list) {
      if (row.action === 'error' || !row.skuCode) continue;
      const key = `${row.skuCode}@${row.locationCode || 'DEFAULT'}@${row.batchNo || 'DEFAULT'}`;
      const prev = seenLine.get(key);
      if (prev !== undefined) {
        mark(row, `与第 ${prev} 行是同 SKU 同库位同批次，请合并数量`);
      } else {
        seenLine.set(key, row.lineNo);
      }
    }
    if (list.some((row) => row.action === 'error')) {
      for (const row of list) mark(row, '同单其他行有误，整单不导入');
    }
  }
}

export function buildOrderSheet(
  orders: readonly Order[],
  labelState: (state: string, direction: Order['direction']) => string,
): SheetTable {
  const headers = [
    ...ORDER_IMPORT_HEADERS.slice(0, 2),
    '状态',
    ...ORDER_IMPORT_HEADERS.slice(2, 4),
    '往来单位',
    ...ORDER_IMPORT_HEADERS.slice(4, 6),
    '名称',
    '单位',
    ...ORDER_IMPORT_HEADERS.slice(6),
    '创建时间',
  ];
  const rows: unknown[][] = [];
  for (const order of orders) {
    const lines = order.lines.length > 0 ? order.lines : [null];
    for (const line of lines) {
      rows.push([
        order.orderNo,
        order.direction === 'in' ? '入库' : '出库',
        labelState(order.state, order.direction),
        order.partnerCode ?? '',
        order.note ?? '',
        order.partnerName ?? '',
        line?.skuCode ?? '',
        line?.quantity ?? '',
        line?.name ?? '',
        line?.unit ?? '',
        line?.locationCode ?? '',
        line?.batchNo ?? '',
        line?.batchExpiryDate ?? '',
        order.createdAt.replace('T', ' ').slice(0, 19),
      ]);
    }
  }
  return { headers, rows };
}

export const ORDER_TEMPLATE_ROWS: unknown[][] = [
  ['IN-DEMO-1', '入库', 'SUP-001', '同单号合并为一张单', 'A-1001', 10, 'A-01', 'B202611', '2027-06-01'],
  ['IN-DEMO-1', '入库', '', '', 'BULK-01', 2.5, '', '', ''],
  ['', '出库', 'CUS-001', '单号留空则每行单独成单', 'A-1001', 1, '', '', ''],
];

export function parseOrderTable(table: string[][], lookups: OrderImportLookups): OrderImportRow[] {
  if (table.length === 0) throw new Error('文件是空的');
  const headers = table[0] ?? [];
  const cNo = pickColumn(headers, ORDER_ALIASES.orderNo);
  const cDir = requireColumn(headers, ORDER_ALIASES.direction, '方向');
  const cPartner = pickColumn(headers, ORDER_ALIASES.partnerCode);
  const cNote = pickColumn(headers, ORDER_ALIASES.note);
  const cSku = requireColumn(headers, ORDER_ALIASES.skuCode, 'SKU编码');
  const cQty = requireColumn(headers, ORDER_ALIASES.quantity, '数量');
  const cLoc = pickColumn(headers, ORDER_ALIASES.locationCode);
  const cBatch = pickColumn(headers, ORDER_ALIASES.batchNo);
  const cExpiry = pickColumn(headers, ORDER_ALIASES.batchExpiryDate);

  const rows = dataRows(table).map((cells, i): OrderImportRow => {
    const lineNo = i + 2;
    const orderNo = cell(cells, cNo);
    const directionRaw = cell(cells, cDir);
    const direction = directionRaw ? parseDirection(directionRaw) : null;
    const partnerCode = cell(cells, cPartner);
    const note = cell(cells, cNote);
    const skuCode = cell(cells, cSku);
    const locationCode = cell(cells, cLoc);
    const batchNo = cell(cells, cBatch);
    const expiryRaw = cell(cells, cExpiry);
    const base = {
      lineNo,
      groupKey: orderNo ? `no:${orderNo}` : `line:${lineNo}`,
      orderNo,
      direction: direction ?? ('' as const),
      partnerCode,
      note,
      skuCode,
      quantity: null as number | null,
      locationCode,
      batchNo,
      batchExpiryDate: '',
    };
    const fail = (reason: string): OrderImportRow => ({ ...base, action: 'error', reason });

    if (!direction) return fail(directionRaw ? `方向「${directionRaw}」无法识别，填「入库」或「出库」` : '方向为空');
    if (!skuCode) return fail('SKU 编码为空');
    if (!lookups.skuCodes.has(skuCode)) return fail(`SKU ${skuCode} 不存在，先在 SKU 管理里建档`);
    const qty = parseQty(cell(cells, cQty));
    if (!qty.ok) return fail(qty.reason);
    if (locationCode && locationCode !== 'DEFAULT' && !lookups.locationCodes.has(locationCode)) {
      return fail(`库位 ${locationCode} 不存在（不填则用默认库位 DEFAULT）`);
    }
    const expiry = parseExpiry(expiryRaw);
    if (!expiry.ok) return fail(expiry.reason);
    if (direction === 'out' && expiry.value) return fail('出库行不要填效期（效期在入库时声明）');
    if (partnerCode) {
      const kind = lookups.partners.get(partnerCode);
      if (!kind) return fail(`往来单位 ${partnerCode} 不存在`);
      const expected = direction === 'in' ? 'supplier' : 'customer';
      if (kind !== expected) {
        return fail(
          direction === 'in'
            ? `入库单要关联供应商，${partnerCode} 是客户`
            : `出库单要关联客户，${partnerCode} 是供应商`,
        );
      }
    }
    return {
      ...base,
      direction,
      quantity: qty.value,
      batchExpiryDate: expiry.value,
      action: 'create',
    };
  });
  sealOrderGroups(rows, lookups.orderNos);
  return rows;
}

export function directionLabel(direction: 'in' | 'out' | ''): string {
  if (direction === 'in') return '入库';
  if (direction === 'out') return '出库';
  return '';
}

export function buildInventorySummary(list: readonly InventoryRow[], showReserved: boolean): SheetTable {
  return {
    headers: ['编码', '名称', '单位', '当前余量', '冻结量', ...(showReserved ? ['预占'] : []), '可用量', '安全库存', '是否低于安全库存'],
    rows: list.map((row) => [
      row.skuCode,
      row.name,
      row.unit ?? '',
      row.quantity,
      row.held,
      ...(showReserved ? [row.reserved ?? 0] : []),
      row.available,
      row.reorderPoint,
      row.reorderPoint > 0 && row.available < row.reorderPoint ? '是' : '否',
    ]),
  };
}

export function buildInventoryBuckets(list: readonly InventoryBucketRow[]): SheetTable {
  return {
    headers: ['编码', '名称', '单位', '库位', '批次号', '批次效期', '余量'],
    rows: list.map((row) => [
      row.skuCode,
      row.name,
      row.unit ?? '',
      row.locationCode,
      row.batchNo,
      row.batchExpiryDate ?? '',
      row.quantity,
    ]),
  };
}

export function buildLedgerSheet(list: readonly LedgerRow[]): SheetTable {
  return {
    headers: ['时间', '编码', '名称', '库位', '批次号', '批次效期', '变动数量', '原因', '关联单据'],
    rows: list.map((row) => [
      row.createdAt.replace('T', ' ').slice(0, 19),
      row.skuCode,
      row.name,
      row.locationCode,
      row.batchNo,
      row.batchExpiryDate ?? '',
      row.delta,
      row.reason,
      row.orderNo ?? '',
    ]),
  };
}
