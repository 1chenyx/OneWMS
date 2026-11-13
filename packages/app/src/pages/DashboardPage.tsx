import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ContainerOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FieldTimeOutlined,
  ImportOutlined,
  LockOutlined,
  PartitionOutlined,
  PieChartOutlined,
  ReconciliationOutlined,
  RestOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Card, Col, Empty, Row, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileSnapshot } from '@one/core';
import {
  useDashboardActivity,
  useDashboardAlerts,
  useDashboardFlowTrend,
  useDashboardLocations,
  useDashboardOrders,
  useDashboardOverview,
  useDashboardStock,
  useDashboardUrgent,
  useDashboardWorkload,
  useProfileSnapshot,
} from '../api/hooks';
import type {
  AlertSummary,
  DashboardActivityRow,
  DashboardHoldBrief,
  DashboardLowStock,
  DashboardSkuRank,
  DashboardUrgentRow,
  FlowTrendPoint,
  LocationDistribution,
  OrderStateCount,
} from '../api/client';
import PageHeader from '../components/PageHeader';
import { monoCell, numCell } from '../components/table-style';
import { useAppNav } from '../app-nav';
import type { Page } from '../app-nav';
import { face } from '../theme';

/**
 * 运营看板。内容分成四区，各区独立成块，查询仍按维度分开请求。
 * 库存 = 余量和库位；作业 = 未完成的单；进出 = 流量和流水；异常 = 低库存、临期、冻结。
 * 不引图表库：Antd 原生组件 + 自写 SVG 迷你趋势图。
 */
const BOARD_SECTIONS = [
  { id: 'board-stock', label: '库存' },
  { id: 'board-work', label: '作业' },
  { id: 'board-flow', label: '进出' },
  { id: 'board-watch', label: '异常' },
] as const;

export default function DashboardPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="运营看板"
        subtitle="分成库存、作业、进出、异常四块。格子和表格行可以点进对应页面"
      />
      <SectionNav />
      <BoardSection id="board-stock" kicker="01" title="库存" note="有多少货，堆在哪些库位" accent={face.ink}>
        <StockMetrics />
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <TopSkusCard />
          </Col>
          <Col xs={24} lg={12}>
            <LocationsView />
          </Col>
        </Row>
      </BoardSection>
      <BoardSection id="board-work" kicker="02" title="作业" note="还没做完的单。点格子进入那一页" accent={face.amberInk}>
        <WorkloadView />
      </BoardSection>
      <BoardSection id="board-flow" kicker="03" title="进出" note="上架移库不计入流量。流水里仍能看到移位" accent={face.good}>
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={14}>
            <FlowTrendView />
          </Col>
          <Col xs={24} xl={10}>
            <ActivityView />
          </Col>
        </Row>
      </BoardSection>
      <BoardSection id="board-watch" kicker="04" title="异常" note="低库存、临期和冻结。阈值在「系统 → 规则」" accent={face.bad}>
        <WatchMetrics />
        <NegativeStock />
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <LowStockCard />
          </Col>
          <Col xs={24} lg={12}>
            <UrgentView />
          </Col>
        </Row>
        <HoldsView />
      </BoardSection>
    </div>
  );
}

function SectionNav() {
  return (
    <nav
      aria-label="看板分区"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: '8px 0',
        background: face.paper,
      }}
    >
      {BOARD_SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-label={`跳到${section.label}`}
          onClick={() => document.getElementById(section.id)?.scrollIntoView({ block: 'start' })}
          style={chipStyle}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

function BoardSection({
  id,
  kicker,
  title,
  note,
  accent,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  note: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        background: face.raised,
        border: `1px solid ${face.line}`,
        borderTop: `3px solid ${accent}`,
        scrollMarginTop: 48,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <span style={{ fontFamily: face.mono, fontSize: 12, color: accent }}>{kicker}</span>
          <Typography.Title id={`${id}-title`} level={5} style={{ margin: 0, fontWeight: 500, color: face.ink }}>
            {title}
          </Typography.Title>
        </div>
        <Typography.Text style={{ fontSize: 12, color: face.text2 }}>{note}</Typography.Text>
      </header>
      {children}
    </section>
  );
}

interface MetricItem {
  title: string;
  value?: number;
  icon: ReactNode;
  tone?: string;
  loading: boolean;
}

function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
      {items.map((item) => (
        <Card key={item.title} size="small" loading={item.loading}>
          <Statistic
            title={item.title}
            value={item.value ?? 0}
            prefix={<span style={{ marginRight: 8, color: face.text3, fontSize: 16 }}>{item.icon}</span>}
            valueStyle={{ color: item.tone ?? face.ink }}
          />
        </Card>
      ))}
    </div>
  );
}

