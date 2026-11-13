import { useState } from 'react';
import { App as AntApp, Button, Card, Input, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useExpiryBoard } from '../api/hooks';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';
import { fmtQty } from '../lib/format';
import { downloadXlsx, xlsxName } from '../lib/sheet';
import { downloadCsv, fileStamp, toCsv } from '../lib/csv';
import type { ExpiryBatchRow, ExpiryLevel } from '../api/client';

/**
 * 效期看板（M14：临期分层预警；M15：库位明细下钻 + 阈值可配）。
 * 数据全由后端算好（GET /api/inventory/expiry：SKU×批次聚合 + daysLeft/level
 * 分级 + 效期升序 + 库位×余量明细）；本页只做四件事：分层统计卡、着色表格、
 * 层/关键词过滤、行展开看库位分布。分层语义与 M13 拦截同界：今天到期 =
 * 临期（critical），未过期；< 今天才 expired。阈值天数由 core.wms settings
 * 控制（expiryCriticalDays / expiryWarningDays，慢通道改值即生效）——统计卡
 * 副标题按缺省 7/30 展示语义边界。
 * AI 跳转携带的 skuCode 预填关键词框（M15，挂载时一次性消费）。
 */

/** 分层展示元数据：统计卡标题 / Tag 语义色（与统计卡 valueStyle 同源） */
const LEVEL_META: Record<ExpiryLevel, { label: string; color: string }> = {
  expired: { label: '已过期', color: 'red' },
  critical: { label: '紧急', color: 'volcano' },
  warning: { label: '预警', color: 'gold' },
  safe: { label: '安全', color: 'green' },
  unknown: { label: '未登记效期', color: 'default' },
};

/** 统计数字用压暗的语义色。标签仍走 antd 预设，方便扫读。 */
const LEVEL_FIGURE: Record<ExpiryLevel, string> = {
  expired: '#a33b32',
  critical: '#8a5a00',
  warning: '#7a4e00',
  safe: '#3f7d4e',
  unknown: '#737373',
};

const LEVEL_ORDER: ExpiryLevel[] = ['expired', 'critical', 'warning', 'safe', 'unknown'];

/** 统计卡副标题：层的语义边界（缺省阈值 7/30，改 settings 后分层随动） */
const LEVEL_HINT: Record<ExpiryLevel, string> = {
  expired: '效期早于今天',
  critical: '今天到期 ~ 7 天内',
  warning: '8 ~ 30 天内到期',
  safe: '30 天以上',
  unknown: 'DEFAULT 虚拟批次等',
};

/** 剩余天数渲染：负数显眼（已过期 N 天）、0 强调（今天到期）、null 弱化 */
function DaysLeft({ value }: { value: number | null }) {
  if (value === null) return <Typography.Text type="secondary">—</Typography.Text>;
  if (value < 0)
    return <Typography.Text type="danger">已过期 {-value} 天</Typography.Text>;
  if (value === 0) return <Typography.Text type="warning">今天到期</Typography.Text>;
  return <Typography.Text>{value} 天</Typography.Text>;
}

