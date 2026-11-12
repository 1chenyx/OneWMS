import { useState } from 'react';
import {
  AlertOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  ContainerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  LockOutlined,
  OrderedListOutlined,
  PieChartOutlined,
  RiseOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Card, Col, Empty, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileSnapshot } from '@one/core';
import {
  useDashboardAlerts,
  useDashboardFlowTrend,
  useDashboardLocations,
  useDashboardOrders,
  useDashboardOverview,
  useProfileSnapshot,
} from '../api/hooks';
import type { AlertSummary, FlowTrendPoint, LocationDistribution, OrderStateCount } from '../api/client';
import PageHeader from '../components/PageHeader';
import { monoCell, numCell, TABLE_PAGINATION } from '../components/table-style';
import { face } from '../theme';

/**
 * 运营看板页（M21）——五维度 Segmented 切换，各自独立查询/端点/queryKey：
 * 新增维度 = 加一个 view 组件 + 一个 hook + 一个端点，不动既有维度。
 * 不引图表库：Antd 原生组件 + 自写 SVG 迷你趋势图（纯函数渲染，零状态）。
 */
type Dim = 'overview' | 'flow' | 'locations' | 'orders' | 'alerts';

export default function DashboardPage() {
  const [dim, setDim] = useState<Dim>('overview');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="运营看板"
        subtitle="仓库运营总览：总览 / 流量趋势 / 库位分布 / 单据统计 / 预警——维度各自独立加载"
        extra={
          <Segmented<Dim>
            value={dim}
            onChange={setDim}
            options={[
              { value: 'overview', label: '总览', icon: <DashboardOutlined /> },
              { value: 'flow', label: '流量趋势', icon: <RiseOutlined /> },
              { value: 'locations', label: '库位分布', icon: <PieChartOutlined /> },
              { value: 'orders', label: '单据统计', icon: <OrderedListOutlined /> },
              { value: 'alerts', label: '预警', icon: <AlertOutlined /> },
            ]}
          />
        }
      />
      {dim === 'overview' ? <OverviewView /> : null}
      {dim === 'flow' ? <FlowTrendView /> : null}
      {dim === 'locations' ? <LocationsView /> : null}
      {dim === 'orders' ? <OrdersView /> : null}
      {dim === 'alerts' ? <AlertsView /> : null}
    </div>
  );
}

/** ① 总览：数字卡片（2×4 栅格） */
function OverviewView() {
  const { data, isLoading } = useDashboardOverview();
  const cards: { title: string; value?: number; icon: React.ReactNode; tone?: string }[] = [
    { title: 'SKU 数', value: data?.skuCount, icon: <ExperimentOutlined /> },
    { title: '库存总量', value: data?.totalQuantity, icon: <DatabaseOutlined /> },
    { title: '在途单据', value: data?.openOrderCount, icon: <OrderedListOutlined /> },
    { title: '进行中拣货单', value: data?.openPickingCount, icon: <ContainerOutlined /> },
    { title: '库位使用', value: data?.locationUsedCount, icon: <PieChartOutlined /> },
    { title: '临期批次（桶）', value: data?.expiringSoonCount, icon: <FieldTimeOutlined />, tone: data?.expiringSoonCount ? face.amberInk : undefined },
    { title: '活动冻结', value: data?.activeHoldCount, icon: <LockOutlined />, tone: data?.activeHoldCount ? face.bad : undefined },
    { title: '库位总数', value: data?.locationCount, icon: <PieChartOutlined /> },
  ];
  return (
    <Row gutter={[16, 16]}>
      {cards.map((c) => (
        <Col xs={12} sm={12} md={6} key={c.title}>
          <Card loading={isLoading}>
            <Statistic
              title={c.title}
              value={c.value ?? 0}
              prefix={<span style={{ marginRight: 8, color: face.text3, fontSize: 16 }}>{c.icon}</span>}
              valueStyle={{ color: c.tone ?? face.ink }}
            />
          </Card>
        </Col>
      ))}
    </Row>
  );
}

