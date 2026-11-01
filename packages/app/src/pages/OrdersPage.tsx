import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Input, Popconfirm, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileSnapshot } from '@one/core';
import { useOrders, useProfileSnapshot, useTransitionOrder } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order } from '../api/client';
import OrderFormModal from '../components/OrderFormModal';
import { useAppNav } from '../app-nav';

/**
 * 单据管理页——流转按钮由 Profile workflows 驱动（UI 消费配置面）：
 * 候选目标状态 = workflows[inbound|outbound].transitions.filter(from === 当前态)。
 * 行为权威仍是服务端状态机：非法转移被 400 WMS_INVALID_TRANSITION 兜底。
 * AI 跳转携带的 orderNo 预填过滤框（M12 步骤4，挂载时一次性消费）。
 */
export default function OrdersPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all');
  const { data: orders, isLoading } = useOrders(direction === 'all' ? undefined : direction);
  const snapshot = useProfileSnapshot();
  const transition = useTransitionOrder();
  const [formOpen, setFormOpen] = useState(false);
  const [orderNoFilter, setOrderNoFilter] = useState(() => takeInitialFilter()?.orderNo ?? '');

  const noKw = orderNoFilter.trim().toLowerCase();
  const visibleOrders = noKw
    ? (orders ?? []).filter((o) => o.orderNo.toLowerCase().includes(noKw))
    : (orders ?? []);

  const doTransition = async (orderNo: string, to: string) => {
    try {
      await transition.mutateAsync({ orderNo, to });
      message.success(`${orderNo} → ${stateLabel(snapshot.data, to)}`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<Order> = [
    { title: '单号', dataIndex: 'orderNo', key: 'orderNo' },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      filters: [
        { text: '入库', value: 'in' },
        { text: '出库', value: 'out' },
      ],
      onFilter: (v, r) => r.direction === v,
      render: (v: Order['direction']) =>
        v === 'in' ? <Tag color="blue">入库</Tag> : <Tag color="orange">出库</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (v: string, r) => {
        const label = stateLabel(snapshot.data, v, r.direction);
        return <Tag color={v === 'done' ? 'green' : v === 'canceled' ? 'default' : 'processing'}>{label}</Tag>;
      },
    },
    {
      title: '明细',
      key: 'lines',
      render: (_, r) => (
        <Typography.Text type="secondary">
          {r.lines.map((l) => `${l.skuCode}×${l.quantity}`).join('；')}
        </Typography.Text>
      ),
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      title: '流转',
      key: 'actions',
      render: (_, r) => {
        const nexts = nextStates(snapshot.data, r.direction, r.state);
        if (nexts.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space size="small" wrap>
            {nexts.map((to) => (
              <Popconfirm
                key={to}
                title={`确认流转到「${stateLabel(snapshot.data, to, r.direction)}」？`}
                onConfirm={() => doTransition(r.orderNo, to)}
              >
                <Button size="small" loading={transition.isPending && transition.variables?.orderNo === r.orderNo}>
                  {stateLabel(snapshot.data, to, r.direction)}
                </Button>
              </Popconfirm>
            ))}
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      title="出入库单"
      extra={
        <Space>
          <Segmented
            value={direction}
            onChange={(v) => setDirection(v as 'all' | 'in' | 'out')}
            options={[
              { value: 'all', label: '全部' },
              { value: 'in', label: '入库' },
              { value: 'out', label: '出库' },
            ]}
          />
          <Input
            allowClear
            placeholder="按单号过滤"
            value={orderNoFilter}
            onChange={(e) => setOrderNoFilter(e.target.value)}
            style={{ width: 180 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
            新建单据
          </Button>
        </Space>
      }
    >
      <Table<Order>
        rowKey="id"
        columns={columns}
        dataSource={visibleOrders}
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: '还没有单据' }}
      />
      <OrderFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </Card>
  );
}

/** 方向 → workflow id（Profile 种子约定） */
const WORKFLOW_BY_DIRECTION = { in: 'inbound', out: 'outbound' } as const;

/** 状态中文标签：优先读 Profile workflows 的 states（配置驱动），缺失时退回原文 */
function stateLabel(snapshot: ProfileSnapshot | undefined, state: string, direction?: Order['direction']): string {
  if (snapshot && direction) {
    const wf = snapshot.workflows[WORKFLOW_BY_DIRECTION[direction]];
    const hit = wf?.states.find((s) => s.id === state);
    if (hit) return hit.label;
  }
  // 方向未知（如目标态提示）：两个 workflow 都找一遍
  for (const wf of Object.values(snapshot?.workflows ?? {})) {
    const hit = wf.states.find((s) => s.id === state);
    if (hit) return hit.label;
  }
  return state;
}

/** 候选目标状态（去重）：workflows 的 transitions 里 from === 当前态的 to */
function nextStates(snapshot: ProfileSnapshot | undefined, direction: Order['direction'], state: string): string[] {
  const wf = snapshot?.workflows[WORKFLOW_BY_DIRECTION[direction]];
  if (!wf) return [];
  return [...new Set(wf.transitions.filter((t) => t.from === state).map((t) => t.to))];
}
