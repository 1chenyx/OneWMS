import { useState } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAdjustInventory, useInventory, useSkus } from '../api/hooks';
import { ApiError } from '../api/client';
import type { InventoryRow } from '../api/client';
import { useAppNav } from '../app-nav';

/**
 * 库存页：清单（流水汇总投影 + SKU 联查）+ 手工调整。
 * 调整走 wms.inventory.adjust 工具（库存不可为负的护栏在 handler）。
 * 注意：v1 单据状态流转不产生库存流水（二者解耦），库存从调整/期初录入开始。
 * AI 跳转携带的 skuCode 预填过滤框（M12 步骤4，挂载时一次性消费）。
 */
export default function InventoryPage() {
  const { takeInitialFilter } = useAppNav();
  const { data: rows, isLoading } = useInventory();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [preset, setPreset] = useState<InventoryRow | null>(null);
  const [keyword, setKeyword] = useState(() => takeInitialFilter()?.skuCode ?? '');

  const kw = keyword.trim().toLowerCase();
  const visibleRows = kw
    ? (rows ?? []).filter(
        (r) => r.skuCode.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
      )
    : (rows ?? []);

  const openAdjust = (row: InventoryRow | null) => {
    setPreset(row);
    setAdjustOpen(true);
  };

  const columns: ColumnsType<InventoryRow> = [
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode' },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '当前余量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, r) => (
        <Button size="small" onClick={() => openAdjust(r)}>
          调整
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="库存"
      extra={
        <Space>
          <Input
            allowClear
            placeholder="按编码/名称过滤"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 180 }}
          />
          <Button type="primary" icon={<EditOutlined />} onClick={() => openAdjust(null)}>
            库存调整
          </Button>
        </Space>
      }
    >
      <Table<InventoryRow>
        rowKey="skuId"
        columns={columns}
        dataSource={visibleRows}
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: '还没有库存流水（录入期初或调整后出现）' }}
      />
      <AdjustModal open={adjustOpen} preset={preset} onClose={() => setAdjustOpen(false)} />
    </Card>
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