/** ② 流量趋势：自写 SVG 双向柱状图（入库↑ / 出库↓，缺日为零） */
function FlowTrendView() {
  const [days] = useState(14);
  const { data, isLoading } = useDashboardFlowTrend(days);
  if (isLoading) return <Card loading />;
  const points = data ?? [];
  if (points.every((p) => p.inbound === 0 && p.outbound === 0)) {
    return (
      <Card>
        <Empty description="近 14 天没有出入库流水（上架移库不计入流量）" />
      </Card>
    );
  }
  const max = Math.max(...points.map((p) => Math.max(p.inbound, p.outbound)), 1);
  const H = 280;
  const half = H / 2;
  return (
    <Card
      title={`近 ${days} 天出入库流量`}
      extra={
        <Space>
          <Tag icon={<ArrowUpOutlined />} style={{ color: face.good, background: '#eef6f0', borderColor: 'transparent' }}>
            入库 {points.reduce((s, p) => s + p.inbound, 0)}
          </Tag>
          <Tag icon={<ArrowDownOutlined />} style={{ color: face.text2, background: face.raised, borderColor: 'transparent' }}>
            出库 {points.reduce((s, p) => s + p.outbound, 0)}
          </Tag>
        </Space>
      }
    >
      <FlowChart points={points} max={max} half={half} H={H} />
    </Card>
  );
}

