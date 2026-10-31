import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Card, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FieldExtension } from '@one/core';
import { useProfileSnapshot, useSkus } from '../api/hooks';
import type { Sku } from '../api/client';
import SkuFormModal from '../components/SkuFormModal';

/**
 * SKU 管理页——动态列是 Profile 配置的第一个真实消费闭环：
 * 列 = 固定列（编码/名称/更新时间）+ schema.entities.sku.extensions 中
 * visible !== false 的扩展列（dataIndex 指向 extData[key]）。
 * 在配置确认页确认「隐藏字段」提议后切回本页，列即消失（数据保留）。
 */
export default function SkusPage() {
  const { data: skus, isLoading } = useSkus();
  const snapshot = useProfileSnapshot();
  const [formOpen, setFormOpen] = useState(false);

  const extensions = (snapshot.data?.schema.entities['sku']?.extensions ?? []).filter((e) => e.visible);

  const columns: ColumnsType<Sku> = [
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode' },
    { title: '名称', dataIndex: 'name', key: 'name' },
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
  ];

  return (
    <Card
      title="SKU 管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
          新建 SKU
        </Button>
      }
    >
      <Table<Sku>
        rowKey="id"
        columns={columns}
        dataSource={skus ?? []}
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: '还没有 SKU，点右上角新建或让 AI 帮你建' }}
      />
      {extensions.length === 0 && skus && skus.length > 0 ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          扩展字段全部隐藏中。想让 AI 增加/恢复字段，去「AI 对话」页提需求。
        </Typography.Text>
      ) : null}
      <SkuFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </Card>
  );
}

/** 扩展列值渲染：布尔中文化、对象序列化、空值占位 */
function renderExtValue(v: unknown) {
  if (v === undefined || v === null || v === '') return <Typography.Text type="secondary">-</Typography.Text>;
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
