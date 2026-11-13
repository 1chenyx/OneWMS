import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Input, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useOrders, useProfileSnapshot, useTransitionOrder } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order } from '../api/client';
import PageHeader from '../components/PageHeader';
import { monoCell, TABLE_PAGINATION } from '../components/table-style';
import { useAppNav } from '../app-nav';
import { fmtQty } from '../lib/format';

/**
 * 质检、复核、打包、装车共用的清单。波次单独成页，用来把多张出库单收成一波。
 * 打开对应模块后，这一步在这里确认。单据页只负责跳过来。
 */
export default function StagePage({
  title,
  subtitle,
  offMessage,
  moduleId,
  direction,
  fromStates,
  to,
  action,
}: {
  title: string;
  subtitle: string;
  offMessage: string;
  moduleId: string;
  direction: 'in' | 'out';
  /** 根据模块开关计算本步骤的入口状态：只显示真正流到这一步的单 */
  fromStates: (modules: Record<string, { enabled?: boolean } | undefined>) => readonly string[];
  to: string;
  action: string;
}) {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const [orderNoFilter, setOrderNoFilter] = useState(() => takeInitialFilter()?.orderNo ?? '');
  const snapshot = useProfileSnapshot();
  const off = snapshot.data?.modules[moduleId]?.enabled === false;
  const { data: orders, isLoading } = useOrders(direction);
  const transition = useTransitionOrder();
  const keyword = orderNoFilter.trim().toLowerCase();

  const modules = snapshot.data?.modules ?? {};
  const states = fromStates(modules);
  const waiting = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).filter(
        (order) =>
          order.direction === direction &&
          states.includes(order.state) &&
          (keyword ? order.orderNo.toLowerCase().includes(keyword) : true),
      ),
    [orders, direction, states, keyword],
  );

  const confirm = async (orderNo: string) => {
    try {
      await transition.mutateAsync({ orderNo, to });
      message.success(`${orderNo} 已${action}`);
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : `操作失败：${String(error)}`);
    }
  };

  const columns: ColumnsType<Order> = [
    { title: '单号', dataIndex: 'orderNo', key: 'orderNo', onCell: monoCell },
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
      render: (_, order) =>
        off ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Button
            size="small"
            type="primary"
            loading={transition.isPending && transition.variables?.orderNo === order.orderNo}
            onClick={() => void confirm(order.orderNo)}
          >
            {action}
          </Button>
        ),
    },
  ];

  return (
    <div
      className="app-fill list-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title={title}
        subtitle={subtitle}
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
      {off ? <Alert type="info" showIcon message={offMessage} /> : null}
      <Card className="list-card">
        <Table<Order>
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={waiting}
          pagination={TABLE_PAGINATION}
        />
      </Card>
    </div>
  );
}

type Modules = Record<string, { enabled?: boolean } | undefined>;

const moduleOn = (modules: Modules, id: string): boolean => modules[id]?.enabled === true;

const RECEIVED = () => ['received'] as const;
/** 复核入口：拣货开着等拣完，否则波次，再否则刚创建的单直接复核 */
const REVIEW_FROM = (m: Modules) =>
  moduleOn(m, 'module.picking') ? ['picked']
  : moduleOn(m, 'module.wave') ? ['waved']
  : ['created'];
/** 打包入口：复核开着等复核完，否则拣货，再否则波次/创建 */
const PACK_FROM = (m: Modules) =>
  moduleOn(m, 'module.review') ? ['reviewed']
  : moduleOn(m, 'module.picking') ? ['picked']
  : moduleOn(m, 'module.wave') ? ['waved']
  : ['created'];
/** 装车入口：打包开着等打包完，否则复核/拣货，再否则波次/创建 */
const LOAD_FROM = (m: Modules) =>
  moduleOn(m, 'module.pack') ? ['packed']
  : moduleOn(m, 'module.review') ? ['reviewed']
  : moduleOn(m, 'module.picking') ? ['picked']
  : moduleOn(m, 'module.wave') ? ['waved']
  : ['created'];

export function QcPage() {
  return (
    <StagePage
      title="质检"
      subtitle="已收货的入库单在这里确认质检。质检后再上架或结束。"
      offMessage="质检已关闭。新的入库单收货后直接上架或结束。已经质检的单仍可继续。"
      moduleId="module.qc"
      direction="in"
      fromStates={RECEIVED}
      to="inspected"
      action="质检"
    />
  );
}

export function ReviewPage() {
  return (
    <StagePage
      title="复核"
      subtitle="拣完的出库单在这里复核。复核后再打包、装车或发货。"
      offMessage="复核已关闭。新的出库单跳过复核。已经复核的单仍可继续。"
      moduleId="module.review"
      direction="out"
      fromStates={REVIEW_FROM}
      to="reviewed"
      action="复核"
    />
  );
}

export function PackPage() {
  return (
    <StagePage
      title="打包"
      subtitle="复核之后的出库单在这里打包。打包后再装车或发货。"
      offMessage="打包已关闭。新的出库单跳过打包。已经打包的单仍可装车或发货。"
      moduleId="module.pack"
      direction="out"
      fromStates={PACK_FROM}
      to="packed"
      action="打包"
    />
  );
}

export function LoadPage() {
  return (
    <StagePage
      title="装车"
      subtitle="打包之后的出库单在这里装车。装车后再回出库单发货。"
      offMessage="装车已关闭。新的出库单跳过装车。已经装车的单仍可发货。"
      moduleId="module.load"
      direction="out"
      fromStates={LOAD_FROM}
      to="loaded"
      action="装车"
    />
  );
}
