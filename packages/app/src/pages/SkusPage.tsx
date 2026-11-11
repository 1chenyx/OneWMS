import { useState } from 'react';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Checkbox, Input, Popconfirm, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FieldExtension } from '@one/core';
import { useArchiveSku, useProfileSnapshot, useSkus, useUnarchiveSku } from '../api/hooks';
import type { Sku } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import SkuFormModal from '../components/SkuFormModal';
import PageHeader from '../components/PageHeader';
import { SkuSheetPort } from '../components/sheet-specs';
import { serverPagination, monoCell, numCell } from '../components/table-style';

/**
 * SKU 管理页——动态列是 Profile 配置的第一个真实消费闭环：
 * 列 = 固定列（编码/名称/条码/单位/安全库存/状态/更新时间）+ schema.entities.sku.extensions
 * 中 visible !== false 的扩展列（dataIndex 指向 extData[key]）。
 * 在 AI 对话页确认「隐藏字段」提议后切回本页，列即消失（数据保留）。
 * 搜索框（M18）：编码/名称/条码 三字段模糊（服务端 q 参数），回车/点按钮触发。
 * 安全库存列（M20）：低库存预警阈值，0 显 -（不预警）。
 * 单位列（A3）：kg / 箱 / 件…，空显 -。
 * 软停用（A2）：默认只列启用档；勾「显示已停用」拉全量；停用档灰 Tag + 恢复按钮——
 * 建错的档案从此有归宿（隐藏 + 退出预警），数据一条不删、可随时恢复。
 */
export default function SkusPage() {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const list = useListPage(`${query}|${showArchived ? 1 : 0}`);
  const { data: skus, isLoading } = useSkus(query || undefined, showArchived, {
    limit: list.limit,
    offset: list.offset,
  });
  const skuPayload = skus as Sku[] | ListPage<Sku> | undefined;
  const rows = rowsOf(skuPayload);
  const snapshot = useProfileSnapshot();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Sku | null>(null);
  const { message } = App.useApp();
  const archive = useArchiveSku();
  const unarchive = useUnarchiveSku();

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (sku: Sku) => {
    setEditing(sku);
    setFormOpen(true);
  };

  const toggleArchive = (sku: Sku) => {
    const archived = (sku.status ?? 'active') === 'archived';
    const run = archived ? unarchive.mutateAsync(sku.skuCode) : archive.mutateAsync(sku.skuCode);
    run
      .then(() => message.success(archived ? `已恢复 ${sku.skuCode}` : `已停用 ${sku.skuCode}`))
      .catch((e: Error) => message.error(e.message));
  };

  const extensions = (snapshot.data?.schema.entities['sku']?.extensions ?? []).filter((e) => e.visible);

  const columns: ColumnsType<Sku> = [
    {
      title: '编码',
      dataIndex: 'skuCode',
      key: 'skuCode',
      onCell: monoCell,
      render: (v: string, r) => (
        <>
          {v}
          {(r.status ?? 'active') === 'archived' ? (
            <Tag style={{ marginLeft: 8 }}>已停用</Tag>
          ) : null}
        </>
      ),
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '条码',
      dataIndex: 'barcode',
      key: 'barcode',
      onCell: monoCell,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '单位',
      dataIndex: 'unit',
      key: 'unit',
      render: (v: string | null) => v ?? <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '安全库存',
      dataIndex: 'reorderPoint',
      key: 'reorderPoint',
      align: 'right',
      onCell: numCell,
      render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">-</Typography.Text>),
    },
    ...extensions.map((ext: FieldExtension) => ({
      title: ext.label,
      key: ext.key,
      dataIndex: ['extData', ext.key] as const,
      render: renderExtValue,
    })),
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
      width: 170,
      render: (_, r) => {
        const archived = (r.status ?? 'active') === 'archived';
        return (
          <>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
              编辑
            </Button>{' '}
            {archived ? (
              <Popconfirm
                title="恢复这个 SKU？"
                description="恢复后重新出现在列表、选择器与预警里"
                onConfirm={() => toggleArchive(r)}
              >
                <Button size="small">恢复</Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title="停用这个 SKU？"
                description="列表与选择器隐藏、退出预警；剩余库存不受影响，可随时恢复"
                onConfirm={() => toggleArchive(r)}
              >
                <Button size="small" danger>
                  停用
                </Button>
              </Popconfirm>
            )}
          </>
        );
      },
    },
  ];

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="SKU 管理"
        subtitle="商品主数据：编码、条码与扩展字段（扩展列由配置驱动）"
        extra={
          <>
            <Input.Search
              allowClear
              placeholder="按编码/名称/条码搜索"
              onSearch={(v) => setQuery(v.trim())}
              style={{ width: 220 }}
            />
            <Checkbox
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            >
              显示已停用
            </Checkbox>
            <SkuSheetPort extensions={extensions} />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建 SKU
            </Button>
          </>
        }
      />
      <Card className="list-card">
        <Table<Sku>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={isLoading}
          pagination={serverPagination({
            current: list.page,
            total: totalOf(skuPayload),
            onChange: list.setPage,
          })}
          locale={{ emptyText: query ? '没有匹配的 SKU' : '还没有 SKU，点右上角新建或让 AI 帮你建' }}
        />
        {extensions.length === 0 && rows.length > 0 ? (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            扩展字段全部隐藏中。想让 AI 增加/恢复字段，去「AI 对话」页提需求。
          </Typography.Text>
        ) : null}
        <SkuFormModal open={formOpen} onClose={() => setFormOpen(false)} sku={editing} />
      </Card>
    </div>
  );
}

/** 扩展列值渲染：布尔中文化、对象序列化、空值占位 */
function renderExtValue(v: unknown) {
  if (v === undefined || v === null || v === '') return <Typography.Text type="secondary">-</Typography.Text>;
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
