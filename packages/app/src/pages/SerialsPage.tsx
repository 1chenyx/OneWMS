import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Input, Select, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useProfileSnapshot } from '../api/hooks';
import { api, ApiError } from '../api/client';
import type { SerialRow } from '../api/client';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell } from '../components/table-style';

/**
 * 序列号页。号在收货或库存调整时登记，这一页只负责查。
 * module.serial 关闭时不进导航；若还停在这一页，只留一句说明。
 */
export default function SerialsPage() {
  const { navigate } = useAppNav();
  const snapshot = useProfileSnapshot();
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;
  const lpnOn = snapshot.data?.modules['module.lpn']?.enabled === true;
  const [skuCode, setSkuCode] = useState('');
  const [status, setStatus] = useState('in');
  const [applied, setApplied] = useState<{ skuCode?: string; status: string }>({ status: 'in' });

  const serials = useQuery({
    queryKey: ['serials', applied.skuCode ?? '', applied.status],
    queryFn: () => api.serials(applied),
    enabled: serialOn,
  });

  const columns: ColumnsType<SerialRow> = [
    { title: '序列号', dataIndex: 'serialNo', key: 'serialNo', onCell: monoCell },
    { title: 'SKU', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '库位', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
    { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (value: SerialRow['status']) => (value === 'in' ? '在库' : '已出库'),
    },
    {
      title: '托盘',
      dataIndex: 'lpnCode',
      key: 'lpnCode',
      onCell: monoCell,
      render: (code?: string) => {
        if (!code) return <Typography.Text type="secondary">-</Typography.Text>;
        if (!lpnOn) return code;
        return (
          <Typography.Link onClick={() => navigate('pallets', { lpnCode: code })}>{code}</Typography.Link>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="序列号"
        subtitle="一件一个号。收货或调整库存时登记，这里按 SKU 和状态查看。"
        extra={
          serialOn ? (
            <>
              <Input
                allowClear
                placeholder="SKU 编码"
                value={skuCode}
                onChange={(e) => setSkuCode(e.target.value)}
                onPressEnter={() => setApplied({ skuCode: skuCode.trim() || undefined, status })}
                style={{ width: 160 }}
              />
              <Select
                value={status}
                onChange={setStatus}
                style={{ width: 120 }}
                options={[
                  { value: 'in', label: '在库' },
                  { value: 'out', label: '已出库' },
                  { value: 'all', label: '全部' },
                ]}
              />
              <Button type="primary" onClick={() => setApplied({ skuCode: skuCode.trim() || undefined, status })}>
                查询
              </Button>
            </>
          ) : null
        }
      />
      {snapshot.isSuccess && !serialOn ? (
        <Card>序列号已关闭。到设置里重新启用 module.serial 后可以查看已经记下的号。</Card>
      ) : (
        <Card>
          {serials.error ? (
            <Typography.Paragraph type="danger">
              {serials.error instanceof ApiError ? serials.error.message : '序列号加载失败'}
            </Typography.Paragraph>
          ) : null}
          <Table<SerialRow>
            rowKey="serialNo"
            columns={columns}
            dataSource={serials.data ?? []}
            loading={serialOn && serials.isLoading}
            pagination={TABLE_PAGINATION}
            locale={{ emptyText: '没有序列号' }}
          />
        </Card>
      )}
    </div>
  );
}
