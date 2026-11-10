import { useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCreateLocation, useLocations, useProfileSnapshot, useUpdateLocation } from '../api/hooks';
import { api, ApiError } from '../api/client';
import type { Location, Warehouse } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import PageHeader from '../components/PageHeader';
import { filledCode, useSeededField } from '../components/use-seeded-code';
import { LocationSheetPort } from '../components/sheet-specs';
import { monoCell, serverPagination } from '../components/table-style';

const fmtTime = (v: string) => v.slice(0, 19).replace('T', ' ');

const SPLIT_STYLE = `
.loc-split { display: flex; flex: 1; min-height: 0; align-items: stretch; }
.loc-parents {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--loc-nav-bg);
  border-right: 1px solid var(--loc-line);
  min-height: 0;
}
.loc-parents-head {
  padding: 14px 16px 8px;
  font-weight: 600;
  flex: none;
}
.loc-parents-body { overflow: auto; flex: 1; padding-bottom: 8px; }
.loc-parent {
  display: flex;
  width: 100%;
  text-align: left;
  border: none;
  border-left: 3px solid transparent;
  background: transparent;
  padding: 10px 14px 10px 13px;
  cursor: pointer;
  gap: 8px;
  align-items: center;
  color: inherit;
  font: inherit;
}
.loc-parent:hover { background: var(--loc-hover); }
.loc-parent[aria-current="true"] {
  background: var(--loc-active);
  border-left-color: var(--loc-accent);
}
.loc-parent-text { flex: 1; min-width: 0; }
.loc-parent-name {
  display: block;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loc-parent-code {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--loc-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loc-parent-count {
  flex: none;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--loc-pill);
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.loc-children { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px 16px 12px; }
.loc-section {
  padding: 14px 16px 4px;
  font-size: 12px;
  color: var(--loc-muted);
}
@media (max-width: 800px) {
  .loc-split { flex-direction: column; min-height: 0; }
  .loc-parents {
    width: auto;
    max-height: 280px;
    border-right: none;
    border-bottom: 1px solid var(--loc-line);
  }
}
`;

type ParentSel = { kind: 'warehouse'; code: string } | { kind: 'unassigned' };

/**
 * 还没点过左侧时，选中第一个仓库；清单还在加载则先不定。
 * 点过「未分仓」或某个仓库之后，就停在用户选的那一项。
 */
function resolveParent(picked: ParentSel | null, warehouses: Warehouse[] | undefined): ParentSel | null {
  if (picked) return picked;
  if (!warehouses) return null;
  const first = warehouses[0];
  return first ? { kind: 'warehouse', code: first.warehouseCode } : { kind: 'unassigned' };
}

function parentKeyOf(warehouseOn: boolean, parent: ParentSel | null): string {
  if (!warehouseOn) return 'all';
  if (!parent) return 'pending';
  return parent.kind === 'warehouse' ? `wh:${parent.code}` : 'unassigned';
}

/**
 * 库位管理页——档案大类下的物理存储位主数据。
 * 只能建 + 改名，不能删也不能改编码：locationCode 是业务键，历史单据/
 * 库存流水按它引用，删了或改了会让旧账指向不存在的桶（护栏在服务端工具）。
 * 虚拟库位 DEFAULT（未指定库位时库存的归宿）不落库，故不在清单里——
 * 页脚说明里顺带交代它可直接在单据/调整中引用。
 * module.warehouse 开启时，仓库是父、库位是子：左侧选仓库（或未分仓），
 * 右侧只列这个父节点下面的库位。库位按页向服务端要，并带上仓库范围。
 */
