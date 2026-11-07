import { useEffect, useMemo } from 'react';
import { App as AntApp, Form, Input, InputNumber, Modal, Switch } from 'antd';
import type { FieldExtension } from '@one/core';
import { useCreateSku, useProfileSnapshot, useUpdateSku } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Sku } from '../api/client';

/**
 * SKU 表单（动态表单，Profile 消费闭环的输入侧）——新建 / 编辑同一份：
 * 固定字段（编码/名称/条码/安全库存）+ 可见扩展字段按 type 映射控件，
 * 隐藏字段连输入项都不出现（软删除的界面投影）。
 *
 * 编辑态（传入 sku）：skuCode 是业务键禁用（历史单据/流水按它引用）；
 * 扩展字段整体替换（wms.sku.update 语义），所以未填的扩展字段会被清掉——
 * 打开时按 sku.extData 回填，用户看到的是「改后结果」而不是「差异」。
 */
export default function SkuFormModal({
  open,
  onClose,
  sku,
}: {
  open: boolean;
  onClose: () => void;
  /** 传入 = 编辑该 SKU；不传 = 新建 */
  sku?: Sku | null;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const snapshot = useProfileSnapshot();
  const create = useCreateSku();
  const update = useUpdateSku();
  const editing = sku != null;

  // 扩展字段元数据（visible = false 的不出现：列与输入项同源）
  // useMemo 保持引用稳定——下面的回填 effect 依赖它，逐渲染新数组会反复重置表单
  const extensions = useMemo(
    () => (snapshot.data?.schema.entities['sku']?.extensions ?? []).filter((e) => e.visible),
    [snapshot.data],
  );

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (!sku) return;
    // 回填：扩展字段按声明类型转成控件值（json 序列化回文本框）
    const values: Record<string, unknown> = {
      skuCode: sku.skuCode,
      name: sku.name,
      barcode: sku.barcode ?? undefined,
      reorderPoint: sku.reorderPoint > 0 ? sku.reorderPoint : undefined,
      unit: sku.unit ?? undefined,
    };
    for (const ext of extensions) {
      const v = sku.extData[ext.key];
      if (v === undefined || v === null) continue;
      values[ext.key] = ext.type === 'json' ? JSON.stringify(v) : v;
    }
    form.setFieldsValue(values);
  }, [open, sku, form, extensions]);

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
    const barcode = (values.barcode as string | undefined)?.trim();
    const unit = (values.unit as string | undefined)?.trim();
    const reorderPoint =
      typeof values.reorderPoint === 'number' && values.reorderPoint >= 0 ? values.reorderPoint : 0;
    try {
      if (editing) {
        await update.mutateAsync({
          skuCode: sku.skuCode,
          body: {
            name: values.name as string,
            // 空条码不下发（wms.sku.update 不接受清空语义，传空串会被拒）
            ...(barcode ? { barcode } : {}),
            reorderPoint,
            // 单位与条码不同：编辑态显式传（空串 = 清空），未改也幂等
            unit: unit ?? '',
            extData,
          },
        });
        message.success(`SKU ${sku.skuCode} 已更新`);
      } else {
        await create.mutateAsync({
          skuCode: values.skuCode as string,
          name: values.name as string,
          barcode: barcode || undefined,
          reorderPoint: reorderPoint > 0 ? reorderPoint : undefined,
          unit: unit || undefined,
          extData: Object.keys(extData).length ? extData : undefined,
        });
        message.success(`SKU ${values.skuCode} 已创建`);
      }
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editing ? '保存' : '创建'}失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title={editing ? `编辑 SKU · ${sku.skuCode}` : '新建 SKU'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={editing ? '保存' : '创建'}
      confirmLoading={editing ? update.isPending : create.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="skuCode" label="SKU 编码" rules={[{ required: true, message: '请输入编码' }]}>
          <Input placeholder="如 A-1001（全库唯一）" disabled={editing} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="unit" label="单位（可选，数量显示与打印会跟随，如 kg / 箱 / 件）">
          <Input placeholder="如 kg（散装称重建议填写）" style={{ width: '50%' }} />
        </Form.Item>
        <Form.Item
          name="barcode"
          label={
            editing
              ? '条码（扫码枪识读用；同库唯一，清空不生效）'
              : '条码（可选，扫码枪识读用；同库唯一）'
          }
        >
          <Input placeholder="如 6901234567892（可用扫码枪扫入）" />
        </Form.Item>
        <Form.Item
          name="reorderPoint"
          label={
            editing
              ? '安全库存（可用量低于此值预警；留空/0 = 关闭预警）'
              : '安全库存（可选，可用量低于此值预警；留空 = 不预警）'
          }
        >
          <InputNumber style={{ width: '100%' }} min={0} precision={0} placeholder="如 50" />
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
