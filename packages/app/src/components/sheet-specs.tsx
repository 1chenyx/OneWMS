import type { ColumnsType } from 'antd/es/table';
import { api } from '../api/client';
import type { Order } from '../api/client';
import type { ExportExtension, LocationImportRow, OrderImportRow, PartnerImportRow, PreviewRow, SkuImportRow } from '../lib/exchange';
import {
  LOCATION_HEADERS,
  LOCATION_TEMPLATE_ROWS,
  ORDER_IMPORT_HEADERS,
  ORDER_TEMPLATE_ROWS,
  PARTNER_HEADERS,
  PARTNER_TEMPLATE_ROWS,
  SKU_IMPORT_HEADERS,
  SKU_TEMPLATE_ROWS,
  buildInventoryBuckets,
  buildInventorySummary,
  buildLedgerSheet,
  buildLocationSheet,
  buildOrderSheet,
  buildPartnerSheet,
  buildSkuSheet,
  directionLabel,
  kindLabel,
  parseLocationTable,
  parseOrderTable,
  parsePartnerTable,
  parseSkuTable,
} from '../lib/exchange';
import SheetPort, { actionColumn, lineNoColumn, reasonColumn, textColumn } from './SheetPort';
import type { ExportJob, ImportSpec } from './SheetPort';

/**
 * 各页的导入导出规格。提交仍走原来的建档/建单接口，失败的行跳过。
 * 库存只导出：数量不能靠表格改，期初用库存页的「调整」。
 */

function previewColumns<T extends PreviewRow>(middle: ColumnsType<T>): ColumnsType<T> {
  return [lineNoColumn<T>(), actionColumn<T>(), ...middle, reasonColumn<T>()];
}

const skuColumns: ColumnsType<SkuImportRow> = previewColumns<SkuImportRow>([
  textColumn<SkuImportRow>('编码', 'skuCode', { mono: true, width: 140 }),
  textColumn<SkuImportRow>('名称', 'name'),
  textColumn<SkuImportRow>('单位', 'unit', { width: 80 }),
  textColumn<SkuImportRow>('条码', 'barcode', { mono: true }),
  {
    title: '安全库存',
    dataIndex: 'reorderPoint',
    width: 90,
    align: 'right',
    render: (value: number | null) => (value === null ? '-' : value),
  },
]);

const locationColumns: ColumnsType<LocationImportRow> = previewColumns<LocationImportRow>([
  textColumn<LocationImportRow>('库位编码', 'locationCode', { mono: true, width: 160 }),
  textColumn<LocationImportRow>('名称', 'name'),
]);

const partnerColumns: ColumnsType<PartnerImportRow> = previewColumns<PartnerImportRow>([
  textColumn<PartnerImportRow>('编码', 'partnerCode', { mono: true, width: 140 }),
  {
    title: '种类',
    dataIndex: 'kind',
    width: 90,
    render: (value: PartnerImportRow['kind']) => kindLabel(value) || '-',
  },
  textColumn<PartnerImportRow>('名称', 'name'),
  textColumn<PartnerImportRow>('联系人', 'contact', { width: 100 }),
  textColumn<PartnerImportRow>('电话', 'phone', { width: 140 }),
]);

const orderColumns: ColumnsType<OrderImportRow> = previewColumns<OrderImportRow>([
  textColumn<OrderImportRow>('单号', 'orderNo', { mono: true, width: 140 }),
  {
    title: '方向',
    dataIndex: 'direction',
    width: 80,
    render: (value: OrderImportRow['direction']) => directionLabel(value) || '-',
  },
  textColumn<OrderImportRow>('往来单位', 'partnerCode', { mono: true, width: 120 }),
  textColumn<OrderImportRow>('SKU', 'skuCode', { mono: true, width: 120 }),
  {
    title: '数量',
    dataIndex: 'quantity',
    width: 80,
    align: 'right',
    render: (value: number | null) => (value === null ? '-' : value),
  },
]);