export default function ExpiryPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const { data, isLoading } = useExpiryBoard();
  const [level, setLevel] = useState<ExpiryLevel | 'all'>('all');
  const [keyword, setKeyword] = useState(() => takeInitialFilter()?.skuCode ?? '');

  const rows = data?.rows ?? [];
  const counts = Object.fromEntries(
    LEVEL_ORDER.map((l) => [l, rows.filter((r) => r.level === l).length]),
  ) as Record<ExpiryLevel, number>;

  const kw = keyword.trim().toLowerCase();
  const visibleRows = rows.filter((r) => {
    if (level !== 'all' && r.level !== level) return false;
    if (!kw) return true;
    return (
      r.skuCode.toLowerCase().includes(kw) ||
      r.name.toLowerCase().includes(kw) ||
      r.batchNo.toLowerCase().includes(kw)
    );
  });

  // 导出：当前分层/关键词筛选下的全量数据（效期看板本身全量下发，客户端过滤）
  const doExport = (format: 'csv' | 'xlsx') => {
    if (visibleRows.length === 0) {
      message.warning('当前筛选下没有可导出的数据');
      return;
    }
    const headers = ['分层', '编码', '名称', '批次号', '效期', '剩余天数', '余量', '库位数'];
    const rows = visibleRows.map((r) => [
      LEVEL_META[r.level].label,
      r.skuCode,
      r.name,
      r.batchNo,
      r.batchExpiryDate ?? '',
      r.daysLeft ?? '',
      r.quantity,
      r.buckets.length,
    ]);
    if (format === 'xlsx') {
      void downloadXlsx(xlsxName('效期看板'), '效期看板', { headers, rows });
    } else {
      downloadCsv(`效期看板-${fileStamp()}.csv`, toCsv(headers, rows));
    }
    message.success(`已导出 ${rows.length} 行（当前筛选条件下的全量数据）`);
  };

  const columns: ColumnsType<ExpiryBatchRow> = [
    {
      title: '分层',
      dataIndex: 'level',
      key: 'level',
      width: 110,
      render: (v: ExpiryLevel) => <Tag color={LEVEL_META[v].color}>{LEVEL_META[v].label}</Tag>,
    },
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '批次号', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
    { title: '效期', dataIndex: 'batchExpiryDate', key: 'batchExpiryDate' },
    {
      title: '剩余天数',
      dataIndex: 'daysLeft',
      key: 'daysLeft',
      width: 120,
      align: 'right',
      onCell: numCell,
      render: (v: number | null) => <DaysLeft value={v} />,
    },
    {
      title: '余量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right',
      onCell: numCell,
      render: (v: number, r) => <Typography.Text strong>{fmtQty(v, r.unit)}</Typography.Text>,
    },
    {
      title: '库位',
      dataIndex: 'buckets',
      key: 'buckets',
      render: (v: ExpiryBatchRow['buckets']) => `${v.length} 库位`,
    },
  ];

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="效期看板"
        subtitle={`临期分层预警（截至 ${data?.today ?? '…'}，按效期升序）`}
        extra={
          <>
            <Select<ExpiryLevel | 'all'>
              value={level}
              onChange={setLevel}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: '全部分层' },
                ...LEVEL_ORDER.map((l) => ({ value: l, label: LEVEL_META[l].label })),
              ]}
            />
            <Input
              allowClear
              placeholder="按编码/名称/批次过滤"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 200 }}
            />
            <Button onClick={() => doExport('csv')}>导出 CSV</Button>
            <Button onClick={() => doExport('xlsx')}>导出 Excel</Button>
          </>
        }
      />
      <Space size={16} wrap>
        {LEVEL_ORDER.map((l) => (
          <Card key={l} size="small" style={{ width: 168 }}>
            <Statistic
              title={LEVEL_META[l].label}
              value={counts[l]}
              suffix="批"
              valueStyle={{ color: LEVEL_FIGURE[l] }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {LEVEL_HINT[l]}
            </Typography.Text>
          </Card>
        ))}
      </Space>
      <Card className="list-card">
        <Table<ExpiryBatchRow>
          rowKey={(r) => `${r.skuId} ${r.batchNo}`}
          columns={columns}
          dataSource={visibleRows}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          locale={{ emptyText: '还没有批次库存（入库声明批次后出现）' }}
          expandable={{
            rowExpandable: (r) => r.buckets.length > 0,
            expandedRowRender: (r) => (
              <Table
                size="small"
                rowKey={(b) => b.locationCode}
                columns={[
                  { title: '库位', dataIndex: 'locationCode', key: 'locationCode', width: 160, onCell: monoCell },
                  {
                    title: '余量',
                    dataIndex: 'quantity',
                    key: 'quantity',
                    align: 'right',
                    onCell: numCell,
                    render: (v: number) => <Typography.Text strong>{fmtQty(v, r.unit)}</Typography.Text>,
                  },
                ]}
                dataSource={r.buckets}
                pagination={TABLE_PAGINATION}
                style={{ maxWidth: 360 }}
              />
            ),
          }}
        />
      </Card>
    </div>
  );
}
