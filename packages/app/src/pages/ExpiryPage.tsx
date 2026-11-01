import { useState } from 'react';
import { Card, Input, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useExpiryBoard } from '../api/hooks';
import type { ExpiryBatchRow, ExpiryLevel } from '../api/client';

/**
 * 效期看板（M14：临期分层预警）——让 M12/M13 沉淀的批次效期数据可见。
 * 数据全由后端算好（GET /api/inventory/expiry：SKU×批次聚合 + daysLeft/level
 * 分级 + 效期升序）；本页只做三件事：分层统计卡、着色表格、层/关键词过滤。
 * 分层语义与 M13 拦截同界：今天到期 = 临期（critical），未过期；< 今天才 expired。
 */

/** 分层展示元数据：统计卡标题 / Tag 语义色（与统计卡 valueStyle 同源） */
const LEVEL_META: Record<ExpiryLevel, { label: string; color: string }> = {
  expired: { label: '已过期', color: 'red' },
  critical: { label: '紧急', color: 'volcano' },
  warning: { label: '预警', color: 'gold' },
  safe: { label: '安全', color: 'green' },
  unknown: { label: '未登记效期', color: 'default' },
};

const LEVEL_ORDER: ExpiryLevel[] = ['expired', 'critical', 'warning', 'safe', 'unknown'];

/** 统计卡副标题：层的语义边界（天数为 server 常量，此处仅展示） */
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
  const { data, isLoading } = useExpiryBoard();
  const [level, setLevel] = useState<ExpiryLevel | 'all'>('all');
  const [keyword, setKeyword] = useState('');

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

  const columns: ColumnsType<ExpiryBatchRow> = [
    {
      title: '分层',
      dataIndex: 'level',
      key: 'level',
      width: 110,
      render: (v: ExpiryLevel) => <Tag color={LEVEL_META[v].color}>{LEVEL_META[v].label}</Tag>,
    },
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode' },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '批次号', dataIndex: 'batchNo', key: 'batchNo' },
    { title: '效期', dataIndex: 'batchExpiryDate', key: 'batchExpiryDate' },
    { title: '剩余天数', dataIndex: 'daysLeft', key: 'daysLeft', width: 120, render: (v: number | null) => <DaysLeft value={v} /> },
    {
      title: '余量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right',
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '库位',
      dataIndex: 'locations',
      key: 'locations',
      render: (v: string[]) => v.join('、'),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Space size={16} wrap>
        {LEVEL_ORDER.map((l) => (
          <Card key={l} size="small" style={{ width: 168 }}>
            <Statistic
              title={LEVEL_META[l].label}
              value={counts[l]}
              suffix="批"
              valueStyle={{ color: LEVEL_META[l].color }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {LEVEL_HINT[l]}
            </Typography.Text>
          </Card>
        ))}
      </Space>
      <Card
        title={`批次效期清单（截至 ${data?.today ?? '…'}，按效期升序）`}
        extra={
          <Space>
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
          </Space>
        }
      >
        <Table<ExpiryBatchRow>
          rowKey={(r) => `${r.skuId} ${r.batchNo}`}
          columns={columns}
          dataSource={visibleRows}
          loading={isLoading}
          pagination={false}
          locale={{ emptyText: '还没有批次库存（入库声明批次后出现）' }}
        />
      </Card>
    </Space>
  );
}