export default function LocationsPage() {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const snapshot = useProfileSnapshot();
  const warehouseOn = snapshot.data?.modules['module.warehouse']?.enabled === true;
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: api.warehouses,
    enabled: warehouseOn,
  });
  const unassignedCount = useQuery({
    queryKey: ['locations', 'unassigned-count'],
    queryFn: () => api.locations({ unassigned: true, limit: 1, offset: 0 }),
    enabled: warehouseOn,
  });
  const [picked, setPicked] = useState<ParentSel | null>(null);
  const warehouseRows = warehouses.data;
  const parent = warehouseOn
    ? resolveParent(picked, warehouses.isPending ? undefined : (warehouseRows ?? []))
    : null;
  const parentKey = parentKeyOf(warehouseOn, parent);
  const [query, setQuery] = useState('');
  const [queryScope, setQueryScope] = useState(parentKey);
  if (queryScope !== parentKey) {
    setQueryScope(parentKey);
    setQuery('');
  }
  const activeQuery = queryScope === parentKey ? query : '';
  const list = useListPage(`${activeQuery}|${parentKey}`);
  const scoped = !warehouseOn
    ? {}
    : parent?.kind === 'warehouse'
      ? { warehouseCode: parent.code }
      : { unassigned: true as const };
  const { data: locationPayload, isLoading } = useLocations({
    q: activeQuery || undefined,
    limit: list.limit,
    offset: list.offset,
    ...scoped,
  });
  const locationPage = locationPayload as Location[] | ListPage<Location> | undefined;
  const locations = rowsOf(locationPage);
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [form] = Form.useForm<{ locationCode: string; name?: string; warehouseCode?: string; capacity?: number | null }>();
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [warehouseSaving, setWarehouseSaving] = useState(false);
  const [warehouseForm] = Form.useForm<{ warehouseCode: string; name?: string }>();
  useSeededField(form, 'locationCode', open && !editing ? 'location' : null);
  useSeededField(warehouseForm, 'warehouseCode', warehouseOpen && !editingWarehouse ? 'warehouse' : null);

  const openCreate = (warehouseCode?: string) => {
    setEditing(null);
    form.resetFields();
    if (warehouseCode) form.setFieldsValue({ warehouseCode });
    setOpen(true);
  };

  const openEdit = (row: Location) => {
    setEditing(row);
    form.setFieldsValue({
      locationCode: row.locationCode,
      name: row.name,
      warehouseCode: row.warehouseCode ?? undefined,
      capacity: typeof row.capacity === 'number' ? row.capacity : undefined,
    });
    setOpen(true);
  };

  const submit = async (values: { locationCode: string; name?: string; warehouseCode?: string; capacity?: number | null }) => {
    const name = values.name?.trim();
    const warehouseCode = values.warehouseCode?.trim() ?? '';
    const capacity = typeof values.capacity === 'number' ? values.capacity : null;
    try {
      if (editing) {
        if (!name) {
          message.error('库位名称不能为空');
          return;
        }
        const r = await update.mutateAsync({
          locationCode: editing.locationCode,
          body: warehouseOn ? { name, warehouseCode, capacity } : { name, capacity },
        });
        message.success(
          warehouseOn ? `库位 ${r.locationCode} 已保存` : `库位 ${r.locationCode} 已更名为「${r.name}」`,
        );
      } else {
        const code = filledCode(values.locationCode);
        const r = await create.mutateAsync({
          ...(code ? { locationCode: code } : {}),
          name: name || undefined,
          ...(warehouseOn && warehouseCode ? { warehouseCode } : {}),
          ...(capacity != null ? { capacity } : {}),
        });
        message.success(`库位 ${r.locationCode} 已创建`);
      }
      if (warehouseOn) setPicked(warehouseCode ? { kind: 'warehouse', code: warehouseCode } : { kind: 'unassigned' });
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
        const code = filledCode(values.warehouseCode);
        const created = await api.createWarehouse({
          ...(code ? { warehouseCode: code } : {}),
          name: name || undefined,
        });
        message.success(`仓库 ${created.warehouseCode} 已创建`);
        setPicked({ kind: 'warehouse', code: created.warehouseCode });
      }
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      await queryClient.invalidateQueries({ queryKey: ['numbering'] });
      setWarehouseOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editingWarehouse ? '保存' : '创建'}失败：${String(e)}`);
    } finally {
      setWarehouseSaving(false);
    }
  };

  const columns: ColumnsType<Location> = [
    { title: '库位编码', dataIndex: 'locationCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name' },
    {
      title: '容量',
      dataIndex: 'capacity',
      width: 90,
      render: (value: number | null | undefined) => (typeof value === 'number' ? value : '不限'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => fmtTime(value),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (value: string) => fmtTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
          {warehouseOn ? '编辑' : '改名'}
        </Button>
      ),
    },
  ];

  const selectedWarehouse =
    parent?.kind === 'warehouse' ? warehouseRows?.find((row) => row.warehouseCode === parent.code) : undefined;
  const createIn = parent?.kind === 'warehouse' ? parent.code : undefined;
  const block = snapshot.isPending || (warehouseOn && picked == null && warehouses.isPending);
  const unassignedTotal = unassignedCount.isSuccess ? totalOf(unassignedCount.data) : undefined;

  const locationTable = (
    <Table<Location>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={locations}
      loading={isLoading}
      pagination={serverPagination({
        current: list.page,
        total: totalOf(locationPage),
        onChange: list.setPage,
      })}
      locale={{
        emptyText: activeQuery
          ? parent?.kind === 'warehouse'
            ? '这个仓库里没有匹配的库位'
            : '没有匹配的库位'
          : parent?.kind === 'unassigned'
            ? '没有未分仓的库位。新建时不选仓库，就会出现在这里。'
            : parent?.kind === 'warehouse'
              ? '这个仓库还没有库位。点右上角「新建库位」。'
              : '还没有库位，点右上角新建（不建也能用——库存全归 DEFAULT）',
      }}
    />
  );

  const locationModals = (
    <>
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
            extra={
              editing
                ? '编码是业务键，历史单据按它引用，不可修改'
                : '已填入建议编号，可以改。留空则按编号规则生成。DEFAULT 是保留字不可用'
            }
          >
            <Input placeholder="如 A-01（全库唯一）" disabled={editing != null} />
          </Form.Item>
          <Form.Item name="name" label="库位名称" rules={editing ? [{ required: true, message: '请输入名称' }] : []}>
            <Input placeholder={editing ? '如 A 区 01 货架' : '可选，缺省同编码，如 A 区 01 货架'} />
          </Form.Item>
          <Form.Item name="capacity" label="容量" extra="不填表示不限。上架是否拦截由仓库的上架库容决定。">
            <InputNumber min={0.001} style={{ width: '100%' }} placeholder="不填表示不限" />
          </Form.Item>
          {warehouseOn && (
            <Form.Item name="warehouseCode" label="所属仓库" extra="不选就是未分仓。库存仍记在这个库位上。">
              <Select
                allowClear
                placeholder="未分仓"
                options={(warehouseRows ?? []).map((warehouse) => ({
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
              extra={
                editingWarehouse
                  ? '编码是业务键，不可修改'
                  : '已填入建议编号，可以改。留空则按编号规则生成。同一工作区里编码不能重复'
              }
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
    </>
  );

  const splitVars = {
    '--loc-line': token.colorBorderSecondary,
    '--loc-hover': token.colorFillTertiary,
    '--loc-active': token.colorPrimaryBg,
    '--loc-accent': token.colorPrimary,
    '--loc-muted': token.colorTextSecondary,
    '--loc-pill': token.colorFillSecondary,
    '--loc-nav-bg': token.colorFillAlter,
  } as CSSProperties;

  return (
    <div
      className="app-fill"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        height: '100%',
        maxHeight: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title="库位管理"
        subtitle={
          warehouseOn
            ? '仓库是上一层，库位挂在仓库下面。左侧选仓库，右侧是这个仓库里的库位。编码不能改，库位不删除。'
            : '仓库内的物理存储位：建库位、改名称（编码是业务键不可改，库位不删除以保留历史账）'
        }
        extra={
          block ? null : (
            <>
              {warehouseOn ? null : (
                <Input.Search
                  allowClear
                  placeholder="按编码/名称搜索"
                  onSearch={(value) => setQuery(value.trim())}
                  style={{ width: 200 }}
                />
              )}
              <LocationSheetPort />
              {warehouseOn && (
                <Button icon={<PlusOutlined />} onClick={openCreateWarehouse}>
                  新建仓库
                </Button>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(createIn)}>
                新建库位
              </Button>
            </>
          )
        }
      />
      {block ? (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spin />
          </div>
        </Card>
      ) : warehouseOn && parent ? (
        <Card
          style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
          <style>{SPLIT_STYLE}</style>
          <div className="loc-split" style={splitVars}>
            <nav className="loc-parents" aria-label="仓库">
              <div className="loc-parents-head">仓库</div>
              <div className="loc-parents-body">
                {warehouses.isError ? (
                  <Typography.Text type="danger" style={{ display: 'block', padding: '8px 16px' }}>
                    仓库没有加载出来
                  </Typography.Text>
                ) : null}
                {(warehouseRows ?? []).length === 0 && !warehouses.isError ? (
                  <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 16px 8px', fontSize: 12 }}>
                    还没有仓库。库位可以先放在未分仓。
                  </Typography.Text>
                ) : (
                  (warehouseRows ?? []).map((warehouse) => {
                    const active = parent.kind === 'warehouse' && parent.code === warehouse.warehouseCode;
                    return (
                      <button
                        key={warehouse.id}
                        type="button"
                        className="loc-parent"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setPicked({ kind: 'warehouse', code: warehouse.warehouseCode })}
                      >
                        <span className="loc-parent-text">
                          <span className="loc-parent-name">{warehouse.name}</span>
                          <span className="loc-parent-code">{warehouse.warehouseCode}</span>
                        </span>
                        <span className="loc-parent-count">{warehouse.locationCount}</span>
                      </button>
                    );
                  })
                )}
                <div className="loc-section">未归属</div>
                <button
                  type="button"
                  className="loc-parent"
                  aria-current={parent.kind === 'unassigned' ? 'true' : undefined}
                  onClick={() => setPicked({ kind: 'unassigned' })}
                >
                  <span className="loc-parent-text">
                    <span className="loc-parent-name">未分仓</span>
                    <span className="loc-parent-code">还没划进任何仓库</span>
                  </span>
                  {unassignedTotal != null ? <span className="loc-parent-count">{unassignedTotal}</span> : null}
                </button>
              </div>
            </nav>
            <section className="loc-children" aria-label="库位">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong style={{ fontSize: 16 }}>
                    {parent.kind === 'unassigned' ? '未分仓' : (selectedWarehouse?.name ?? parent.code)}
                  </Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {parent.kind === 'unassigned'
                        ? '这些库位还没有划进仓库'
                        : `${selectedWarehouse?.warehouseCode ?? parent.code} · 这个仓库里的库位`}
                    </Typography.Text>
                  </div>
                </div>
                <Space wrap>
                  {selectedWarehouse ? (
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditWarehouse(selectedWarehouse)}>
                      改名
                    </Button>
                  ) : null}
                  <Input.Search
                    key={parentKey}
                    allowClear
                    placeholder="搜索编码或名称"
                    onSearch={(value) => setQuery(value.trim())}
                    style={{ width: 220 }}
                  />
                </Space>
              </div>
              {locationTable}
              <Typography.Text type="secondary">
                想停用某个库位：先把它里面的库存移到别处（库存页「移库」），库位留着不再使用即可——
                删掉会让引用它的历史单据与流水失去落点。DEFAULT 是虚拟库位，不用建，单据和调整里可以直接引用。
              </Typography.Text>
            </section>
          </div>
          {locationModals}
        </Card>
      ) : (
        <Card style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {locationTable}
            <Typography.Text type="secondary">
              想停用某个库位：先把它里面的库存移到别处（库存页「移库」），库位留着不再使用即可——
              删掉会让引用它的历史单据与流水失去落点。
            </Typography.Text>
          </Space>
          {locationModals}
        </Card>
      )}
    </div>
  );
}
