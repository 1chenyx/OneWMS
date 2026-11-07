import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCreateLocation, useLocations, useProfileSnapshot, useUpdateLocation } from '../api/hooks';
import { api, ApiError } from '../api/client';
import type { Location, Warehouse } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import PageHeader from '../components/PageHeader';
import { LocationSheetPort } from '../components/sheet-specs';
import { serverPagination, monoCell } from '../components/table-style';

/**
 * 库位管理页——档案大类下的物理存储位主数据。
 * 只能建 + 改名，不能删也不能改编码：locationCode 是业务键，历史单据/
 * 库存流水按它引用，删了或改了会让旧账指向不存在的桶（护栏在服务端工具）。
 * 虚拟库位 DEFAULT（未指定库位时库存的归宿）不落库，故不在清单里——顶部
 * 常驻说明它存在且可直接在单据/调整中引用。
 * module.warehouse 开启时，仓库是库位的上一层：可以新建仓库，并把库位划进去。
 */
export default function LocationsPage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const snapshot = useProfileSnapshot();
  const warehouseOn = snapshot.data?.modules['module.warehouse']?.enabled === true;
  const list = useListPage('locations');
  const { data, isLoading } = useLocations({ limit: list.limit, offset: list.offset });
  const payload = data as Location[] | ListPage<Location> | undefined;
  const rows = rowsOf(payload);
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: api.warehouses,
    enabled: warehouseOn,
  });
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [form] = Form.useForm<{ locationCode: string; name?: string; warehouseCode?: string }>();
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [warehouseSaving, setWarehouseSaving] = useState(false);
  const [warehouseForm] = Form.useForm<{ warehouseCode: string; name?: string }>();

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (row: Location) => {
    setEditing(row);
    form.setFieldsValue({
      locationCode: row.locationCode,
      name: row.name,
      warehouseCode: row.warehouseCode ?? undefined,
    });
    setOpen(true);
  };

  const submit = async (values: { locationCode: string; name?: string; warehouseCode?: string }) => {
    const name = values.name?.trim();
    const warehouseCode = values.warehouseCode?.trim() ?? '';
    try {
      if (editing) {
        if (!name) {
          message.error('库位名称不能为空');
          return;
        }
        const r = await update.mutateAsync({
          locationCode: editing.locationCode,
          body: warehouseOn ? { name, warehouseCode } : { name },
        });
        message.success(
          warehouseOn ? `库位 ${r.locationCode} 已保存` : `库位 ${r.locationCode} 已更名为「${r.name}」`,
        );
      } else {
        const code = values.locationCode.trim();
        if (!code) {
          message.error('请输入库位编码');
          return;
        }
        const r = await create.mutateAsync({
          locationCode: code,
          name: name || undefined,
          ...(warehouseOn && warehouseCode ? { warehouseCode } : {}),
        });
        message.success(`库位 ${r.locationCode} 已创建`);
      }
      setOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editing ? '保存' : '创建'}失败：${String(e)}`);
    }
  };

  const openCreateWarehouse = () => {
    setEditingWarehouse(null);
    warehouseForm.resetFields();
    setWarehouseOpen(true);
  };

  const openEditWarehouse = (row: Warehouse) => {
    setEditingWarehouse(row);
    warehouseForm.setFieldsValue({ warehouseCode: row.warehouseCode, name: row.name });
    setWarehouseOpen(true);
  };

  const submitWarehouse = async (values: { warehouseCode: string; name?: string }) => {
    const name = values.name?.trim();
    setWarehouseSaving(true);
    try {
      if (editingWarehouse) {
        if (!name) {
          message.error('仓库名称不能为空');
          return;
        }
        await api.updateWarehouse(editingWarehouse.warehouseCode, { name });
        message.success(`仓库 ${editingWarehouse.warehouseCode} 已更名为「${name}」`);
      } else {
        const code = values.warehouseCode.trim();
        if (!code) {
          message.error('请输入仓库编码');
          return;
        }
        const created = await api.createWarehouse({ warehouseCode: code, name: name || undefined });
        message.success(`仓库 ${created.warehouseCode} 已创建`);
      }
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      setWarehouseOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editingWarehouse ? '保存' : '创建'}失败：${String(e)}`);
    } finally {
      setWarehouseSaving(false);
    }
  };

  const columns: ColumnsType<Location> = [
    { title: '库位编码', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    ...(warehouseOn
      ? [
          {
            title: '仓库',
            key: 'warehouse',
            render: (_: unknown, row: Location) => row.warehouseName || '未分仓',
          } satisfies ColumnsType<Location>[number],
        ]
      : []),
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
          {warehouseOn ? '编辑' : '改名'}
        </Button>
      ),
    },
  ];

  const warehouseColumns: ColumnsType<Warehouse> = [
    { title: '仓库编码', dataIndex: 'warehouseCode', key: 'warehouseCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '库位数', dataIndex: 'locationCount', key: 'locationCount', width: 90 },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEditWarehouse(row)}>
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
          <>
            <LocationSheetPort />
            {warehouseOn && (
              <Button icon={<PlusOutlined />} onClick={openCreateWarehouse}>
                新建仓库
              </Button>
            )}
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建库位
            </Button>
          </>
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
          {warehouseOn && (
            <Table<Warehouse>
              rowKey="id"
              size="small"
              columns={warehouseColumns}
              dataSource={warehouses.data ?? []}
              loading={warehouses.isLoading}
              pagination={false}
              locale={{ emptyText: '还没有仓库。不建仓库也能用，库位保持未分仓。' }}
            />
          )}
          <Table<Location>
            rowKey="id"
            columns={columns}
            dataSource={rows}
            loading={isLoading}
            pagination={serverPagination({
              current: list.page,
              total: totalOf(payload),
              onChange: list.setPage,
            })}
            locale={{ emptyText: '还没有库位，点右上角新建（不建也能用——库存全归 DEFAULT）' }}
          />
          <Typography.Text type="secondary">
            想停用某个库位：先把它里面的库存移到别处（库存页「移库」），库位留着不再使用即可——
            删掉会让引用它的历史单据与流水失去落点。
          </Typography.Text>
        </Space>
        <Modal
          title={editing ? `${warehouseOn ? '编辑库位' : '库位改名'} · ${editing.locationCode}` : '新建库位'}
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
            {warehouseOn && (
              <Form.Item name="warehouseCode" label="仓库" extra="不选就是未分仓。库存仍记在这个库位上。">
                <Select
                  allowClear
                  placeholder="未分仓"
                  options={(warehouses.data ?? []).map((warehouse) => ({
                    value: warehouse.warehouseCode,
                    label: `${warehouse.name}（${warehouse.warehouseCode}）`,
                  }))}
                />
              </Form.Item>
            )}
          </Form>
        </Modal>
        {warehouseOn && (
          <Modal
            title={editingWarehouse ? `仓库改名 · ${editingWarehouse.warehouseCode}` : '新建仓库'}
            open={warehouseOpen}
            onCancel={() => setWarehouseOpen(false)}
            onOk={() => warehouseForm.submit()}
            okText={editingWarehouse ? '保存' : '创建'}
            confirmLoading={warehouseSaving}
            destroyOnHidden
          >
            <Form form={warehouseForm} layout="vertical" onFinish={submitWarehouse}>
              <Form.Item
                name="warehouseCode"
                label="仓库编码"
                rules={editingWarehouse ? [] : [{ required: true, message: '请输入编码' }]}
                extra={editingWarehouse ? '编码是业务键，不可修改' : '如 WH-1。同一工作区里编码不能重复'}
              >
                <Input placeholder="如 WH-1" disabled={editingWarehouse != null} />
              </Form.Item>
              <Form.Item
                name="name"
                label="仓库名称"
                rules={editingWarehouse ? [{ required: true, message: '请输入名称' }] : []}
              >
                <Input placeholder={editingWarehouse ? '如 一号仓' : '可选，缺省同编码'} />
              </Form.Item>
            </Form>
          </Modal>
        )}
      </Card>
    </div>
  );
}
