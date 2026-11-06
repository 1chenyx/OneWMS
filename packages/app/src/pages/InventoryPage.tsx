import { useState } from 'react';
import { EditOutlined, LockOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAdjustInventory, useCreateHold, useHolds, useInventory, useReleaseHold, useSkus } from '../api/hooks';
import { ApiError } from '../api/client';
import type { InventoryRow } from '../api/client';
import { useAppNav } from '../app-nav';
import ScanInput from '../components/ScanInput';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';

/**
 * 库存页：清单（流水汇总投影 + SKU 联查）+ 手工调整 + 冻结管理（M19）
 * + 低库存预警（M20：安全库存列、可用量低于阈值标红、「只看低库存」过滤）。
 * 调整走 wms.inventory.adjust 工具（库存不可为负的护栏在 handler）；
 * 冻结走 wms.inventory.hold / release（不改物理库存，单据出库按可用量拦截）。
 * AI 跳转携带的 skuCode 预填过滤框（M12 步骤4，挂载时一次性消费）。
 * 扫码（M18）：扫条码（或编码）= 选中该 SKU 并打开调整弹窗（无库存行也照开，
 * 余量显示 0——期初录入入口）。
 */
export default function InventoryPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const { data: rows, isLoading } = useInventory();
  const { data: skus } = useSkus();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [preset, setPreset] = useState<InventoryRow | null>(null);
  const [holdRow, setHoldRow] = useState<InventoryRow | null>(null);
  const [keyword, setKeyword] = useState(() => takeInitialFilter()?.skuCode ?? '');
  const [lowOnly, setLowOnly] = useState(false);

  /** 低库存判定（M20）：安全库存 > 0 且可用量 < 阈值（与 wms.inventory.lowstock 工具同一口径） */
  const isLow = (r: InventoryRow) => r.reorderPoint > 0 && r.available < r.reorderPoint;

  const kw = keyword.trim().toLowerCase();
  const visibleRows = (kw
    ? (rows ?? []).filter(
        (r) => r.skuCode.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
      )
    : (rows ?? [])
  ).filter((r) => (lowOnly ? isLow(r) : true));

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
    const row =
      (rows ?? []).find((r) => r.skuCode === sku.skuCode) ??
      ({ skuId: sku.id, skuCode: sku.skuCode, name: sku.name, quantity: 0 } as InventoryRow);
    openAdjust(row);
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
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '冻结量',
      dataIndex: 'held',
      key: 'held',
      align: 'right',
      onCell: numCell,
      sorter: (a, b) => a.held - b.held,
      render: (v: number) =>
        v > 0 ? <Typography.Text type="warning">{v}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>,
    },
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
            {v}
          </Typography.Text>
        ) : (
          v
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="库存"
        subtitle="流水汇总：余量 / 冻结 / 可用量（低于安全库存标红）"
        extra={
          <>
            <ScanInput onScan={handleScan} />
            <Input
              allowClear
              placeholder="按编码/名称过滤"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 180 }}
            />
            <Checkbox checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)}>
              只看低库存
            </Checkbox>
            <Button type="primary" icon={<EditOutlined />} onClick={() => openAdjust(null)}>
              库存调整
            </Button>
          </>
        }
      />
      <Card>
        <Table<InventoryRow>
          rowKey="skuId"
          columns={columns}
          dataSource={visibleRows}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          locale={{ emptyText: '还没有库存流水（录入期初或调整后出现）' }}
        />
        <AdjustModal open={adjustOpen} preset={preset} onClose={() => setAdjustOpen(false)} />
        <HoldModal row={holdRow} onClose={() => setHoldRow(null)} />
      </Card>
    </div>
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
          <InputNumber style={{ width: '100%' }} min={1} precision={0} placeholder="如 10" />
        </Form.Item>
        <Form.Item name="reason" label="原因（可选，如 质检隔离 / 客订预留）">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 手工调整表单：delta 正数入库、负数出库；库存不可为负由服务端护栏兜底。
 * preset = 从行内进入（SKU 锁定）；null = 从顶部进入（SKU 下拉自选——空库存可录期初）。
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

  const submit = async (values: { skuCode: string; delta: number; reason?: string }) => {
    try {
      const r = await adjust.mutateAsync({
        skuCode: values.skuCode,
        delta: values.delta,
        reason: values.reason || undefined,
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
          <InputNumber style={{ width: '100%' }} precision={0} placeholder="如 20 或 -5" />
        </Form.Item>
        <Form.Item name="reason" label="原因（可选，如 盘点 / 报损 / 期初）">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
