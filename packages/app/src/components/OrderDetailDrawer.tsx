import { useEffect, useState } from 'react';
import { MinusCircleOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Drawer, Input, InputNumber, Select, Space, Table, Typography } from 'antd';
import { ApiError } from '../api/client';
import type { InventoryBucketRow, Location, Order, OrderLine } from '../api/client';
import { useInventoryBuckets, useLocations, usePartners, useProfileSnapshot, useReviseOrder, useSkus } from '../api/hooks';
import { orderEditPolicy } from '../lib/order-edit-policy';
import { fmtQty } from '../lib/format';
import { PrintPreviewModal } from './print-preview';
import { OrderPrintSheet, orderPrintTitle } from './print-sheets';
import { monoCell, numCell } from './table-style';

/**
 * 单据详情。列表不再展开子表。详情只看单据内容。
 * 右上角「打印预览」再打开预览，预览里点打印才打。打的是已保存的那一版。
 * 编辑范围跟 orderEditPolicy：没入账可改明细和往来单位，入账后只留备注，结案后锁定。
 * 出库改明细不重新分配批次，行上的库位和批次就是要出的那一桶。编辑时摊开这一桶的实物，
 * 可以改用别的桶，也可以把数量改成这一桶还剩的数量。超过实物就报错、不保存。
 */

interface LineDraft {
  skuCode: string;
  quantity: number;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string;
  serialsText: string;
}

interface Draft {
  partnerCode: string;
  note: string;
  expectedAt: string;
  lines: LineDraft[];
}

