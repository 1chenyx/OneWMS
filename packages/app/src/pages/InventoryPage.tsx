import { useState } from 'react';
import { EditOutlined, LockOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  useAdjustInventory,
  useCreateHold,
  useHolds,
  useInventory,
  useInventorySlices,
  useLocations,
  useProfileSnapshot,
  useReleaseHold,
  useSkus,
  useWarehouses,
} from '../api/hooks';
import { ApiError, api } from '../api/client';
import type { InventoryRow, InventorySliceDetail, InventorySliceRow, InventorySliceView } from '../api/client';
import { isListPage, rowsOf, useListPage } from '../api/page';
import type { InventoryListPage } from '../api/wms-api';
import { useAppNav } from '../app-nav';
import ScanInput from '../components/ScanInput';
import PageHeader from '../components/PageHeader';
import ReplenishModal from '../components/ReplenishModal';
import { InventorySheetPort } from '../components/sheet-specs';
import { serverPagination, monoCell, numCell } from '../components/table-style';
import { fmtQty } from '../lib/format';
import { downloadXlsx, xlsxName } from '../lib/sheet';
import { downloadCsv, fileStamp, toCsv } from '../lib/csv';

/**
 * 库存页：默认按 SKU 合计（余量 / 冻结 / 可用量 / 安全库存）。
 * 按库位、按批次、按仓库，或在按 SKU 上筛了库位、批次、仓库时，只显示实物余量。
 * 冻结和可用量是 SKU 级的，不挂到某一桶上。
 * 调整走 wms.inventory.adjust；冻结走 wms.inventory.hold / release。
 * AI 跳转携带的 skuCode 预填过滤框。扫条码或编码打开该 SKU 的调整弹窗。
 */
