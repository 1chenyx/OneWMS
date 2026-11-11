import { useState } from 'react';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Input, Segmented, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { usePartners } from '../api/hooks';
import type { Partner } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import PartnerFormModal from '../components/PartnerFormModal';
import PageHeader from '../components/PageHeader';
import { PartnerSheetPort } from '../components/sheet-specs';
import { serverPagination, monoCell } from '../components/table-style';

/**
 * 往来单位管理页（M21）——供应商/客户统一档案。
 * Segmented 切换种类视图（supplier/customer/全部）；搜索 = 编码/名称模糊（服务端 q）。
 * 种类不可改（改身份 = 新建编码）——编辑表单里也不出现 kind 控件。
 */
type KindView = 'all' | 'supplier' | 'customer';

export default function PartnersPage() {
  const [kindView, setKindView] = useState<KindView>('all');
  const [query, setQuery] = useState('');
  const list = useListPage(`${kindView}|${query}`);
  const { data: partners, isLoading } = usePartners({
    kind: kindView === 'all' ? undefined : kindView,
    q: query || undefined,
    limit: list.limit,
    offset: list.offset,
  });
  const payload = partners as Partner[] | ListPage<Partner> | undefined;
  const rows = rowsOf(payload);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);

  // 新建按钮跟随当前视图的种类（「全部」视图下缺省供应商——最常见的建档场景）
  const createKind: 'supplier' | 'customer' =
    kindView === 'customer' ? 'customer' : 'supplier';

  const dash = (v: string | null) =>
    v ?? <Typography.Text type="secondary">-</Typography.Text>;

  const columns: ColumnsType<Partner> = [
    { title: '编码', dataIndex: 'partnerCode', key: 'partnerCode', onCell: monoCell },
    {
      title: '种类',
      dataIndex: 'kind',
      key: 'kind',
      width: 96,
      render: (v: Partner['kind']) =>
        v === 'supplier' ? <Typography.Text type="warning">供应商</Typography.Text> : <Typography.Text type="success">客户</Typography.Text>,
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '联系人', dataIndex: 'contact', key: 'contact', render: dash },
    { title: '电话', dataIndex: 'phone', key: 'phone', render: dash },
    { title: '地址', dataIndex: 'address', key: 'address', render: dash, ellipsis: true },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_, r) => (
        <Button
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setEditing(r);
            setFormOpen(true);
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="往来单位"
        subtitle="供应商与客户主数据：入库单关联供应商、出库单关联客户"
        extra={
          <>
            <Segmented
              value={kindView}
              onChange={(v) => setKindView(v as KindView)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'supplier', label: '供应商' },
                { value: 'customer', label: '客户' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="按编码/名称搜索"
              onSearch={(v) => setQuery(v.trim())}
              style={{ width: 200 }}
            />
            <PartnerSheetPort />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              新建{createKind === 'supplier' ? '供应商' : '客户'}
            </Button>
          </>
        }
      />
      <Card className="list-card">
        <Table<Partner>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={isLoading}
          pagination={serverPagination({
            current: list.page,
            total: totalOf(payload),
            onChange: list.setPage,
          })}
          locale={{
            emptyText:
              query || kindView !== 'all'
                ? '没有匹配的往来单位'
                : '还没有往来单位，点右上角新建（入库单/出库单可关联）',
          }}
        />
        <PartnerFormModal
          open={formOpen}
          onClose={() => setFormOpen(false)}
          kind={createKind}
          partner={editing}
        />
      </Card>
    </div>
  );
}