function skuImportSpec(): ImportSpec<SkuImportRow> {
  return {
    title: '导入 SKU',
    hint: (
      <>
        编码已存在就更新名称、单位、条码、安全库存（留空的列不改），不存在就新建。状态和自定义字段只随导出带出，导入不改。
        <br />
        请用 Excel。以前的 CSV 也能选。条码、以 0 开头的编码请在 Excel 里设成文本，避免被当成数字。
      </>
    ),
    template: {
      filename: 'SKU导入模板',
      sheetName: 'SKU',
      headers: [...SKU_IMPORT_HEADERS],
      rows: SKU_TEMPLATE_ROWS,
      success: '模板已下载：编码必填；新建时名称必填；单位、条码、安全库存可留空',
    },
    columns: skuColumns,
    parse: async (table) => {
      const list = await api.skus({ includeArchived: true });
      return parseSkuTable(
        table,
        list.map((sku) => ({ skuCode: sku.skuCode, barcode: sku.barcode })),
      );
    },
    commit: async (row) => {
      if (row.action === 'create') {
        await api.createSku({
          skuCode: row.skuCode,
          name: row.name,
          ...(row.unit ? { unit: row.unit } : {}),
          ...(row.barcode ? { barcode: row.barcode } : {}),
          ...(row.reorderPoint !== null ? { reorderPoint: row.reorderPoint } : {}),
        });
        return;
      }
      const body: { name?: string; unit?: string; barcode?: string; reorderPoint?: number } = {};
      if (row.name) body.name = row.name;
      if (row.unit) body.unit = row.unit;
      if (row.barcode) body.barcode = row.barcode;
      if (row.reorderPoint !== null) body.reorderPoint = row.reorderPoint;
      if (Object.keys(body).length === 0) return;
      await api.updateSku(row.skuCode, body);
    },
    invalidateKeys: [['skus'], ['inventory']],
  };
}

export function SkuSheetPort({ extensions }: { extensions: readonly ExportExtension[] }) {
  const jobs: ExportJob[] = [
    {
      key: 'skus',
      label: 'SKU 档案',
      filename: 'SKU档案',
      sheetName: 'SKU',
      build: async () => {
        const list = await api.skus({ includeArchived: true });
        return buildSkuSheet(list, extensions);
      },
    },
  ];
  return <SheetPort exports={jobs} importSpec={skuImportSpec()} />;
}

export function LocationSheetPort() {
  const jobs: ExportJob[] = [
    {
      key: 'locations',
      label: '库位',
      filename: '库位',
      sheetName: '库位',
      build: async () => buildLocationSheet(await api.locations()),
    },
  ];
  const importSpec: ImportSpec<LocationImportRow> = {
    title: '导入库位',
    hint: (
      <>
        编码已存在就改名称（名称留空则不改），不存在就新建。编码不能改，库位也不能删。DEFAULT 是保留字，不用导入。
        <br />
        请用 Excel。以前的 CSV 也能选。
      </>
    ),
    template: {
      filename: '库位导入模板',
      sheetName: '库位',
      headers: [...LOCATION_HEADERS],
      rows: LOCATION_TEMPLATE_ROWS,
      success: '模板已下载：库位编码必填，名称可留空（留空则与编码相同）',
    },
    columns: locationColumns,
    parse: async (table) => {
      const list = await api.locations();
      return parseLocationTable(table, new Set(list.map((row) => row.locationCode)));
    },
    commit: async (row) => {
      if (row.action === 'create') {
        await api.createLocation({
          locationCode: row.locationCode,
          ...(row.name ? { name: row.name } : {}),
        });
        return;
      }
      if (!row.name) return;
      await api.updateLocation(row.locationCode, { name: row.name });
    },
    invalidateKeys: [['locations'], ['dashboard']],
  };
  return <SheetPort exports={jobs} importSpec={importSpec} />;
}

export function PartnerSheetPort() {
  const jobs: ExportJob[] = [
    {
      key: 'partners',
      label: '往来单位',
      filename: '往来单位',
      sheetName: '往来单位',
      build: async () => buildPartnerSheet(await api.partners()),
    },
  ];
  const importSpec: ImportSpec<PartnerImportRow> = {
    title: '导入往来单位',
    hint: (
      <>
        编码已存在就更新名称和联系方式（留空的列不改），不存在就新建。种类填「供应商」或「客户」，建档后不能改种类。
        <br />
        请用 Excel。以前的 CSV 也能选。电话若以 0 开头，请把该列设成文本。
      </>
    ),
    template: {
      filename: '往来单位导入模板',
      sheetName: '往来单位',
      headers: [...PARTNER_HEADERS],
      rows: PARTNER_TEMPLATE_ROWS,
      success: '模板已下载：编码、种类、名称必填；联系人、电话、地址、备注可留空',
    },
    columns: partnerColumns,
    parse: async (table) => {
      const list = await api.partners();
      return parsePartnerTable(
        table,
        list.map((row) => ({ partnerCode: row.partnerCode, kind: row.kind })),
      );
    },
    commit: async (row) => {
      if (row.action === 'create') {
        if (row.kind !== 'supplier' && row.kind !== 'customer') {
          throw new Error('种类无效');
        }
        await api.createPartner({
          partnerCode: row.partnerCode,
          kind: row.kind,
          name: row.name,
          ...(row.contact ? { contact: row.contact } : {}),
          ...(row.phone ? { phone: row.phone } : {}),
          ...(row.address ? { address: row.address } : {}),
          ...(row.note ? { note: row.note } : {}),
        });
        return;
      }
      const body: { name?: string; contact?: string; phone?: string; address?: string; note?: string } = {};
      if (row.name) body.name = row.name;
      if (row.contact) body.contact = row.contact;
      if (row.phone) body.phone = row.phone;
      if (row.address) body.address = row.address;
      if (row.note) body.note = row.note;
      if (Object.keys(body).length === 0) return;
      await api.updatePartner(row.partnerCode, body);
    },
    invalidateKeys: [['partners']],
  };
  return <SheetPort exports={jobs} importSpec={importSpec} />;
}