export default function InventoryPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const [keyword, setKeyword] = useState(() => takeInitialFilter()?.skuCode ?? '');
  const [lowOnly, setLowOnly] = useState(false);
  const [view, setView] = useState<InventorySliceView>('sku');
  const [locationCode, setLocationCode] = useState<string | undefined>();
  const [batchNo, setBatchNo] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState<string | undefined>();
  const snapshot = useProfileSnapshot();
  const warehouseOn = snapshot.data?.modules['module.warehouse']?.enabled === true;
  const activeView: InventorySliceView = view === 'warehouse' && !warehouseOn ? 'sku' : view;
  const kw = keyword.trim();
  const batchKey = batchNo.trim();
  const warehouseKey = warehouseOn ? (warehouseFilter ?? '') : '';
  const dimensionFiltered = Boolean(locationCode || batchKey || warehouseKey);
  const sliced = activeView !== 'sku' || dimensionFiltered;
  const list = useListPage(`${activeView}|${kw}|${sliced ? 0 : lowOnly ? 1 : 0}|${locationCode ?? ''}|${batchKey}|${warehouseKey}`);
  const { data, isLoading } = useInventory({
    q: kw || undefined,
    lowOnly: sliced ? false : lowOnly,
    limit: list.limit,
    offset: list.offset,
  });
  const sliceQuery = useInventorySlices(
    sliced
      ? {
          view: activeView,
          q: kw || undefined,
          locationCode,
          batchNo: batchKey || undefined,
          ...(warehouseKey === '__unassigned__'
            ? { unassigned: true }
            : warehouseKey
              ? { warehouseCode: warehouseKey }
              : {}),
          limit: list.limit,
          offset: list.offset,
        }
      : null,
  );
  const { data: locations } = useLocations();
  const { data: warehouses } = useWarehouses(warehouseOn);
  const payload = data as InventoryRow[] | InventoryListPage | undefined;
  const loaded = rowsOf(payload);
  const { data: skus } = useSkus();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [preset, setPreset] = useState<InventoryRow | null>(null);
  const [holdRow, setHoldRow] = useState<InventoryRow | null>(null);
  const [replenishOpen, setReplenishOpen] = useState(false);

  /** 低库存判定（M20）：安全库存 > 0 且可用量 < 阈值（与 wms.inventory.lowstock 工具同一口径） */
  const isLow = (r: InventoryRow) => r.reorderPoint > 0 && r.available < r.reorderPoint;

  // 测试桩返回整表。服务端分页时 q / lowOnly 已经过滤过。
  const visibleRows = isListPage(payload)
    ? loaded
    : loaded
        .filter((r) =>
          kw
            ? r.skuCode.toLowerCase().includes(kw.toLowerCase()) || r.name.toLowerCase().includes(kw.toLowerCase())
            : true,
        )
        .filter((r) => (lowOnly ? isLow(r) : true));

  const openAdjust = (row: InventoryRow | null) => {
    setPreset(row);
    setAdjustOpen(true);
  };

  const handleScan = (code: string) => {
    // 条码优先，编码兜底（扫的可能是商品条码，手工输的可能是编码）
    const sku = (skus ?? []).find((s) => s.barcode === code) ?? (skus ?? []).find((s) => s.skuCode === code);
    if (!sku) {
      message.warning(`没有条码/编码为 ${code} 的 SKU`);
      return;
    }
    const blank = { skuId: sku.id, skuCode: sku.skuCode, name: sku.name, quantity: 0 } as InventoryRow;
    const found = loaded.find((r) => r.skuCode === sku.skuCode);
    if (found || !isListPage(payload)) {
      openAdjust(found ?? blank);
      return;
    }
    // 当前页没有这行时按编码再要一页，避免把别的页上的余量看成 0。
    void api
      .inventory({ skuCode: sku.skuCode, limit: 1, offset: 0 })
      .then((page) => {
        openAdjust(page.rows[0] ?? blank);
      })
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)));
  };

  const reservationOn = snapshot.data?.modules['module.reservation']?.enabled === true;
  const replenishOn = snapshot.data?.modules['module.replenish']?.enabled === true;
  const showReserved =
    reservationOn ||
    (isListPage(payload) ? payload.hasReserved : loaded.some((r) => (r.reserved ?? 0) > 0));

  // ── 导出：当前筛选条件下的全量数据（服务端分页，按 200/页循环拉全）──
  const [exporting, setExporting] = useState(false);
  const fetchAllExport = async (): Promise<{ headers: string[]; rows: unknown[][] }> => {
    if (sliced) {
      const all: InventorySliceRow[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await api.inventorySlices({
          view: activeView,
          q: kw || undefined,
          locationCode,
          batchNo: batchKey || undefined,
          ...(warehouseKey === '__unassigned__'
            ? { unassigned: true }
            : warehouseKey
              ? { warehouseCode: warehouseKey }
              : {}),
          limit: 200,
          offset,
        });
        all.push(...page.rows);
        if (!page.hasMore || page.rows.length === 0) break;
      }
      const headers =
        activeView === 'location'
          ? ['编码', '名称', '库位', '库位名称', '余量']
          : activeView === 'batch'
            ? ['编码', '名称', '批次', '效期', '余量']
            : activeView === 'warehouse'
              ? ['仓库', '编码', '名称', '余量']
              : ['编码', '名称', '余量'];
      return {
        headers,
        rows: all.map((r) => {
          const qty = r.quantity;
          if (activeView === 'location') return [r.skuCode, r.name, r.locationCode ?? '', r.locationName ?? '', qty];
          if (activeView === 'batch') return [r.skuCode, r.name, r.batchNo ?? '', r.batchExpiryDate ?? '', qty];
          if (activeView === 'warehouse') return [warehouseLabel(r), r.skuCode, r.name, qty];
          return [r.skuCode, r.name, qty];
        }),
      };
    }
    const all: InventoryRow[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await api.inventory({ q: kw || undefined, lowOnly, limit: 200, offset });
      all.push(...page.rows);
      if (!page.hasMore || page.rows.length === 0) break;
    }
    const withReserved = reservationOn || all.some((r) => (r.reserved ?? 0) > 0);
    const headers = ['编码', '名称', '当前余量', '冻结量', ...(withReserved ? ['预占'] : []), '可用量', '安全库存'];
    return {
      headers,
      rows: all.map((r) => [
        r.skuCode,
        r.name,
        r.quantity,
        r.held,
        ...(withReserved ? [r.reserved ?? 0] : []),
        r.available,
        r.reorderPoint,
      ]),
    };
  };

  const doExport = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      const table = await fetchAllExport();
      if (format === 'xlsx') {
        await downloadXlsx(xlsxName('库存汇总'), '库存汇总', table);
      } else {
        downloadCsv(`库存汇总-${fileStamp()}.csv`, toCsv(table.headers, table.rows));
      }
      message.success(`已导出 ${table.rows.length} 行（当前筛选条件下的全量数据）`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : `导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<InventoryRow> = [
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '当前余量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right',
      onCell: numCell,
      sorter: (a, b) => a.quantity - b.quantity,
      render: (v: number, r) => <Typography.Text strong>{fmtQty(v, r.unit)}</Typography.Text>,
    },
    {
      title: '冻结量',
      dataIndex: 'held',
      key: 'held',
      align: 'right',
      onCell: numCell,
      sorter: (a, b) => a.held - b.held,
      render: (v: number, r) =>
        v > 0 ? <Typography.Text type="warning">{fmtQty(v, r.unit)}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    ...(showReserved
      ? [
          {
            title: '预占',
            dataIndex: 'reserved',
            key: 'reserved',
            align: 'right' as const,
            onCell: numCell,
            sorter: (a: InventoryRow, b: InventoryRow) => (a.reserved ?? 0) - (b.reserved ?? 0),
            render: (v: number | undefined, r: InventoryRow) =>
              (v ?? 0) > 0 ? (
                <Typography.Text type="warning">{fmtQty(v ?? 0, r.unit)}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">-</Typography.Text>
              ),
          },
        ]
      : []),
    {
      title: '可用量',
      dataIndex: 'available',
      key: 'available',
      align: 'right',
      onCell: numCell,
      sorter: (a, b) => a.available - b.available,
      // 低于安全库存（M20）或为负（M19 物理修正极端态）都标红
      render: (v: number, r) =>
        v < 0 || isLow(r) ? (
          <Typography.Text type="danger" strong={isLow(r)}>
            {fmtQty(v, r.unit)}
          </Typography.Text>
        ) : (
          fmtQty(v, r.unit)
        ),
    },
    {
      title: '安全库存',
      dataIndex: 'reorderPoint',
      key: 'reorderPoint',
      align: 'right',
      onCell: numCell,
      sorter: (a, b) => a.reorderPoint - b.reorderPoint,
      render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" onClick={() => openAdjust(r)}>
            调整
          </Button>
          <Button size="small" icon={<LockOutlined />} onClick={() => setHoldRow(r)}>
            冻结
          </Button>
        </Space>
      ),
    },
  ];

  const locationOptions = [
    { value: 'DEFAULT', label: 'DEFAULT · 默认库位' },
    ...(locations ?? []).map((location) => ({
      value: location.locationCode,
      label:
        location.name && location.name !== location.locationCode
          ? `${location.locationCode} · ${location.name}`
          : location.locationCode,
    })),
  ];
  const sliceRows = sliceQuery.isError ? [] : (sliceQuery.data?.rows ?? []);

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="库存"
        subtitle={
          sliced
            ? '实物余量。冻结、预占和可用量只在按 SKU、且不筛库位 / 批次 / 仓库时显示。'
            : warehouseOn
              ? '按 SKU 合计：余量 / 冻结 / 可用量（低于安全库存标红）。换视角可看库位、批次或仓库。'
              : '按 SKU 合计：余量 / 冻结 / 可用量（低于安全库存标红）。换视角可看库位或批次。'
        }
        extra={
          <>
            <Segmented<InventorySliceView>
              value={activeView}
              onChange={setView}
              options={[
                { value: 'sku', label: '按 SKU' },
                { value: 'location', label: '按库位' },
                { value: 'batch', label: '按批次' },
                ...(warehouseOn ? [{ value: 'warehouse' as const, label: '按仓库' }] : []),
              ]}
            />
            <ScanInput onScan={handleScan} />
            <Input
              allowClear
              placeholder="按编码/名称过滤"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 180 }}
            />
            <Select
              aria-label="库位"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="库位"
              value={locationCode}
              onChange={(value) => setLocationCode(value)}
              options={locationOptions}
              style={{ width: 180 }}
            />
            <Input
              allowClear
              aria-label="批次号"
              placeholder="批次号"
              value={batchNo}
              onChange={(e) => setBatchNo(e.target.value)}
              style={{ width: 140 }}
            />
            {warehouseOn ? (
              <Select
                aria-label="仓库"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="仓库"
                value={warehouseFilter}
                onChange={(value) => setWarehouseFilter(value)}
                options={[
                  { value: '__unassigned__', label: '未分仓' },
                  ...(warehouses ?? []).map((warehouse) => ({
                    value: warehouse.warehouseCode,
                    label:
                      warehouse.name && warehouse.name !== warehouse.warehouseCode
                        ? `${warehouse.warehouseCode} · ${warehouse.name}`
                        : warehouse.warehouseCode,
                  })),
                ]}
                style={{ width: 180 }}
              />
            ) : null}
            {sliced ? null : (
              <Checkbox checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)}>
                只看低库存
              </Checkbox>
            )}
            {replenishOn ? <Button onClick={() => setReplenishOpen(true)}>生成补货单</Button> : null}
            <Button loading={exporting} onClick={() => doExport('csv')}>导出 CSV</Button>
            <Button loading={exporting} onClick={() => doExport('xlsx')}>导出 Excel</Button>
            <InventorySheetPort reservationOn={reservationOn} />
            <Button type="primary" icon={<EditOutlined />} onClick={() => openAdjust(null)}>
              库存调整
            </Button>
          </>
        }
      />
      <Card className="list-card">
        {sliced ? (
          <Table<InventorySliceRow>
            rowKey="key"
            columns={sliceColumns(activeView)}
            dataSource={sliceRows}
            loading={sliceQuery.isLoading}
            pagination={serverPagination({
              current: list.page,
              total: sliceQuery.isError ? 0 : (sliceQuery.data?.total ?? 0),
              onChange: list.setPage,
            })}
            locale={{
              emptyText: sliceQuery.isError
                ? sliceQuery.error instanceof Error
                  ? sliceQuery.error.message
                  : '库存查询失败'
                : '没有符合条件的实物库存',
            }}
            expandable={{
              rowExpandable: (row) => row.details.length > 0,
              expandedRowRender: (row) => <SliceDetailTable details={row.details} unit={row.unit} />,
            }}
          />
        ) : (
          <Table<InventoryRow>
            rowKey="skuId"
            columns={columns}
            dataSource={visibleRows}
            loading={isLoading}
            pagination={serverPagination({
              current: list.page,
              total: isListPage(payload) ? payload.total : visibleRows.length,
              onChange: list.setPage,
            })}
            locale={{ emptyText: '还没有库存流水（录入期初或调整后出现）' }}
          />
        )}
        <AdjustModal open={adjustOpen} preset={preset} onClose={() => setAdjustOpen(false)} />
        <HoldModal row={holdRow} onClose={() => setHoldRow(null)} />
        {replenishOn ? <ReplenishModal open={replenishOpen} onClose={() => setReplenishOpen(false)} /> : null}
      </Card>
    </div>
  );
}

function sliceColumns(view: InventorySliceView): ColumnsType<InventorySliceRow> {
  const skuColumns: ColumnsType<InventorySliceRow> = [
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
  ];
  const quantityColumn: ColumnsType<InventorySliceRow>[number] = {
    title: '余量',
    dataIndex: 'quantity',
    key: 'quantity',
    align: 'right',
    onCell: numCell,
    render: (value: number, row) => <Typography.Text strong>{fmtQty(value, row.unit)}</Typography.Text>,
  };
  if (view === 'location') {
    return [
      ...skuColumns,
      { title: '库位', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
      { title: '库位名称', dataIndex: 'locationName', key: 'locationName' },
      quantityColumn,
    ];
  }
  if (view === 'batch') {
    return [
      ...skuColumns,
      { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
      {
        title: '效期',
        dataIndex: 'batchExpiryDate',
        key: 'batchExpiryDate',
        render: (value: string | null) => value ?? '—',
      },
      quantityColumn,
    ];
  }
  if (view === 'warehouse') {
    return [
      {
        title: '仓库',
        key: 'warehouse',
        onCell: monoCell,
        render: (_, row) => warehouseLabel(row),
      },
      ...skuColumns,
      quantityColumn,
    ];
  }
  return [...skuColumns, quantityColumn];
}

function warehouseLabel(row: InventorySliceRow): string {
  if (!row.warehouseCode) return row.warehouseName ?? '未分仓';
  if (row.warehouseName && row.warehouseName !== row.warehouseCode) {
    return `${row.warehouseCode} · ${row.warehouseName}`;
  }
  return row.warehouseCode;
}

/** 展开行：这一组合计是由哪些桶加出来的。 */
function SliceDetailTable({ details, unit }: { details: InventorySliceDetail[]; unit: string | null }) {
  return (
    <Table<InventorySliceDetail>
      size="small"
      rowKey={(detail) => `${detail.locationCode}@${detail.batchNo}`}
      pagination={false}
      dataSource={details}
      columns={[
        { title: '库位', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
        { title: '库位名称', dataIndex: 'locationName', key: 'locationName' },
        { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
        {
          title: '效期',
          dataIndex: 'batchExpiryDate',
          key: 'batchExpiryDate',
          render: (value: string | null) => value ?? '—',
        },
        {
          title: '余量',
          dataIndex: 'quantity',
          key: 'quantity',
          align: 'right',
          onCell: numCell,
          render: (value: number) => <Typography.Text strong>{fmtQty(value, unit)}</Typography.Text>,
        },
      ]}
    />
  );
}

/**
 * 冻结管理弹窗（M19）：上半 = 该 SKU 活动冻结清单（逐笔释放，Popconfirm 确认）；
 * 下半 = 追加冻结表单（数量 + 原因）。冻结不改物理库存——可用量 = 余量 − 冻结，
 * 单据出库（拣货/发货）按可用量拦截；调整/移库/盘点修正不受影响。
 */
function HoldModal({ row, onClose }: { row: InventoryRow | null; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data: holds } = useHolds(row?.skuCode);
  const create = useCreateHold();
  const release = useReleaseHold();

  const submit = async (values: { quantity: number; reason?: string }) => {
    if (!row) return;
    try {
      const r = await create.mutateAsync({
        skuCode: row.skuCode,
        quantity: values.quantity,
        reason: values.reason || undefined,
      });
      message.success(`已冻结 ${r.skuCode} × ${r.quantity}（可用 ${r.available}）`);
      form.resetFields();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `冻结失败：${String(e)}`);
    }
  };

  const doRelease = async (holdId: string) => {
    try {
      const r = await release.mutateAsync(holdId);
      message.success(`已释放 ${r.skuCode} × ${r.quantity}（可用 ${r.available}）`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `释放失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title={row ? `冻结管理：${row.skuCode} · ${row.name}` : '冻结管理'}
      open={row !== null}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="冻结"
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      {row ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          余量 {row.quantity}，冻结 {row.held}，可用 {row.available}。冻结不改物理库存，
          单据出库按可用量拦截；释放后数量回到可用。
        </Typography.Paragraph>
      ) : null}
      {(holds ?? []).length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          {(holds ?? []).map((h) => (
            <Space key={h.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>
                <Typography.Text strong>{h.quantity}</Typography.Text>
                <Typography.Text type="secondary">
                  {' '}
                  · {h.reason} · {h.createdAt.slice(0, 19).replace('T', ' ')}
                </Typography.Text>
              </span>
              <Popconfirm title={`释放这笔冻结（${h.quantity}）？`} onConfirm={() => doRelease(h.id)}>
                <Button size="small" danger loading={release.isPending}>
                  释放
                </Button>
              </Popconfirm>
            </Space>
          ))}
        </div>
      ) : (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          该 SKU 暂无活动冻结。
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="quantity"
          label="追加冻结数量"
          rules={[{ required: true, message: '请输入数量' }]}
        >
          <InputNumber style={{ width: '100%' }} min={0.001} precision={3} placeholder="如 10 或 0.5" />
        </Form.Item>
        <Form.Item name="reason" label="原因（可选，如 质检隔离 / 客订预留）">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function splitSerialText(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 手工调整表单：delta 正数入库、负数出库；库存不可为负由服务端护栏兜底。
 * preset = 从行内进入（SKU 锁定）；null = 从顶部进入（SKU 下拉自选——空库存可录期初）。
 * module.serial 开启时可以填写序列号；关掉时不出现，空着也不下发。
 */
function AdjustModal({
  open,
  preset,
  onClose,
}: {
  open: boolean;
  preset: InventoryRow | null;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const adjust = useAdjustInventory();
  const { data: skus } = useSkus();
  const snapshot = useProfileSnapshot();
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;

  const submit = async (values: { skuCode: string; delta: number; reason?: string; serials?: string }) => {
    const serials = splitSerialText(values.serials);
    try {
      const r = await adjust.mutateAsync({
        skuCode: values.skuCode,
        delta: values.delta,
        reason: values.reason || undefined,
        ...(serials.length > 0 ? { serials } : {}),
      });
      message.success(`${r.skuCode} 调整后余量：${r.quantity}`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `调整失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title={preset ? `调整库存：${preset.skuCode} · ${preset.name}` : '库存调整'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={adjust.isPending}
      destroyOnHidden
    >
      {preset ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          当前余量 {preset.quantity}。正数 = 入库，负数 = 出库。
        </Typography.Text>
      ) : null}
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        initialValues={preset ? { skuCode: preset.skuCode } : undefined}
      >
        <Form.Item name="skuCode" label="SKU" rules={[{ required: true, message: '请选择 SKU' }]}>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择 SKU"
            disabled={preset !== null}
            options={(skus ?? []).map((s) => ({ value: s.skuCode, label: `${s.skuCode} · ${s.name}` }))}
          />
        </Form.Item>
        <Form.Item
          name="delta"
          label="数量变化"
          rules={[
            { required: true, message: '请输入变化量' },
            {
              validator: (_, v) =>
                v === 0 ? Promise.reject(new Error('不能为 0')) : Promise.resolve(),
            },
          ]}
        >
          <InputNumber style={{ width: '100%' }} precision={3} placeholder="如 20 / -5 / 0.5" />
        </Form.Item>
        <Form.Item name="reason" label="原因（可选，如 盘点 / 报损 / 期初）">
          <Input />
        </Form.Item>
        {serialOn ? (
          <Form.Item name="serials" label="序列号（按件管理时必填，逗号、空格或换行分开）">
            <Input.TextArea rows={3} placeholder="如 SN-001, SN-002" />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}