/** 库存区只放余量。在途、低库存、冻结不混在这里。 */
function StockMetrics() {
  const overview = useDashboardOverview();
  const stock = useDashboardStock();
  return (
    <MetricGrid
      items={[
        { title: 'SKU 数', value: overview.data?.skuCount, icon: <ExperimentOutlined />, loading: overview.isLoading },
        { title: '库存总量', value: overview.data?.totalQuantity, icon: <DatabaseOutlined />, loading: overview.isLoading },
        { title: '可用量', value: stock.data?.available, icon: <DatabaseOutlined />, loading: stock.isLoading },
        { title: '库位使用', value: overview.data?.locationUsedCount, icon: <PieChartOutlined />, loading: overview.isLoading },
        { title: '库位总数', value: overview.data?.locationCount, icon: <PieChartOutlined />, loading: overview.isLoading },
      ]}
    />
  );
}

/** 异常区的三个计数。明细在下面三张表里，这里不再重复列「正常」。 */
function WatchMetrics() {
  const overview = useDashboardOverview();
  const stock = useDashboardStock();
  return (
    <MetricGrid
      items={[
        {
          title: '低库存',
          value: stock.data?.lowStockCount,
          icon: <WarningOutlined />,
          tone: stock.data?.lowStockCount ? face.amberInk : undefined,
          loading: stock.isLoading,
        },
        {
          title: '临期批次（桶）',
          value: overview.data?.expiringSoonCount,
          icon: <FieldTimeOutlined />,
          tone: overview.data?.expiringSoonCount ? face.amberInk : undefined,
          loading: overview.isLoading,
        },
        {
          title: '活动冻结',
          value: overview.data?.activeHoldCount,
          icon: <LockOutlined />,
          tone: overview.data?.activeHoldCount ? face.bad : undefined,
          loading: overview.isLoading,
        },
      ]}
    />
  );
}

