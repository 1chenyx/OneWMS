import { useEffect, useState } from 'react';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Radio, Select, Space, Switch, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useCreateOrder, usePartners, useProfileSnapshot, useSkus } from '../api/hooks';
import { ApiError } from '../api/client';
import ScanInput from './ScanInput';

/** 把自由文本拆成序列号。空则省略，模块关闭时调用方不走这里。 */
function linesWithSerials(
  lines: { skuCode: string; quantity: number; serialsText?: string }[],
): { skuCode: string; quantity: number; serials?: string[] }[] {
  return lines.map((line) => {
    const serials = splitSerials(line.serialsText);
    return serials.length > 0
      ? { skuCode: line.skuCode, quantity: line.quantity, serials }
      : { skuCode: line.skuCode, quantity: line.quantity };
  });
}

function splitSerials(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 建单表单：方向 + 明细行（SKU 下拉来自投影，数量正整数）+ 备注。
 * 提交走 wms.order.create 工具（护栏在 handler：SKU 存在性 / 数量 / 单号唯一）。
 * 扫码录入（M18）：扫条码（或编码）= 已在单中的行数量 +1，未在单中追加一行
 * （数量 1）——逐件扫码累加是收货/拣货的常见节奏。
 * module.serial 开启时，行上可以填写序列号；关掉时不出现这个输入，提交体与原来一致。
 */
export default function OrderFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data: skus } = useSkus();
  const { data: partners } = usePartners();
  const create = useCreateOrder();
  const snapshot = useProfileSnapshot();
  const asnModule = snapshot.data?.modules['module.asn']?.enabled === true;
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [asn, setAsn] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setDirection('in');
      setAsn(false);
    }
  }, [open, form]);

  const handleScan = (code: string) => {
    // 条码优先，编码兜底（扫的可能是商品条码，手工输的可能是编码）
    const sku = (skus ?? []).find((s) => s.barcode === code) ?? (skus ?? []).find((s) => s.skuCode === code);
    if (!sku) {
      message.warning(`没有条码/编码为 ${code} 的 SKU`);
      return;
    }
    const lines = (form.getFieldValue('lines') as ({ skuCode?: string; quantity?: number } | undefined)[]) ?? [];
    const idx = lines.findIndex((l) => l?.skuCode === sku.skuCode);
    if (idx >= 0) {
      form.setFieldValue(['lines', idx, 'quantity'], (lines[idx]?.quantity ?? 0) + 1);
      message.success(`${sku.skuCode} 数量 +1`);
    } else {
      form.setFieldValue('lines', [...lines, { skuCode: sku.skuCode, quantity: 1 }]);
      message.success(`已加入 ${sku.skuCode} · ${sku.name}`);
    }
  };

  const submit = async (values: {
    direction: 'in' | 'out';
    lines: { skuCode: string; quantity: number; serialsText?: string }[];
    partnerCode?: string;
    note?: string;
    asn?: boolean;
    expectedAt?: string;
  }) => {
    const expectedAt = values.expectedAt?.trim() ?? '';
    if (values.asn && expectedAt && !/^\d{4}-\d{2}-\d{2}$/.test(expectedAt)) {
      message.error('预计到货日请用 YYYY-MM-DD');
      return;
    }
    try {
      const r = await create.mutateAsync({
        direction: values.direction,
        lines: serialOn ? linesWithSerials(values.lines) : values.lines,
        partnerCode: values.partnerCode || undefined,
        note: values.note || undefined,
        ...(values.asn ? { asn: true, ...(expectedAt ? { expectedAt } : {}) } : {}),
      });
      message.success(values.asn ? `预报单 ${r.orderNo} 已创建` : `单据 ${r.orderNo} 已创建`);
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
            onChange={(e) => {
              setDirection(e.target.value);
              // 方向切换 → 清空已选往来单位（供应商/客户不匹配新方向）
              form.setFieldValue('partnerCode', undefined);
              if (e.target.value !== 'in') {
                setAsn(false);
                form.setFieldValue('asn', false);
                form.setFieldValue('expectedAt', undefined);
              }
            }}
            optionType="button"
            buttonStyle="solid"
          />
        </Form.Item>
        <Form.Item
          name="partnerCode"
          label={`往来单位（可选，${direction === 'in' ? '供应商' : '客户'}）`}
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={direction === 'in' ? '选择供应商' : '选择客户'}
            options={(partners ?? [])
              .filter((p) => p.kind === (direction === 'in' ? 'supplier' : 'customer'))
              .map((p) => ({ value: p.partnerCode, label: `${p.partnerCode} · ${p.name}` }))}
            notFoundContent={
              <Typography.Text type="secondary">
                还没有{direction === 'in' ? '供应商' : '客户'}档案，可到「档案 → 往来单位」新建
              </Typography.Text>
            }
          />
        </Form.Item>
        {asnModule && direction === 'in' ? (
          <>
            <Form.Item name="asn" label="到货预报" valuePropName="checked" extra="货还没到。收到货再收货，那时才加库存。">
              <Switch
                onChange={(checked) => {
                  setAsn(checked);
                  if (!checked) form.setFieldValue('expectedAt', undefined);
                }}
              />
            </Form.Item>
            {asn ? (
              <Form.Item name="expectedAt" label="预计到货日（可选）">
                <Input placeholder="YYYY-MM-DD" />
              </Form.Item>
            ) : null}
          </>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          可扫码录入：扫一件货加一行/数量 +1（条码或编码均可）。
          <ScanInput onScan={handleScan} style={{ marginTop: 8, width: '100%' }} />
        </Typography.Paragraph>
        <Form.List name="lines" rules={[{ validator: (_, v) => (v?.length ? Promise.resolve() : Promise.reject(new Error('至少一行明细'))) }]}>
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field) => (
                <div key={field.key} style={{ marginBottom: 8 }}>
                  <Space align="baseline" style={{ display: 'flex' }}>
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
                      <InputNumber min={0.001} precision={3} placeholder="数量" />
                    </Form.Item>
                    {fields.length > 1 ? (
                      <MinusCircleOutlined onClick={() => remove(field.name)} />
                    ) : null}
                  </Space>
                  {serialOn ? (
                    <Form.Item name={[field.name, 'serialsText']} style={{ marginBottom: 0 }}>
                      <Input.TextArea rows={2} placeholder="序列号，每行一个，或用逗号、空格分开。按件管理时每件一个" />
                    </Form.Item>
                  ) : null}
                </div>
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
