import { useState } from 'react';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCreateLocation, useLocations, useUpdateLocation } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Location } from '../api/client';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell } from '../components/table-style';

/**
 * 库位管理页——档案大类下的物理存储位主数据。
 * 只能建 + 改名，不能删也不能改编码：locationCode 是业务键，历史单据/
 * 库存流水按它引用，删了或改了会让旧账指向不存在的桶（护栏在服务端工具）。
 * 虚拟库位 DEFAULT（未指定库位时库存的归宿）不落库，故不在清单里——顶部
 * 常驻说明它存在且可直接在单据/调整中引用。
 */
export default function LocationsPage() {
  const { message } = AntApp.useApp();
  const { data: rows, isLoading } = useLocations();
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [form] = Form.useForm<{ locationCode: string; name?: string }>();

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (row: Location) => {
    setEditing(row);
    form.setFieldsValue({ locationCode: row.locationCode, name: row.name });
    setOpen(true);
  };

  const submit = async (values: { locationCode: string; name?: string }) => {
    const name = values.name?.trim();
    try {
      if (editing) {
        if (!name) {
          message.error('库位名称不能为空');
          return;
        }
        const r = await update.mutateAsync({
          locationCode: editing.locationCode,
          body: { name },
        });
        message.success(`库位 ${r.locationCode} 已更名为「${r.name}」`);
      } else {
        const code = values.locationCode.trim();
        if (!code) {
          message.error('请输入库位编码');
          return;
        }
        const r = await create.mutateAsync({ locationCode: code, name: name || undefined });
        message.success(`库位 ${r.locationCode} 已创建`);
      }
      setOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editing ? '保存' : '创建'}失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<Location> = [
    { title: '库位编码', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 180,
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, r) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
          改名
        </Button>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="库位管理"
        subtitle="仓库内的物理存储位：建库位、改名称（编码是业务键不可改，库位不删除以保留历史账）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建库位
          </Button>
        }
      />
      <Card>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="还有一个虚拟库位 DEFAULT"
            description="出入库不指定库位时，库存归到 DEFAULT。它不需要创建、不出现在下表，但可以在单据行、库存调整、移库里直接写 DEFAULT 引用。"
          />
          <Table<Location>
            rowKey="id"
            columns={columns}
            dataSource={rows ?? []}
            loading={isLoading}
            pagination={TABLE_PAGINATION}
            locale={{ emptyText: '还没有库位，点右上角新建（不建也能用——库存全归 DEFAULT）' }}
          />
          <Typography.Text type="secondary">
            想停用某个库位：先把它里面的库存移到别处（库存页「移库」），库位留着不再使用即可——
            删掉会让引用它的历史单据与流水失去落点。
          </Typography.Text>
        </Space>
        <Modal
          title={editing ? `库位改名 · ${editing.locationCode}` : '新建库位'}
          open={open}
          onCancel={() => setOpen(false)}
          onOk={() => form.submit()}
          okText={editing ? '保存' : '创建'}
          confirmLoading={editing ? update.isPending : create.isPending}
          destroyOnHidden
        >
          <Form form={form} layout="vertical" onFinish={submit}>
            <Form.Item
              name="locationCode"
              label="库位编码"
              rules={editing ? [] : [{ required: true, message: '请输入编码' }]}
              extra={editing ? '编码是业务键，历史单据按它引用，不可修改' : '如 A-01、二楼东架；DEFAULT 是保留字不可用'}
            >
              <Input placeholder="如 A-01（全库唯一）" disabled={editing != null} />
            </Form.Item>
            <Form.Item name="name" label="库位名称" rules={editing ? [{ required: true, message: '请输入名称' }] : []}>
              <Input placeholder={editing ? '如 A 区 01 货架' : '可选，缺省同编码，如 A 区 01 货架'} />
            </Form.Item>
          </Form>
        </Modal>
      </Card>
    </div>
  );
}