function splitSerials(text: string): string[] {
  return text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function toDraft(order: Order): Draft {
  return {
    partnerCode: order.partnerCode ?? '',
    note: order.note ?? '',
    expectedAt: order.expectedAt ?? '',
    lines: order.lines.map((line) => ({
      skuCode: line.skuCode,
      quantity: line.quantity,
      locationCode: line.locationCode || 'DEFAULT',
      batchNo: !line.batchNo || line.batchNo === 'DEFAULT' ? '' : line.batchNo,
      batchExpiryDate: line.batchExpiryDate ?? '',
      serialsText: (line.serials ?? []).join('\n'),
    })),
  };
}

export default function OrderDetailDrawer({
  order,
  onClose,
  stateLabel,
  onPrint,
}: {
  order: Order | null;
  onClose: () => void;
  stateLabel: (state: string, direction: Order['direction']) => string;
  onPrint: (order: Order) => void;
}) {
  const { message } = AntApp.useApp();
  const revise = useReviseOrder();
  const snapshot = useProfileSnapshot();
  const { data: skus } = useSkus();
  const { data: partners } = usePartners();
  const { data: locations } = useLocations();
  const bucketQuery = useInventoryBuckets(order?.direction === 'out');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft(null);
    setPreviewOpen(false);
  }, [order?.id, order?.updatedAt]);

  const policy = order ? orderEditPolicy(order) : null;
  const canEdit = policy != null && (policy.lines || policy.partner || policy.note || policy.expectedAt);
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;
  const inbound = order?.direction === 'in';
  const locationRows = Array.isArray(locations) ? locations : [];
  const bucketRows = (Array.isArray(bucketQuery.data) ? bucketQuery.data : []) as InventoryBucketRow[];
  const locationOptions = [
    { value: 'DEFAULT', label: '默认库位' },
    ...locationRows.map((loc) => ({ value: loc.locationCode, label: `${loc.locationCode} · ${loc.name}` })),
  ];

  const save = async () => {
    if (!order || !draft || !policy) return;
    if (policy.lines) {
      if (draft.lines.length === 0) {
        message.warning('至少留一行明细');
        return;
      }
      if (draft.lines.some((line) => !line.skuCode || !(line.quantity > 0))) {
        message.warning('每一行都要选 SKU，数量要大于 0');
        return;
      }
      if (!inbound) {
        const short = draft.lines
          .map((line, index) => ({ line, index, onHand: bucketOf(bucketRows, line)?.quantity ?? 0 }))
          .find((row) => row.line.quantity > row.onHand);
        if (short) {
          message.error(
            `第 ${short.index + 1} 行 ${short.line.skuCode} 这一桶只有 ${fmtQty(short.onHand)}，不够出 ${fmtQty(short.line.quantity)}`,
          );
          return;
        }
      }
    }
    const body: Parameters<typeof revise.mutateAsync>[0]['body'] = {};
    if (policy.note) body.note = draft.note.trim() || null;
    if (policy.partner) body.partnerCode = draft.partnerCode.trim() || null;
    if (policy.expectedAt) body.expectedAt = draft.expectedAt.trim() || null;
    if (policy.lines) {
      body.lines = draft.lines.map((line, index) => {
        const serials = splitSerials(line.serialsText);
        const hadSerials = (order.lines[index]?.serials?.length ?? 0) > 0;
        return {
          skuCode: line.skuCode,
          quantity: line.quantity,
          ...(line.locationCode && line.locationCode !== 'DEFAULT' ? { locationCode: line.locationCode } : {}),
          ...(line.batchNo.trim() ? { batchNo: line.batchNo.trim() } : {}),
          ...(inbound && line.batchExpiryDate.trim() ? { batchExpiryDate: line.batchExpiryDate.trim() } : {}),
          ...(serialOn && (serials.length > 0 || hadSerials) ? { serials } : {}),
        };
      });
    }
    try {
      await revise.mutateAsync({ orderNo: order.orderNo, body });
      message.success(`${order.orderNo} 已保存`);
      setEditing(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `保存失败：${String(e)}`);
    }
  };

  return (
    <Drawer
      title={order ? `详情 · ${orderPrintTitle(order)}` : '详情'}
      open={order != null}
      width={920}
      destroyOnHidden
      onClose={onClose}
      extra={
        order ? (
          <Space>
            <Button icon={<PrinterOutlined aria-hidden />} onClick={() => setPreviewOpen(true)}>
              打印预览
            </Button>
            {editing ? (
              <>
                <Button onClick={() => setEditing(false)}>取消</Button>
                <Button type="primary" loading={revise.isPending} onClick={() => void save()}>
                  保存
                </Button>
              </>
            ) : canEdit ? (
              <Button
                type="primary"
                onClick={() => {
                  setDraft(toDraft(order));
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            ) : null}
          </Space>
        ) : null
      }
    >
      {order && policy ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {policy.reason ? <Alert type="info" showIcon message={policy.reason} /> : null}
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>状态：{stateLabel(order.state, order.direction)}</div>
            <div>创建时间：{order.createdAt.slice(0, 19).replace('T', ' ')}</div>
            {order.returnOfOrderNo ? <div>原单号：{order.returnOfOrderNo}（不能改）</div> : null}
            {editing && draft && policy.partner ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text>往来单位</Typography.Text>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder={inbound ? '选择供应商' : '选择客户'}
                  value={draft.partnerCode || undefined}
                  onChange={(value) => setDraft({ ...draft, partnerCode: value ?? '' })}
                  options={(partners ?? [])
                    .filter((partner) => partner.kind === (inbound ? 'supplier' : 'customer'))
                    .map((partner) => ({
                      value: partner.partnerCode,
                      label: `${partner.partnerCode} · ${partner.name}`,
                    }))}
                />
              </div>
            ) : (
              <div>往来单位：{order.partnerName ? `${order.partnerName}${order.partnerCode ? `（${order.partnerCode}）` : ''}` : '-'}</div>
            )}
            {editing && draft && policy.expectedAt ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text>预计到货日</Typography.Text>
                <Input
                  style={{ marginTop: 4 }}
                  placeholder="YYYY-MM-DD"
                  value={draft.expectedAt}
                  onChange={(e) => setDraft({ ...draft, expectedAt: e.target.value })}
                />
              </div>
            ) : order.expectedAt ? (
              <div>预计到货：{order.expectedAt}</div>
            ) : null}
            {editing && draft && policy.note ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text>备注</Typography.Text>
                <Input.TextArea
                  style={{ marginTop: 4 }}
                  rows={2}
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </div>
            ) : (
              <div>备注：{order.note ?? '-'}</div>
            )}
          </div>

          {editing && draft && policy.lines ? (
            <div>
              {inbound ? null : (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  改明细不会重新分配批次。每一行出的就是当前这一桶，数量不能超过这一桶的实物。点「用这桶」换库位和批次，点「按这一桶改数量」把数量改成还剩的实物。
                </Typography.Paragraph>
              )}
              {draft.lines.map((line, index) => {
                const sku = (skus ?? []).find((item) => item.skuCode === line.skuCode);
                const pinBatch = inbound || Boolean(order.returnOfOrderNo) || (serialOn && sku?.serialTracked === true);
                const onHand = bucketOf(bucketRows, line)?.quantity ?? 0;
                return (
                <div key={index} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="SKU"
                    style={{ width: 220 }}
                    value={line.skuCode || undefined}
                    onChange={(value) =>
                      updateLine(setDraft, index, {
                        skuCode: value,
                        ...(!inbound && !order.returnOfOrderNo ? { batchNo: '' } : {}),
                      })
                    }
                    options={(skus ?? []).map((item) => ({
                      value: item.skuCode,
                      label: `${item.skuCode} · ${item.name}`,
                    }))}
                  />
                  <InputNumber
                    min={0.001}
                    precision={3}
                    value={line.quantity}
                    onChange={(value) => updateLine(setDraft, index, { quantity: typeof value === 'number' ? value : 0 })}
                  />
                  {inbound ? (
                    <Select
                      showSearch
                      optionFilterProp="label"
                      style={{ width: 160 }}
                      value={line.locationCode}
                      onChange={(value) => updateLine(setDraft, index, { locationCode: value })}
                      options={locationOptions}
                    />
                  ) : (
                    <Typography.Text>
                      {`${locationLabel(line.locationCode, locationRows)} · ${line.batchNo.trim() || '默认批次'} · 这一桶还有 ${fmtQty(onHand, sku?.unit)}`}
                    </Typography.Text>
                  )}
                  {inbound ? null : (
                    <Button size="small" disabled={!(onHand > 0)} onClick={() => updateLine(setDraft, index, { quantity: onHand })}>
                      按这一桶改数量
                    </Button>
                  )}
                  {!inbound && line.quantity > onHand ? (
                    <Typography.Text type="warning">不够这一行</Typography.Text>
                  ) : null}
                  {pinBatch ? (
                    <Input
                      placeholder={inbound ? '批次，空 = 默认' : '批次'}
                      style={{ width: 140 }}
                      value={line.batchNo}
                      onChange={(e) => updateLine(setDraft, index, { batchNo: e.target.value })}
                    />
                  ) : inbound ? (
                    <Typography.Text type="secondary" style={{ width: 140 }}>
                      {line.batchNo || '默认批次'}
                    </Typography.Text>
                  ) : null}
                  {inbound ? (
                    <Input
                      placeholder="效期 YYYY-MM-DD"
                      style={{ width: 150 }}
                      value={line.batchExpiryDate}
                      onChange={(e) => updateLine(setDraft, index, { batchExpiryDate: e.target.value })}
                    />
                  ) : null}
                  {draft.lines.length > 1 ? (
                    <Button
                      type="text"
                      icon={<MinusCircleOutlined />}
                      aria-label="删除明细行"
                      onClick={() =>
                        setDraft({ ...draft, lines: draft.lines.filter((_, lineIndex) => lineIndex !== index) })
                      }
                    />
                  ) : null}
                  {serialOn ? (
                    <Input.TextArea
                      rows={2}
                      style={{ width: '100%' }}
                      placeholder="序列号，每行一个，或用逗号、空格分开"
                      value={line.serialsText}
                      onChange={(e) => updateLine(setDraft, index, { serialsText: e.target.value })}
                    />
                  ) : null}
                  </div>
                  {inbound || !line.skuCode ? null : (
                    <BucketPicker
                      line={line}
                      unit={sku?.unit}
                      buckets={bucketRows.filter((row) => row.skuCode === line.skuCode)}
                      onUse={(bucket) =>
                        updateLine(setDraft, index, {
                          locationCode: bucket.locationCode,
                          batchNo: bucket.batchNo && bucket.batchNo !== 'DEFAULT' ? bucket.batchNo : '',
                        })
                      }
                    />
                  )}
                </div>
                );
              })}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() =>
                  setDraft({
                    ...draft,
                    lines: [
                      ...draft.lines,
                      { skuCode: '', quantity: 1, locationCode: 'DEFAULT', batchNo: '', batchExpiryDate: '', serialsText: '' },
                    ],
                  })
                }
              >
                添加明细行
              </Button>
            </div>
          ) : (
            <LineTable order={order} buckets={order.direction === 'out' ? bucketRows : undefined} />
          )}
        </div>
      ) : null}
      {order ? (
        <PrintPreviewModal
          open={previewOpen}
          title={orderPrintTitle(order)}
          index={0}
          total={1}
          onIndexChange={() => {}}
          onClose={() => setPreviewOpen(false)}
          onPrint={() => onPrint(order)}
        >
          <OrderPrintSheet order={order} />
        </PrintPreviewModal>
      ) : null}
    </Drawer>
  );
}