export function OrderSheetPort({
  labelState,
}: {
  labelState: (state: string, direction: Order['direction']) => string;
}) {
  const jobs: ExportJob[] = [
    {
      key: 'orders',
      label: '出入库单',
      filename: '出入库单',
      sheetName: '出入库单',
      build: async () => buildOrderSheet(await api.orders(), labelState),
    },
  ];
  const importSpec: ImportSpec<OrderImportRow> = {
    title: '导入出入库单',
    hint: (
      <>
        每一行是一条明细。相同单号合并成一张单；单号留空则每行单独成单，单号由系统生成。只新建单据，已有单号会整单跳过，不会改旧单，也不会自动收货或出库。
        <br />
        导入后单据停在「已创建」，要在本页点流转才会动库存。SKU、库位、往来单位都要先有档案。
      </>
    ),
    template: {
      filename: '出入库单导入模板',
      sheetName: '出入库单',
      headers: [...ORDER_IMPORT_HEADERS],
      rows: ORDER_TEMPLATE_ROWS,
      success: '模板已下载：方向、SKU、数量必填。示例单号导入前请改成新单号，或留空让系统生成',
    },
    columns: orderColumns,
    parse: async (table) => {
      const [skus, partners, locations, orders] = await Promise.all([
        api.skus({ includeArchived: true }),
        api.partners(),
        api.locations(),
        api.orders(),
      ]);
      return parseOrderTable(table, {
        skuCodes: new Set(skus.map((sku) => sku.skuCode)),
        partners: new Map(partners.map((row) => [row.partnerCode, row.kind] as const)),
        locationCodes: new Set(locations.map((row) => row.locationCode)),
        orderNos: new Set(orders.map((order) => order.orderNo)),
      });
    },
    commitGroup: async (rows) => {
      const head = rows[0];
      if (!head || (head.direction !== 'in' && head.direction !== 'out')) {
        throw new Error('单据方向无效');
      }
      const partnerCode = rows.map((row) => row.partnerCode).find(Boolean);
      const note = rows.map((row) => row.note).find(Boolean);
      await api.createOrder({
        direction: head.direction,
        ...(head.orderNo ? { orderNo: head.orderNo } : {}),
        ...(partnerCode ? { partnerCode } : {}),
        ...(note ? { note } : {}),
        lines: rows.map((row) => ({
          skuCode: row.skuCode,
          quantity: row.quantity ?? 0,
          ...(row.locationCode ? { locationCode: row.locationCode } : {}),
          ...(row.batchNo ? { batchNo: row.batchNo } : {}),
          ...(row.batchExpiryDate ? { batchExpiryDate: row.batchExpiryDate } : {}),
        })),
      });
    },
    invalidateKeys: [['orders'], ['dashboard']],
  };
  return <SheetPort exports={jobs} importSpec={importSpec} />;
}

export function InventorySheetPort({ reservationOn }: { reservationOn: boolean }) {
  const jobs: ExportJob[] = [
    {
      key: 'summary',
      label: '库存汇总',
      filename: '库存汇总',
      sheetName: '库存汇总',
      build: async () => {
        const list = await api.inventory();
        const showReserved = reservationOn || list.some((row) => (row.reserved ?? 0) > 0);
        return buildInventorySummary(list, showReserved);
      },
    },
    {
      key: 'buckets',
      label: '库存分桶',
      filename: '库存分桶',
      sheetName: '库存分桶',
      build: async () => buildInventoryBuckets(await api.inventoryBuckets()),
    },
    {
      key: 'ledger',
      label: '库存流水（最近 5000 条）',
      filename: '库存流水',
      sheetName: '库存流水',
      build: async () => buildLedgerSheet(await api.ledger({ limit: 5000 })),
    },
  ];
  return <SheetPort exports={jobs} />;
}
