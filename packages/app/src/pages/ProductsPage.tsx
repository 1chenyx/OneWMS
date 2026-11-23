import { useState } from 'react';
import { AppstoreAddOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Checkbox, Input, Popconfirm, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  useArchiveProduct,
  useProductSkus,
  useProducts,
  useUnarchiveProduct,
} from '../api/hooks';
import { skuLabel } from '../api/client';
import type { Product, Sku } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import ProductFormModal from '../components/ProductFormModal';
import VariantMatrixModal from '../components/VariantMatrixModal';
import PageHeader from '../components/PageHeader';
import { serverPagination, monoCell } from '../components/table-style';

/**
 * 商品管理页（多规格 SPU）——SKU 的上一级归组。
 * 一行一个商品：编码 / 名称 / 规格维度 / 挂靠 SKU 数 / 状态。
 * 展开行下钻该商品下的规格 SKU（/api/skus?productCode=），
 * 「按规格生成 SKU」把维度的笛卡尔积摊开批量建档。
 * 商品本身不记库存：条码、单位、安全库存都在 SKU 上，所以这里没有那些列。
 */
export default function ProductsPage() {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const list = useListPage(`${query}|${showArchived ? 1 : 0}`);
  const { data: products, isLoading } = useProducts(query || undefined, showArchived, {
    limit: list.limit,
    offset: list.offset,
  });
  const payload = products as Product[] | ListPage<Product> | undefined;
  const rows = rowsOf(payload);
  const { message } = App.useApp();
  const archive = useArchiveProduct();
  const unarchive = useUnarchiveProduct();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [matrix, setMatrix] = useState<Product | null>(null);

  const toggleArchive = (product: Product) => {
    const archived = (product.status ?? 'active') === 'archived';
    const run = archived
      ? unarchive.mutateAsync(product.productCode)
      : archive.mutateAsync(product.productCode);
    run
      .then(() => message.success(archived ? `已恢复 ${product.productCode}` : `已停用 ${product.productCode}`))
      .catch((e: Error) => message.error(e.message));
  };

  const columns: ColumnsType<Product> = [
    {
      title: '编码',
      dataIndex: 'productCode',
      key: 'productCode',
      onCell: monoCell,
      render: (v: string, r) => (
        <>
          {v}
          {(r.status ?? 'active') === 'archived' ? <Tag style={{ marginLeft: 8 }}>已停用</Tag> : null}
        </>
      ),
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '规格维度',
      dataIndex: 'specDims',
      key: 'specDims',
      render: (_, r) =>
        r.specDims.length === 0 ? (
          <Typography.Text type="secondary">无（单规格）</Typography.Text>
        ) : (
          r.specDims.map((d) => (
            <Tag key={d.name}>
              {d.name}：{d.values.join(' / ')}
            </Tag>
          ))
        ),
    },
    {
      title: 'SKU 数',
      dataIndex: 'skuCount',
      key: 'skuCount',
      width: 90,
      align: 'right',
      render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 170,
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_, r) => {
        const archived = (r.status ?? 'active') === 'archived';
        return (
          <>
            {r.specDims.length > 0 && !archived ? (
              <Button size="small" icon={<AppstoreAddOutlined />} onClick={() => setMatrix(r)}>
                按规格生成 SKU
              </Button>
            ) : null}{' '}
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setFormOpen(true);
              }}
            >
              编辑
            </Button>{' '}
            {archived ? (
              <Popconfirm
                title="恢复这个商品？"
                description="恢复后重新出现在商品列表，SKU 可以继续挂规格"
                onConfirm={() => toggleArchive(r)}
              >
                <Button size="small">恢复</Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title="停用这个商品？"
                description="商品列表隐藏、SKU 不能再挂到它下面；已挂 SKU 与库存照常出入库，可随时恢复"
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
    <div
      className="app-fill list-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title="商品（多规格）"
        subtitle="SKU 的上一级归组：一个商品定义规格维度，每个规格组合是一个 SKU（库存与单据都记在 SKU 上）"
        extra={
          <>
            <Input.Search
              allowClear
              placeholder="按编码/名称搜索"
              onSearch={(v) => setQuery(v.trim())}
              style={{ width: 220 }}
            />
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              显示已停用
            </Checkbox>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              新建商品
            </Button>
          </>
        }
      />
      <Card className="list-card">
        <Table<Product>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={isLoading}
          expandable={{
            expandedRowRender: (r) => <ProductSkuPanel productCode={r.productCode} />,
            rowExpandable: (r) => r.skuCount > 0,
          }}
          pagination={serverPagination({
            current: list.page,
            pageSize: list.pageSize,
            total: totalOf(payload),
            onChange: list.onChange,
          })}
          locale={{
            emptyText: query
              ? '没有匹配的商品'
              : '还没有商品。单规格商品直接在「SKU 管理」建档即可，多规格才需要在这里先建商品',
          }}
        />
        <ProductFormModal open={formOpen} onClose={() => setFormOpen(false)} product={editing} />
        <VariantMatrixModal open={matrix !== null} onClose={() => setMatrix(null)} product={matrix} />
      </Card>
    </div>
  );
}

/** 展开行：该商品下挂的规格 SKU（启用档）。挂在 ['skus'] queryKey 前缀下，建/改 SKU 后自动刷新 */
function ProductSkuPanel({ productCode }: { productCode: string }) {
  const { data: skus, isLoading } = useProductSkus(productCode);
  const columns: ColumnsType<Sku> = [
    { title: 'SKU 编码', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称 · 规格', key: 'label', render: (_, r) => skuLabel(r) },
    {
      title: '条码',
      dataIndex: 'barcode',
      key: 'barcode',
      onCell: monoCell,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">-</Typography.Text>,
    },
  ];
  return (
    <Table<Sku>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={skus ?? []}
      loading={isLoading}
      pagination={false}
    />
  );
}
