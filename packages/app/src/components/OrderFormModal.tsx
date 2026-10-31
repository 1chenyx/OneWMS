import { useEffect, useState } from 'react';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Radio, Select, Space } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useCreateOrder, useSkus } from '../api/hooks';
import { ApiError } from '../api/client';

/**
 * 建单表单：方向 + 明细行（SKU 下拉来自投影，数量正整数）+ 备注。
 * 提交走 wms.order.create 工具（护栏在 handler：SKU 存在性 / 数量 / 单号唯一）。
 */
export default function OrderFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data: skus } = useSkus();
  const create = useCreateOrder();
  const [direction, setDirection] = useState<'in' | 'out'>('in');

  useEffect(() => {
    if (open) {
      form.resetFields();
      setDirection('in');
    }
  }, [open, form]);

  const submit = async (values: {
    direction: 'in' | 'out';
    lines: { skuCode: string; quantity: number }[];
    note?: string;
  }) => {
    try {
      const r = await create.mutateAsync({
        direction: values.direction,
        lines: values.lines,
        note: values.note || undefined,
      });
      message.success(`单据 ${r.orderNo} 已创建`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title="新建出入库单"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        initialValues={{ direction: 'in', lines: [{}] }}
      >
        <Form.Item name="direction" label="方向">
          <Radio.Group
            options={[
              { value: 'in', label: '入库' },
              { value: 'out', label: '出库' },
            ]}
            onChange={(e) => setDirection(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          />
        </Form.Item>
        <Form.List name="lines" rules={[{ validator: (_, v) => (v?.length ? Promise.resolve() : Promise.reject(new Error('至少一行明细'))) }]}>
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field) => (
                <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                  <Form.Item
                    name={[field.name, 'skuCode']}
                    rules={[{ required: true, message: '选 SKU' }]}
                    style={{ marginBottom: 8, minWidth: 260 }}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="选择 SKU"
                      options={(skus ?? []).map((s) => ({
                        value: s.skuCode,
                        label: `${s.skuCode} · ${s.name}`,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'quantity']}
                    rules={[{ required: true, message: '数量' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={1} precision={0} placeholder="数量" />
                  </Form.Item>
                  {fields.length > 1 ? (
                    <MinusCircleOutlined onClick={() => remove(field.name)} />
                  ) : null}
                </Space>
              ))}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => add({})}
                block
                style={{ marginBottom: 8 }}
              >
                添加明细行
              </Button>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
        <Form.Item name="note" label={`备注（可选，${direction === 'in' ? '如 采购到货' : '如 客户订单'}）`}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
