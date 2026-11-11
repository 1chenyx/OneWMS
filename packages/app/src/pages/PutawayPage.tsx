import { useMemo, useState } from 'react';
import { VerticalAlignTopOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Input, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useOrders, useProfileSnapshot } from '../api/hooks';
import type { Order } from '../api/client';
import PutawayWork from '../components/PutawayWork';
import PageHeader from '../components/PageHeader';
import { monoCell, TABLE_PAGINATION } from '../components/table-style';
import { useAppNav } from '../app-nav';
import { fmtQty } from '../lib/format';

/**
 * 上架页。module.putaway 打开后，已收货的入库单在这里上架。
 * 入库单页不再做这一步。上架之后回入库单结束单据。
 */
export default function PutawayPage() {
  const { takeInitialFilter } = useAppNav();
  const [orderNoFilter, setOrderNoFilter] = useState(() => takeInitialFilter()?.orderNo ?? '');
  const snapshot = useProfileSnapshot();
  const putawayOff = snapshot.data?.modules['module.putaway']?.enabled === false;
  const qcOn = snapshot.data?.modules['module.qc']?.enabled === true;
  const { data: orders, isLoading } = useOrders('in');
  const [workNo, setWorkNo] = useState<string | null>(null);
  const keyword = orderNoFilter.trim().toLowerCase();

  const waiting = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).filter(
        (order) =>
          order.direction === 'in' &&
          (order.state === 'inspected' || (order.state === 'received' && !qcOn)) &&
          (keyword ? order.orderNo.toLowerCase().includes(keyword) : true),
      ),
    [orders, keyword, qcOn],
  );

  const columns: ColumnsType<Order> = [
    { title: '入库单号', dataIndex: 'orderNo', key: 'orderNo', onCell: monoCell },
    {
      title: '往来单位',
      key: 'partner',
      render: (_, order) =>
        order.partnerName ? (
          <span>
            {order.partnerName}
            {order.partnerCode ? (
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                {order.partnerCode}
              </Typography.Text>
            ) : null}
          </span>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '明细',
      key: 'lines',
      width: 140,
      render: (_, order) => {
        const qty = order.lines.reduce((sum, line) => sum + line.quantity, 0);
        return `${order.lines.length} 行 / ${fmtQty(qty)}`;
      },
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (value: string | null) => value ?? '-' },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 180,
      render: (value: string) => value.slice(0, 19).replace('T', ' '),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, order) => (
        <Button
          size="small"
          type="primary"
          icon={<VerticalAlignTopOutlined aria-hidden />}
          onClick={() => setWorkNo(order.orderNo)}
        >
          上架
        </Button>
      ),
    },
  ];

  const working = waiting.find((order) => order.orderNo === workNo);
  if (working) return <PutawayWork order={working} onBack={() => setWorkNo(null)} />;

  return (
    <div
      className="app-fill list-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title="上架"
        subtitle="质检开着时，先质检再来这里。进入详情后，一行可以分到多个库位。上架后再回入库单结束。"
        extra={
          <Input
            allowClear
            placeholder="按单号过滤"
            value={orderNoFilter}
            onChange={(event) => setOrderNoFilter(event.target.value)}
            style={{ width: 180 }}
          />
        }
      />
      {putawayOff ? (
        <Alert
          type="info"
          showIcon
          message="上架已关闭。新的入库单收货后直接结束。已经收货、还没上架的单仍可在这里上架。"
        />
      ) : null}
      <Card className="list-card">
        <Table<Order>
          rowKey="id"
          columns={columns}
          dataSource={waiting}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          locale={{ emptyText: '没有待上架的入库单。先在入库单里收货。' }}
        />
      </Card>
    </div>
  );
}