/** SVG 趋势图：中轴线上半入库（墨色）、下半出库（中性灰）；hover 有 tooltip */
function FlowChart({ points, max, half, H }: { points: FlowTrendPoint[]; max: number; half: number; H: number }) {
  const W = Math.max(points.length * 36, 360);
  const barW = 10;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H + 28} role="img" aria-label="出入库流量趋势图">
        <line x1={0} y1={half} x2={W} y2={half} stroke={face.lineStrong} strokeWidth={1} />
        {points.map((p, i) => {
          const cx = i * 36 + 18;
          const inH = Math.round((p.inbound / max) * (half - 12));
          const outH = Math.round((p.outbound / max) * (half - 12));
          return (
            <g key={p.day}>
              <title>{`${p.day}：入 ${p.inbound} / 出 ${p.outbound}`}</title>
              {inH > 0 ? <rect x={cx - barW - 1} y={half - inH} width={barW} height={inH} rx={2} fill={face.ink} /> : null}
              {outH > 0 ? <rect x={cx + 1} y={half} width={barW} height={outH} rx={2} fill="#a3a3a3" /> : null}
              <text x={cx} y={H + 20} textAnchor="middle" fontSize={12} fill={face.text3} fontFamily={face.mono}>
                {p.day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** ③ 库位分布：横向条形（Antd 原生；Top 8 + 其他归并——服务端已做） */
function LocationsView() {
  const { data, isLoading } = useDashboardLocations();
  const rows = data ?? [];
  const max = Math.max(...rows.map((r) => r.quantity), 1);
  const columns: ColumnsType<LocationDistribution> = [
    { title: '库位', dataIndex: 'locationCode', onCell: monoCell, width: 180 },
    {
      title: '库存量',
      dataIndex: 'quantity',
      align: 'right',
      width: 100,
      onCell: numCell,
      sorter: (a, b) => a.quantity - b.quantity,
    },
    {
      title: '占比',
      key: 'bar',
      render: (_, r) => (
        <div style={{ background: face.line, borderRadius: 4, height: 8, width: '100%' }}>
          <div
            style={{
              background: face.ink,
              borderRadius: 4,
              height: '100%',
              width: `${Math.max(2, Math.round((r.quantity / max) * 100))}%`,
            }}
          />
        </div>
      ),
    },
  ];
  return (
    <Card title="库位库存分布（Top 8 + 其他）" loading={isLoading}>
      {rows.length === 0 ? (
        <Empty description="还没有库存" />
      ) : (
        <Table<LocationDistribution> rowKey="locationCode" size="small" columns={columns} dataSource={rows} pagination={TABLE_PAGINATION} />
      )}
    </Card>
  );
}

/** ④ 单据统计：方向 × 状态计数（状态标签按流程配置渲染） */
function OrdersView() {
  const { data, isLoading } = useDashboardOrders();
  const snapshot = useProfileSnapshot();
  const rows = data ?? [];
  const columns: ColumnsType<OrderStateCount> = [
    {
      title: '方向',
      dataIndex: 'direction',
      width: 90,
      filters: [
        { text: '入库', value: 'in' },
        { text: '出库', value: 'out' },
      ],
      onFilter: (v, r) => r.direction === v,
      render: (v: 'in' | 'out') => (v === 'in' ? <Tag color="green">入库</Tag> : <Tag color="red">出库</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'state',
      render: (v: string, r) => {
        const label = stateLabel(snapshot.data, v, r.direction);
        return <Tag color={v === 'done' ? 'green' : v === 'canceled' ? 'default' : 'processing'}>{label}</Tag>;
      },
    },
    {
      title: '单数',
      dataIndex: 'count',
      align: 'right',
      width: 100,
      onCell: numCell,
      sorter: (a, b) => a.count - b.count,
    },
  ];
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <Card
      title={`单据状态分布（共 ${total} 张）`}
      loading={isLoading}
      extra={
        <Space>
          <Tag color="green">入库 {rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.count, 0)}</Tag>
          <Tag color="red">出库 {rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.count, 0)}</Tag>
        </Space>
      }
    >
      {rows.length === 0 ? (
        <Empty description="还没有单据" />
      ) : (
        <Table<OrderStateCount> rowKey={(r) => `${r.direction}:${r.state}`} size="small" columns={columns} dataSource={rows} pagination={TABLE_PAGINATION} />
      )}
    </Card>
  );
}

/** ⑤ 预警：效期分级 / 冻结 / 负余量（防御） */
function AlertsView() {
  const { data, isLoading } = useDashboardAlerts();
  if (isLoading) return <Card loading />;
  const d: AlertSummary | undefined = data;
  const items: { severity: 'error' | 'warning' | 'info'; text: string; count: number }[] = [
    { severity: 'error', text: '已过期批次（桶，仍有库存）', count: d?.expiredCount ?? 0 },
    { severity: 'warning', text: '临期批次（桶，紧急阈值内）', count: d?.criticalCount ?? 0 },
    { severity: 'warning', text: '关注批次（桶，预警阈值内）', count: d?.warningCount ?? 0 },
    { severity: 'warning', text: '活动冻结（SKU 冻结中）', count: d?.holdCount ?? 0 },
    { severity: 'error', text: '负余量桶（数据异常，需介入）', count: d?.negativeCount ?? 0 },
  ];
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      {items.map((it) => (
        <Alert
          key={it.text}
          type={it.count > 0 ? it.severity : 'success'}
          showIcon
          icon={it.count > 0 ? <WarningOutlined /> : undefined}
          message={
            <span>
              {it.text}：
              {it.count > 0 ? (
                <Typography.Text strong style={{ marginLeft: 8, color: it.severity === 'error' ? '#cf1322' : '#d46b08' }}>
                  {it.count}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  0（正常）
                </Typography.Text>
              )}
            </span>
          }
        />
      ))}
      {d && d.negativeBuckets.length > 0 ? (
        <Card size="small" title="负余量桶明细（理论上不可能——请检查数据）">
          <Table
            rowKey={(r) => `${r.skuCode}:${r.locationCode}:${r.batchNo}`}
            size="small"
            pagination={TABLE_PAGINATION}
            dataSource={d.negativeBuckets}
            columns={[
              { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell },
              { title: '库位', dataIndex: 'locationCode', onCell: monoCell },
              { title: '批次', dataIndex: 'batchNo', onCell: monoCell },
              { title: '余量', dataIndex: 'quantity', align: 'right', onCell: numCell, render: (v: number) => <Typography.Text type="danger">{v}</Typography.Text> },
            ]}
          />
        </Card>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <Tooltip title="效期阈值在「管理 → 系统设置」中配置（紧急/预警天数）">
          阈值说明
        </Tooltip>
        ：紧急/预警天数由 WMS 设置（expiryCriticalDays / expiryWarningDays）决定；冻结与效期看板页可查明细。
      </Typography.Text>
    </Space>
  );
}

/** 状态标签：从流程配置查 label（与 OrdersPage 同源逻辑） */
function stateLabel(snapshot: ProfileSnapshot | undefined, state: string, direction: 'in' | 'out'): string {
  const wf = snapshot?.workflows[direction === 'in' ? 'inbound' : 'outbound'];
  return wf?.states.find((s) => s.id === state)?.label ?? state;
}
