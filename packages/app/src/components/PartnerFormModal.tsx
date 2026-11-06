import { useEffect } from 'react';
import { App as AntApp, Form, Input, Modal } from 'antd';
import { useCreatePartner, useUpdatePartner } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Partner } from '../api/client';

/**
 * 往来单位表单（M21）：新建 / 编辑复用。
 * kind（供应商/客户）只在新建时由页面传入且不可改——身份变化 = 新建编码；
 * 编辑态只改名称/联系人/电话/地址/备注（工具层字段级 LWW，未传保持）。
 */
export default function PartnerFormModal({
  open,
  onClose,
  kind,
  partner,
}: {
  open: boolean;
  onClose: () => void;
  /** 新建时的种类（编辑态以 partner 为准，此参数被忽略） */
  kind: 'supplier' | 'customer';
  /** 编辑目标；null = 新建 */
  partner: Partner | null;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const create = useCreatePartner();
  const update = useUpdatePartner();
  const editing = partner !== null;

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (partner) {
        form.setFieldsValue({
          name: partner.name,
          contact: partner.contact ?? undefined,
          phone: partner.phone ?? undefined,
          address: partner.address ?? undefined,
          note: partner.note ?? undefined,
        });
      }
    }
  }, [open, form, partner]);

  const submit = async (values: Record<string, unknown>) => {
    const body = {
      name: values.name as string,
      contact: (values.contact as string | undefined)?.trim() || undefined,
      phone: (values.phone as string | undefined)?.trim() || undefined,
      address: (values.address as string | undefined)?.trim() || undefined,
      note: (values.note as string | undefined)?.trim() || undefined,
    };
    try {
      if (editing) {
        await update.mutateAsync({ partnerCode: partner.partnerCode, body });
        message.success(`往来单位 ${partner.partnerCode} 已更新`);
      } else {
        await create.mutateAsync({
          partnerCode: (values.partnerCode as string).trim(),
          kind,
          ...body,
        });
        message.success(`往来单位 ${values.partnerCode} 已创建`);
      }
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `保存失败：${String(e)}`);
    }
  };

  const pending = editing ? update.isPending : create.isPending;

  return (
    <Modal
      title={editing ? `编辑往来单位 · ${partner.partnerCode}` : `新建${kind === 'supplier' ? '供应商' : '客户'}`}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={pending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        {!editing ? (
          <Form.Item
            name="partnerCode"
            label="编码"
            rules={[{ required: true, message: '请输入编码' }]}
          >
            <Input placeholder={kind === 'supplier' ? '如 SUP-001（全库唯一）' : '如 CUS-001（全库唯一）'} />
          </Form.Item>
        ) : null}
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="contact" label="联系人（可选）">
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="联系电话（可选）">
          <Input />
        </Form.Item>
        <Form.Item name="address" label="地址（可选）">
          <Input />
        </Form.Item>
        <Form.Item name="note" label="备注（可选）">
          <Input />
        </Form.Item>
        {editing ? (
          <Form.Item style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
              种类（{partner.kind === 'supplier' ? '供应商' : '客户'}）不可修改——身份变化请新建编码。
            </span>
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}
