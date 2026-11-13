import { useEffect, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  useCancelTransfer,
  useCreateTransfer,
  useInventoryBuckets,
  useLocations,
  useReceiveTransfer,
  useShipTransfer,
  useSkus,
  useTransferDetail,
  useTransfers,
} from '../api/hooks';
import { ApiError } from '../api/client';
import type { Transfer, TransferDetailLine, InventoryBucketRow } from '../api/client';
import { filledCode, useSeededField } from '../components/use-seeded-code';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';
import { fmtQty } from '../lib/format';

/**
 * 调拨单页：跨库位 / 跨仓的两阶段转移（新建 → 发货（源库位扣减）→
 * 在途 → 收货（目标库位加增）→ 已完成）。新建阶段可取消（不动库存）。
 * 护栏（余量校验 / 源目标库位不同 / 状态机）在服务端 handler，UI 按 code 提示。
 */

const STATE_TAG: Record<string, { color: string; label: string }> = {
  created: { color: 'processing', label: '新建' },
  inTransit: { color: 'gold', label: '在途' },
  completed: { color: 'green', label: '已完成' },
  canceled: { color: 'default', label: '已取消' },
};

export default function TransfersPage() {
  const { message } = AntApp.useApp();
  const { data: rows, isLoading } = useTransfers();
  const ship = useShipTransfer();
  const receive = useReceiveTransfer();
  const cancel = useCancelTransfer();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailNo, setDetailNo] = useState<string | null>(null);

  const run = async (action: () => Promise<string>) => {
    try {
      message.success(await action());
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<Transfer> = [
    {
      title: '调拨单号',
      dataIndex: 'transferNo',
      key: 'transferNo',
      onCell: monoCell,
      render: (v: string) => (
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => setDetailNo(v)}>
          {v}
        </Button>
      ),
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (v: string) => (
        <Tag color={STATE_TAG[v]?.color ?? 'default'}>{STATE_TAG[v]?.label ?? v}</Tag>
      ),
    },
    {
      title: '源 → 目标',
      key: 'route',
      render: (_, r) => (
        <span>
          {r.fromWarehouse ?? '-'} → {r.toWarehouse ?? '-'}
        </span>
      ),
    },
    { title: '行数', dataIndex: 'lineCount', key: 'lineCount', align: 'right', onCell: numCell },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, r) => (
        <Space size="small" wrap>
          <Button size="small" onClick={() => setDetailNo(r.transferNo)}>
            明细
          </Button>
          {r.state === 'created' ? (
            <>
              <Popconfirm
                title="确认发货？"
                description="发货后从每行的源库位扣减数量，单据进入在途"
                onConfirm={() =>
                  run(async () => {
                    const res = await ship.mutateAsync(r.transferNo);
                    return `${res.transferNo} 已发货（${res.shippedLines} 行），进入在途`;
                  })
                }
              >
                <Button
                  size="small"
                  type="primary"
                  loading={ship.isPending && ship.variables === r.transferNo}
                >
                  发货
                </Button>
              </Popconfirm>
              <Popconfirm title="确认取消该调拨单？（不动库存）" onConfirm={() =>
                run(async () => {
                  const res = await cancel.mutateAsync(r.transferNo);
                  return `${res.transferNo} 已取消`;
                })
              }>
                <Button
                  size="small"
                  danger
                  loading={cancel.isPending && cancel.variables === r.transferNo}
                >
                  取消
                </Button>
              </Popconfirm>
            </>
          ) : null}
          {r.state === 'inTransit' ? (
            <Popconfirm
              title="确认收货？"
              description="收货后向每行的目标库位加增数量，单据完成"
              onConfirm={() =>
                run(async () => {
                  const res = await receive.mutateAsync(r.transferNo);
                  return `${res.transferNo} 已收货（${res.receivedLines} 行），调拨完成`;
                })
              }
            >
              <Button
                size="small"
                type="primary"
                loading={receive.isPending && receive.variables === r.transferNo}
              >
                收货
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="调拨单"
        subtitle="跨库位 / 跨仓两阶段转移：发货从源库位扣减，收货向目标库位加增"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建调拨
          </Button>
        }
      />
      <Card className="list-card">
        <Table<Transfer>
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          locale={{ emptyText: '还没有调拨单' }}
        />
        <CreateTransferModal open={createOpen} onClose={() => setCreateOpen(false)} />
        <TransferDetailDrawer no={detailNo} onClose={() => setDetailNo(null)} />
      </Card>
    </div>
  );
}

/** 新建调拨：多行明细（SKU + 源库位 + 目标库位 + 批次 + 数量）+ 可选仓库归类与备注 */
function CreateTransferModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const create = useCreateTransfer();
  const { data: skus } = useSkus();
  const { data: locations } = useLocations();
  const { data: buckets } = useInventoryBuckets(open);
  const [focusedIdx, setFocusedIdx] = useState(0);
  useEffect(() => {
    if (open) {
      form.resetFields();
      setFocusedIdx(0);
    }
  }, [open, form]);
  useSeededField(form, 'transferNo', open ? 'transfer' : null);

  const skuOptions = (skus ?? []).map((s) => ({ value: s.skuCode, label: `${s.skuCode} · ${s.name}` }));
  const locationOptions = [
    { value: 'DEFAULT', label: 'DEFAULT · 默认库位' },
    ...(locations ?? []).map((l) => ({
      value: l.locationCode,
      label: l.name && l.name !== l.locationCode ? `${l.locationCode} · ${l.name}` : l.locationCode,
    })),
  ];

  const watchedLines = Form.useWatch('lines', form) ?? [];
  const focusedSku = watchedLines[focusedIdx]?.skuCode;
  const skuBuckets = (buckets ?? []).filter((b) => b.skuCode === focusedSku);
  const useBucket = (bucket: InventoryBucketRow) => {
    const current = form.getFieldValue(['lines', focusedIdx]) ?? {};
    form.setFieldValue(['lines', focusedIdx], {
      ...current,
      fromLocationCode: bucket.locationCode === 'DEFAULT' ? undefined : bucket.locationCode,
      batchNo: bucket.batchNo && bucket.batchNo !== 'DEFAULT' ? bucket.batchNo : undefined,
    });
  };

  const submit = async (values: {
    transferNo?: string;
    note?: string;
    lines?: { skuCode: string; fromLocationCode?: string; toLocationCode?: string; batchNo?: string; quantity: number }[];
  }) => {
    const lines = (values.lines ?? []).filter((l) => l.skuCode && l.quantity > 0);
    if (lines.length === 0) {
      message.error('至少填一行明细（SKU 和数量必填）');
      return;
    }
    const transferNo = filledCode(values.transferNo);
    try {
      const r = await create.mutateAsync({
        ...(transferNo ? { transferNo } : {}),
        lines,
        note: values.note || undefined,
      });
      message.success(`调拨单 ${r.transferNo} 已创建：${r.lineCount} 行`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title="新建调拨"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={create.isPending}
      width={1060}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        每行 = SKU + 源库位 + 目标库位 + 批次 + 数量。源目标库位不能相同（同库位移动请用移库）；
        发货时校验源库位余量。批次留空按虚拟批次 DEFAULT。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Space size={16} wrap style={{ display: 'flex', marginBottom: 12 }}>
          <Form.Item name="transferNo" label="调拨单号" style={{ marginBottom: 0 }} extra="留空按编号规则生成">
            <Input style={{ width: 220 }} aria-label="调拨单号" />
          </Form.Item>
          <Form.Item name="note" label="备注（可选）" style={{ marginBottom: 0 }}>
            <Input style={{ width: 320 }} />
          </Form.Item>
        </Space>
        <Form.List name="lines" initialValue={[{}]}>
          {(fields, { add, remove }) => (
            <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            <>
              {fields.map((field) => (
                <Space
                  key={field.key}
                  align="baseline"
                  size={8}
                  style={{
                    display: 'flex',
                    padding: '2px 6px',
                    borderRadius: 4,
                    outline: focusedIdx === field.name ? '1px solid #1677ff' : 'none',
                    cursor: 'pointer',
                  }}
                  onClick={() => setFocusedIdx(field.name)}
                >
                  <Form.Item
                    name={[field.name, 'skuCode']}
                    rules={[{ required: true, message: '选 SKU' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="SKU"
                      options={skuOptions}
                      style={{ width: 230 }}
                    />
                  </Form.Item>
                  <Form.Item name={[field.name, 'fromLocationCode']} style={{ marginBottom: 8 }}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="源库位（默认 DEFAULT）"
                      options={locationOptions}
                      style={{ width: 185 }}
                      allowClear
                    />
                  </Form.Item>
                  <Form.Item name={[field.name, 'toLocationCode']} style={{ marginBottom: 8 }}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="目标库位（默认 DEFAULT）"
                      options={locationOptions}
                      style={{ width: 185 }}
                      allowClear
                    />
                  </Form.Item>
                  <Form.Item name={[field.name, 'batchNo']} style={{ marginBottom: 8 }}>
                    <Input placeholder="批次（默认 DEFAULT）" style={{ width: 140 }} />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'quantity']}
                    rules={[{ required: true, message: '填数量' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={0.001} precision={3} placeholder="数量" style={{ width: 100 }} />
                  </Form.Item>
                  {fields.length > 1 ? (
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)}
                      aria-label="删除该行"
                    />
                  ) : null}
                </Space>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()} block>
                加一行
              </Button>
            </>
            </div>
          )}
        </Form.List>
        <div style={{ marginTop: 16, maxHeight: 240, overflowY: 'auto', paddingRight: 4 }}>
          <Typography.Text strong>
            {focusedSku ? `${focusedSku} 的库存分桶（点"用这桶"回填该行源库位和批次）` : '选中一行的 SKU 后，这里列出可选的库存桶'}
          </Typography.Text>
          {skuBuckets.length > 0 ? (
            <Table<InventoryBucketRow>
              size="small"
              pagination={false}
              style={{ marginTop: 8 }}
              rowKey={(b) => `${b.locationCode}#${b.batchNo}`}
              dataSource={skuBuckets}
              columns={[
                {
                  title: '库位',
                  dataIndex: 'locationCode',
                  render: (v: string) => (v === 'DEFAULT' ? '默认库位' : v),
                },
                {
                  title: '批次',
                  dataIndex: 'batchNo',
                  render: (v: string) => (!v || v === 'DEFAULT' ? '默认批次' : v),
                },
                {
                  title: '效期',
                  dataIndex: 'batchExpiryDate',
                  render: (v: string | null) => v ?? '—',
                },
                { title: '实物', dataIndex: 'quantity', align: 'right' },
                {
                  title: '',
                  render: (_v, bucket) => (
                    <Button size="small" onClick={() => useBucket(bucket)}>
                      用这桶
                    </Button>
                  ),
                },
              ]}
            />
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4 }}>
              {focusedSku ? '该 SKU 没有库存分桶。' : '先在上面的行里选 SKU。'}
            </Typography.Paragraph>
          )}
        </div>
      </Form>
    </Modal>
  );
}

/** 调拨明细：逐行 SKU × 源库位 → 目标库位 × 批次的数量 */
function TransferDetailDrawer({ no, onClose }: { no: string | null; onClose: () => void }) {
  const detail = useTransferDetail(no);
  const d = detail.data;
  const columns: ColumnsType<TransferDetailLine> = [
    { title: 'SKU', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '源库位', dataIndex: 'fromLocationCode', key: 'fromLocationCode', onCell: monoCell },
    { title: '目标库位', dataIndex: 'toLocationCode', key: 'toLocationCode', onCell: monoCell },
    { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right',
      onCell: numCell,
      render: (v: number, l) => fmtQty(v, l.unit),
    },
  ];
  return (
    <Drawer title={no ? `调拨明细：${no}` : '调拨明细'} open={no !== null} onClose={onClose} width={720}>
      {d ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space size="large" wrap>
            <Tag color={STATE_TAG[d.state]?.color ?? 'default'}>
              {STATE_TAG[d.state]?.label ?? d.state}
            </Tag>
            <Typography.Text>
              {d.fromWarehouse ?? '-'} → {d.toWarehouse ?? '-'}
            </Typography.Text>
            <Typography.Text>{d.lineCount} 行</Typography.Text>
            {d.note ? <Typography.Text type="secondary">备注：{d.note}</Typography.Text> : null}
          </Space>
          <Table<TransferDetailLine>
            rowKey={(l) => `${l.skuCode}@${l.fromLocationCode}@${l.toLocationCode}@${l.batchNo}`}
            columns={columns}
            dataSource={d.lines}
            pagination={false}
            size="small"
            locale={{ emptyText: '没有明细行' }}
          />
        </Space>
      ) : (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      )}
    </Drawer>
  );
}
