import { useEffect } from 'react';
import { App as AntApp, Form, Input, InputNumber, Modal, Switch } from 'antd';
import type { FieldExtension } from '@one/core';
import { useCreateSku, useProfileSnapshot } from '../api/hooks';
import { ApiError } from '../api/client';

/**
 * 新建 SKU 表单（动态表单，Profile 消费闭环的输入侧）：
 * 固定字段（编码/名称）+ 可见扩展字段按 type 映射控件——
 * 隐藏字段连输入项都不出现（软删除的界面投影）。
 */
export default function SkuFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const snapshot = useProfileSnapshot();
  const create = useCreateSku();

  // 扩展字段元数据（visible = false 的不出现：列与输入项同源）
  const extensions = (snapshot.data?.schema.entities['sku']?.extensions ?? []).filter((e) => e.visible);

  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const submit = async (values: Record<string, unknown>) => {
    // 收集扩展字段值：空值跳过；json 类型提交前 parse
    const extData: Record<string, unknown> = {};
    for (const ext of extensions) {
      const v = values[ext.key];
      if (v === undefined || v === null || v === '') continue;
      if (ext.type === 'json') {
        try {
          extData[ext.key] = JSON.parse(v as string);
        } catch {
          message.error(`「${ext.label}」不是合法的 JSON`);
          return;
        }
      } else {
        extData[ext.key] = v;
      }
    }
    try {
      await create.mutateAsync({
        skuCode: values.skuCode as string,
        name: values.name as string,
        extData: Object.keys(extData).length ? extData : undefined,
      });
      message.success(`SKU ${values.skuCode} 已创建`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title="新建 SKU"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="skuCode" label="SKU 编码" rules={[{ required: true, message: '请输入编码' }]}>
          <Input placeholder="如 A-1001（全库唯一）" />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input />
        </Form.Item>
        {extensions.map((ext) => (
          <Form.Item key={ext.key} name={ext.key} label={ext.label} valuePropName={ext.type === 'boolean' ? 'checked' : 'value'}>
            {fieldControl(ext)}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}

/** type → 控件映射（v1：date 用纯文本输入，不引日期库） */
function fieldControl(ext: FieldExtension) {
  switch (ext.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'boolean':
      return <Switch />;
    case 'json':
      return <Input.TextArea rows={2} placeholder='JSON 内容，如 {"shelf": "A-01"}' />;
    default: // string / date
      return <Input placeholder={ext.type === 'date' ? '如 2026-12-31' : undefined} />;
  }
}