/** ② 流量趋势：自写 SVG 双向柱状图（入库↑ / 出库↓，缺日为零） */
function FlowTrendView() {
  const [days, setDays] = useState(14);
  const { data, isLoading } = useDashboardFlowTrend(days);
  const points = data ?? [];
  const empty = points.every((point) => point.inbound === 0 && point.outbound === 0);
  const max = Math.max(...points.map((point) => Math.max(point.inbound, point.outbound)), 1);
  const H = 220;
  return (
    <Card
      title={`近 ${days} 天出入库流量`}
      loading={isLoading}
      extra={
        <Space>
          <Tag icon={<ArrowUpOutlined />} style={{ color: face.good, background: '#eef6f0', borderColor: 'transparent' }}>
            入库 {points.reduce((sum, point) => sum + point.inbound, 0)}
          </Tag>
          <Tag icon={<ArrowDownOutlined />} style={{ color: face.text2, background: face.raised, borderColor: 'transparent' }}>
            出库 {points.reduce((sum, point) => sum + point.outbound, 0)}
          </Tag>
          <Segmented<number>
            size="small"
            value={days}
            onChange={setDays}
            options={[
              { label: '7 天', value: 7 },
              { label: '14 天', value: 14 },
              { label: '30 天', value: 30 },
            ]}
          />
        </Space>
      }
    >
      {empty ? (
        <Empty description="这段时间没有出入库流水（上架移库不计入流量）" />
      ) : (
        <FlowChart points={points} max={max} half={H / 2} H={H} />
      )}
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
        {points.map((point, index) => {
          const cx = index * 36 + 18;
          const inH = Math.round((point.inbound / max) * (half - 12));
          const outH = Math.round((point.outbound / max) * (half - 12));
          return (
            <g key={point.day}>
              <title>{`${point.day}：入 ${point.inbound} / 出 ${point.outbound}`}</title>
              {inH > 0 ? <rect x={cx - barW - 1} y={half - inH} width={barW} height={inH} rx={2} fill={face.ink} /> : null}
              {outH > 0 ? <rect x={cx + 1} y={half} width={barW} height={outH} rx={2} fill="#a3a3a3" /> : null}
              <text x={cx} y={H + 20} textAnchor="middle" fontSize={12} fill={face.text3} fontFamily={face.mono}>
                {point.day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 负余量没有别的表。没有异常时不占一块「全部正常」。 */
function NegativeStock() {
  const { data, isLoading } = useDashboardAlerts();
  if (isLoading || !data || data.negativeBuckets.length === 0) return null;
  return (
    <Card size="small" title="负余量">
      <NegativeBuckets alert={data} />
    </Card>
  );
}

function NegativeBuckets({ alert }: { alert: AlertSummary }) {
  return (
    <Table
      rowKey={(row) => `${row.skuCode}:${row.locationCode}:${row.batchNo}`}
      size="small"
      pagination={false}
      dataSource={alert.negativeBuckets}
      columns={[
        { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell },
        { title: '库位', dataIndex: 'locationCode', onCell: monoCell },
        { title: '批次', dataIndex: 'batchNo', onCell: monoCell },
        {
          title: '余量',
          dataIndex: 'quantity',
          align: 'right',
          onCell: numCell,
          render: (value: number) => <Typography.Text type="danger">{value}</Typography.Text>,
        },
      ]}
    />
  );
}

/** ④ 作业积压：未结束的单据。波次、拣货只在模块开着，或还有遗留单时占格子。 */
function WorkloadView() {
  const { navigate } = useAppNav();
  const workload = useDashboardWorkload();
  const orders = useDashboardOrders();
  const snapshot = useProfileSnapshot();
  const data = workload.data;
  const modules = snapshot.data?.modules;
  const tiles: { key: string; label: string; value: number; hint: string; page: Page; icon: ReactNode }[] = [
    { key: 'in', label: '在途入库', value: data?.inboundOpen ?? 0, hint: '去入库单', page: 'inbound', icon: <ImportOutlined /> },
    { key: 'out', label: '在途出库', value: data?.outboundOpen ?? 0, hint: '去出库单', page: 'outbound', icon: <ExportOutlined /> },
  ];
  if (showQueue(modules, 'module.wave', data?.waveOpen ?? 0)) {
    tiles.push({ key: 'wave', label: '待拣波次', value: data?.waveOpen ?? 0, hint: '去波次', page: 'wave', icon: <PartitionOutlined /> });
  }
  if (showQueue(modules, 'module.picking', data?.pickingOpen ?? 0)) {
    tiles.push({ key: 'pick', label: '拣货中', value: data?.pickingOpen ?? 0, hint: '去拣货单', page: 'pickings', icon: <ContainerOutlined /> });
  }
  tiles.push(
    { key: 'stocktake', label: '盘点中', value: data?.stocktakeOpen ?? 0, hint: '去盘点', page: 'stocktakes', icon: <ReconciliationOutlined /> },
    {
      key: 'transfer',
      label: '调拨未完成',
      value: data?.transferOpen ?? 0,
      hint: data?.transferInTransit ? `其中在途 ${data.transferInTransit}` : '去调拨单',
      page: 'transfers',
      icon: <SwapOutlined />,
    },
    { key: 'scrap', label: '待确认报损', value: data?.scrapOpen ?? 0, hint: '去报损单', page: 'scraps', icon: <RestOutlined /> },
  );
  return (
    <Card loading={workload.isLoading || orders.isLoading}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 8 }}>
        {tiles.map((tile) => (
          <QueueTile key={tile.key} tile={tile} onPick={navigate} />
        ))}
      </div>
      <OrderPipeline rows={orders.data ?? []} snapshot={snapshot.data} onPick={navigate} />
    </Card>
  );
}

function showQueue(
  modules: ProfileSnapshot['modules'] | undefined,
  moduleId: string,
  count: number,
): boolean {
  if (count > 0) return true;
  return modules?.[moduleId]?.enabled === true;
}

function QueueTile({
  tile,
  onPick,
}: {
  tile: { label: string; value: number; hint: string; page: Page; icon: ReactNode };
  onPick: (page: Page) => void;
}) {
  const hot = tile.value > 0;
  return (
    <button
      type="button"
      onClick={() => onPick(tile.page)}
      aria-label={`${tile.label} ${tile.value}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        padding: '10px 12px',
        border: `1px solid ${hot ? face.amber : face.line}`,
        borderRadius: 8,
        background: hot ? face.amberWash : face.card,
        color: face.ink,
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 12, color: face.text2 }}>
        <span style={{ marginRight: 6 }}>{tile.icon}</span>
        {tile.label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 500, lineHeight: '28px' }}>{tile.value}</span>
      <span style={{ fontSize: 12, color: face.text3 }}>{tile.hint}</span>
    </button>
  );
}

/** 单据还停在哪一步。已完成、已取消只作合计，不占格子。 */
function OrderPipeline({
  rows,
  snapshot,
  onPick,
}: {
  rows: readonly OrderStateCount[];
  snapshot: ProfileSnapshot | undefined;
  onPick: (page: Page) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
      {(['in', 'out'] as const).map((direction) => {
        const mine = rows.filter((row) => row.direction === direction);
        const open = mine.filter((row) => row.state !== 'done' && row.state !== 'canceled');
        const done = mine.find((row) => row.state === 'done')?.count ?? 0;
        const canceled = mine.find((row) => row.state === 'canceled')?.count ?? 0;
        const page: Page = direction === 'in' ? 'inbound' : 'outbound';
        return (
          <div key={direction} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Typography.Text style={{ width: 36, color: face.text2 }}>{direction === 'in' ? '入库' : '出库'}</Typography.Text>
            {open.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                没有停在中间状态的单据
              </Typography.Text>
            ) : (
              open.map((row) => (
                <button
                  key={row.state}
                  type="button"
                  onClick={() => onPick(page)}
                  style={chipStyle}
                >
                  {stateLabel(snapshot, row.state, direction)} {row.count}
                </button>
              ))
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已完成 {done} · 已取消 {canceled}
            </Typography.Text>
          </div>
        );
      })}
    </div>
  );
}

const chipStyle: CSSProperties = {
  border: `1px solid ${face.line}`,
  borderRadius: 6,
  background: face.raised,
  color: face.ink,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
};

/** 余量最高的 SKU。低库存放在异常区，不和「货多」放在一起。 */
function TopSkusCard() {
  const { navigate } = useAppNav();
  const { data, isLoading } = useDashboardStock();
  return (
    <Card title="库存最多的 SKU" loading={isLoading} extra={<Typography.Text type="secondary">最多 8 个</Typography.Text>}>
      {(data?.topSkus.length ?? 0) === 0 ? (
        <Empty description="还没有库存" />
      ) : (
        <Table<DashboardSkuRank>
          rowKey="skuCode"
          size="small"
          pagination={false}
          dataSource={data?.topSkus}
          onRow={(row) => ({ onClick: () => navigate('inventory', { skuCode: row.skuCode }), style: { cursor: 'pointer' } })}
          columns={skuRankColumns}
        />
      )}
    </Card>
  );
}

function LowStockCard() {
  const { navigate } = useAppNav();
  const { data, isLoading } = useDashboardStock();
  return (
    <Card
      title={`低库存${data ? `（${data.lowStockCount}）` : ''}`}
      loading={isLoading}
      extra={<Typography.Text type="secondary">可用量低于安全库存</Typography.Text>}
    >
      {(data?.lowStock.length ?? 0) === 0 ? (
        <Empty description="没有低于安全库存的在用 SKU" />
      ) : (
        <Table<DashboardLowStock>
          rowKey="skuCode"
          size="small"
          pagination={false}
          dataSource={data?.lowStock}
          onRow={(row) => ({ onClick: () => navigate('inventory', { skuCode: row.skuCode }), style: { cursor: 'pointer' } })}
          columns={lowStockColumns}
        />
      )}
    </Card>
  );
}

const skuRankColumns: ColumnsType<DashboardSkuRank> = [
  { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 120 },
  { title: '名称', dataIndex: 'name', ellipsis: true },
  { title: '余量', dataIndex: 'quantity', align: 'right', width: 88, onCell: numCell, render: qtyWithUnit },
  { title: '可用', dataIndex: 'available', align: 'right', width: 88, onCell: numCell },
];

const lowStockColumns: ColumnsType<DashboardLowStock> = [
  { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 120 },
  { title: '名称', dataIndex: 'name', ellipsis: true },
  { title: '可用', dataIndex: 'available', align: 'right', width: 72, onCell: numCell },
  { title: '安全库存', dataIndex: 'reorderPoint', align: 'right', width: 88, onCell: numCell },
  {
    title: '缺口',
    dataIndex: 'shortage',
    align: 'right',
    width: 72,
    onCell: numCell,
    render: (value: number) => <Typography.Text style={{ color: face.amberInk }}>{value}</Typography.Text>,
  },
];

function qtyWithUnit(value: number, row: { unit: string | null }): string {
  return row.unit ? `${value} ${row.unit}` : String(value);
}

/** ⑥ 临期与过期。安全、未登记不占这里，完整清单在效期看板。 */
function UrgentView() {
  const { navigate } = useAppNav();
  const { data, isLoading } = useDashboardUrgent();
  const rows = data ?? [];
  const columns: ColumnsType<DashboardUrgentRow> = [
    { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 110 },
    { title: '批次', dataIndex: 'batchNo', onCell: monoCell, width: 110 },
    {
      title: '剩余',
      dataIndex: 'daysLeft',
      width: 110,
      render: (value: number) => daysLeftText(value),
    },
    {
      title: '层',
      dataIndex: 'level',
      width: 72,
      render: (level: DashboardUrgentRow['level']) => <Tag color={level === 'expired' ? 'red' : level === 'critical' ? 'orange' : 'gold'}>{levelLabel(level)}</Tag>,
    },
    { title: '余量', dataIndex: 'quantity', align: 'right', width: 80, onCell: numCell, render: qtyWithUnit },
  ];
  return (
    <Card
      title="临期批次"
      loading={isLoading}
      extra={
        <Typography.Link onClick={() => navigate('expiry')}>效期看板</Typography.Link>
      }
    >
      {rows.length === 0 ? (
        <Empty description="没有临期或过期批次" />
      ) : (
        <Table<DashboardUrgentRow>
          rowKey={(row) => `${row.skuCode}:${row.batchNo}`}
          size="small"
          pagination={false}
          dataSource={rows}
          columns={columns}
          onRow={(row) => ({ onClick: () => navigate('expiry', { skuCode: row.skuCode }), style: { cursor: 'pointer' } })}
        />
      )}
    </Card>
  );
}

function levelLabel(level: DashboardUrgentRow['level']): string {
  if (level === 'expired') return '已过期';
  if (level === 'critical') return '紧急';
  return '预警';
}

function daysLeftText(value: number): ReactNode {
  if (value < 0) return <Typography.Text type="danger">已过期 {-value} 天</Typography.Text>;
  if (value === 0) return <Typography.Text type="warning">今天到期</Typography.Text>;
  return <span>{value} 天</span>;
}

/** ⑦ 最近流水。上架移库也列出，方便对上刚刚发生的移位。 */
function ActivityView() {
  const { navigate } = useAppNav();
  const { data, isLoading } = useDashboardActivity(12);
  const rows = data ?? [];
  const columns: ColumnsType<DashboardActivityRow> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 132,
      onCell: monoCell,
      render: (value: string) => value.replace('T', ' ').slice(0, 16),
    },
    { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 100 },
    { title: '库位', dataIndex: 'locationCode', onCell: monoCell, width: 90 },
    {
      title: '数量',
      dataIndex: 'delta',
      align: 'right',
      width: 72,
      onCell: numCell,
      render: (value: number) => (
        <Typography.Text style={{ color: value > 0 ? face.good : value < 0 ? face.bad : face.text3 }}>
          {value > 0 ? `+${value}` : value}
        </Typography.Text>
      ),
    },
    { title: '原因', dataIndex: 'reason', ellipsis: true, render: (value: string) => reasonLabel(value) },
  ];
  return (
    <Card title="最近流水" loading={isLoading} extra={<Typography.Text type="secondary">最新 12 笔</Typography.Text>}>
      {rows.length === 0 ? (
        <Empty description="还没有库存流水" />
      ) : (
        <Table<DashboardActivityRow>
          rowKey="eventId"
          size="small"
          pagination={false}
          dataSource={rows}
          columns={columns}
          onRow={(row) => ({ onClick: () => navigate('inventory', { skuCode: row.skuCode }), style: { cursor: 'pointer' } })}
        />
      )}
    </Card>
  );
}

function reasonLabel(reason: string): string {
  const known: Record<string, string> = {
    inbound: '入库调整',
    outbound: '出库调整',
    transfer: '移库',
    hold: '冻结',
  };
  if (known[reason]) return known[reason];
  const [head, rest] = reason.split(':');
  const heads: Record<string, string> = {
    putaway: '上架',
    stocktake: '盘点',
    picking: '拣货',
    transfer: '调拨',
    scrap: '报损',
  };
  if (head === 'order') {
    const states: Record<string, string> = {
      received: '收货',
      shipped: '发货',
      done: '完成',
      picking: '拣货',
      putaway: '上架',
    };
    return states[rest ?? ''] ?? (rest ? `单据 ${rest}` : '单据');
  }
  const label = heads[head ?? ''];
  if (!label) return reason;
  return rest ? `${label} ${rest}` : label;
}

/** ⑧ 库位分布：横向条形（Top 8 + 其他归并——服务端已做） */
function LocationsView() {
  const { data, isLoading } = useDashboardLocations();
  const rows = data ?? [];
  const max = Math.max(...rows.map((row) => row.quantity), 1);
  const columns: ColumnsType<LocationDistribution> = [
    { title: '库位', dataIndex: 'locationCode', onCell: monoCell, width: 160 },
    { title: '库存量', dataIndex: 'quantity', align: 'right', width: 90, onCell: numCell },
    {
      title: '占比',
      key: 'bar',
      render: (_, row) => (
        <div style={{ background: face.line, borderRadius: 4, height: 8, width: '100%' }}>
          <div
            style={{
              background: face.ink,
              borderRadius: 4,
              height: '100%',
              width: `${Math.max(2, Math.round((row.quantity / max) * 100))}%`,
            }}
          />
        </div>
      ),
    },
  ];
  return (
    <Card title="库位库存分布" loading={isLoading} extra={<Typography.Text type="secondary">Top 8 + 其他</Typography.Text>}>
      {rows.length === 0 ? (
        <Empty description="还没有库存" />
      ) : (
        <Table<LocationDistribution> rowKey="locationCode" size="small" columns={columns} dataSource={rows} pagination={false} />
      )}
    </Card>
  );
}

/** ⑨ 活动冻结清单。释放之后的历史不在这里。 */
function HoldsView() {
  const { navigate } = useAppNav();
  const { data, isLoading } = useDashboardStock();
  const rows = data?.holds ?? [];
  const columns: ColumnsType<DashboardHoldBrief> = [
    { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 120 },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '数量', dataIndex: 'quantity', align: 'right', width: 80, onCell: numCell },
    { title: '原因', dataIndex: 'reason', ellipsis: true },
  ];
  return (
    <Card title="冻结明细" loading={isLoading} extra={<Typography.Text type="secondary">按数量，最多 8 笔</Typography.Text>}>
      {rows.length === 0 ? (
        <Empty description="没有活动冻结" />
      ) : (
        <Table<DashboardHoldBrief>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          columns={columns}
          onRow={(row) => ({ onClick: () => navigate('inventory', { skuCode: row.skuCode }), style: { cursor: 'pointer' } })}
        />
      )}
    </Card>
  );
}

/** 状态标签：从流程配置查 label（与单据页同源） */
function stateLabel(snapshot: ProfileSnapshot | undefined, state: string, direction: 'in' | 'out'): string {
  const workflow = snapshot?.workflows[direction === 'in' ? 'inbound' : 'outbound'];
  return workflow?.states.find((item) => item.id === state)?.label ?? state;
}