function bucketOf(
  buckets: InventoryBucketRow[],
  line: { skuCode: string; locationCode?: string; batchNo?: string },
): InventoryBucketRow | undefined {
  if (!line.skuCode) return undefined;
  const locationCode = line.locationCode || 'DEFAULT';
  const batchNo = !line.batchNo || line.batchNo === 'DEFAULT' ? 'DEFAULT' : line.batchNo.trim();
  return buckets.find(
    (row) => row.skuCode === line.skuCode && row.locationCode === locationCode && (row.batchNo || 'DEFAULT') === batchNo,
  );
}

function locationLabel(code: string, rows: Location[]): string {
  if (!code || code === 'DEFAULT') return '默认库位';
  const found = rows.find((row) => row.locationCode === code);
  return found ? `${found.locationCode} · ${found.name}` : code;
}

function BucketPicker({
  line,
  unit,
  buckets,
  onUse,
}: {
  line: LineDraft;
  unit?: string | null;
  buckets: InventoryBucketRow[];
  onUse: (bucket: InventoryBucketRow) => void;
}) {
  const sorted = [...buckets].sort(
    (a, b) => a.locationCode.localeCompare(b.locationCode) || a.batchNo.localeCompare(b.batchNo),
  );
  const currentLocation = line.locationCode || 'DEFAULT';
  const currentBatch = line.batchNo.trim() || 'DEFAULT';
  return (
    <div style={{ marginTop: 8 }}>
      {sorted.length === 0 ? (
        <Typography.Text type="secondary">没有还剩货的库位和批次。</Typography.Text>
      ) : (
        <Table<InventoryBucketRow>
          size="small"
          pagination={false}
          rowKey={(row) => `${row.locationCode}#${row.batchNo}`}
          dataSource={sorted}
          columns={[
            {
              title: '库位',
              dataIndex: 'locationCode',
              render: (value: string) => (value === 'DEFAULT' ? '默认库位' : value),
            },
            {
              title: '批次',
              dataIndex: 'batchNo',
              render: (value: string) => (!value || value === 'DEFAULT' ? '默认批次' : value),
            },
            {
              title: '效期',
              dataIndex: 'batchExpiryDate',
              render: (value: string | null) => value ?? '—',
            },
            {
              title: '实物',
              dataIndex: 'quantity',
              align: 'right',
              render: (value: number) => fmtQty(value, unit),
            },
            {
              title: '',
              render: (_value, bucket) => {
                const current =
                  bucket.locationCode === currentLocation && (bucket.batchNo || 'DEFAULT') === currentBatch;
                return (
                  <span>
                    {current ? <Typography.Text style={{ marginRight: 8 }}>当前</Typography.Text> : null}
                    {line.quantity > bucket.quantity ? (
                      <Typography.Text type="warning" style={{ marginRight: 8 }}>
                        不够这一行
                      </Typography.Text>
                    ) : null}
                    <Button size="small" onClick={() => onUse(bucket)}>
                      用这桶
                    </Button>
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function updateLine(setDraft: (value: Draft | null | ((prev: Draft | null) => Draft | null)) => void, index: number, patch: Partial<LineDraft>) {
  setDraft((prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      lines: prev.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    };
  });
}

function LineTable({ order, buckets }: { order: Order; buckets?: InventoryBucketRow[] }) {
  const inbound = order.direction === 'in';
  return (
    <Table<OrderLine>
      size="small"
      rowKey={(line, index) => `${line.skuCode}#${index}`}
      dataSource={order.lines}
      pagination={false}
      columns={[
        { title: 'SKU', dataIndex: 'skuCode', width: 140, onCell: monoCell },
        { title: '名称', dataIndex: 'name' },
        {
          title: '数量',
          dataIndex: 'quantity',
          align: 'right',
          width: 100,
          onCell: numCell,
          render: (value: number, line) => fmtQty(value, line.unit),
        },
        ...(buckets
          ? [
              {
                title: '这一桶',
                align: 'right' as const,
                width: 120,
                onCell: numCell,
                render: (_value: unknown, line: OrderLine) => fmtQty(bucketOf(buckets, line)?.quantity ?? 0, line.unit),
              },
            ]
          : []),
        {
          title: '已入账',
          dataIndex: 'fulfilledQty',
          align: 'right',
          width: 100,
          onCell: numCell,
          render: (value: number | null | undefined, line) =>
            value == null ? <Typography.Text type="secondary">—</Typography.Text> : fmtQty(Math.abs(value), line.unit),
        },
        { title: '批次', dataIndex: 'batchNo', width: 110, onCell: monoCell, render: (value: string | undefined) => value ?? '-' },
        ...(inbound
          ? [
              {
                title: '效期',
                dataIndex: 'batchExpiryDate',
                width: 120,
                render: (value: string | null | undefined) => value ?? '-',
              },
            ]
          : []),
        {
          title: inbound ? '目标库位' : '库位',
          dataIndex: 'locationCode',
          width: 110,
          onCell: monoCell,
          render: (value: string | undefined) => value ?? '-',
        },
      ]}
    />
  );
}
