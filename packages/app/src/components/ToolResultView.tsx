import { Descriptions, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import { TABLE_PAGINATION } from './table-style';

/**
 * 工具结果视图（M12 步骤2）：查询类工具的 payload 渲染成表格，
 * 其余工具兜底 JSON——「界面管明细、模型只总结」分工的落点。
 * 返回值结构是 @one/wms 工具层的手写镜像（前端不依赖 @one/wms）。
 */

/** inventory.query 形态一：库位平铺行（行含批次与效期） */
interface FlatRow {
  skuCode: string;
  name: string;
  batchNo: string;
  batchExpiryDate: string | null;
  quantity: number;
}

/** inventory.query 分组形态的库位行（内嵌批次明细） */
interface LocationGroup {
  locationCode: string;
  locationName: string;
  quantity: number;
  batches: { batchNo: string; batchExpiryDate: string | null; quantity: number }[];
}

/** inventory.query 形态二：单 SKU 分组；形态三：该对象的数组 */
interface SkuGroup {
  skuCode: string;
  name: string;
  total: number;
  byLocation: LocationGroup[];
}

/** inventory.expiring 平铺行（效期必有，按效期升序返回） */
interface ExpiringRow {
  skuCode: string;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string;
  daysLeft: number;
  quantity: number;
}

/** location.list 行 */
interface LocationRow {
  locationCode: string;
  name: string;
  createdAt: string;
}

/** 分组形态判别（byLocation 数组字段是形态二/三的标志） */
function isSkuGroup(v: unknown): v is SkuGroup {
  return !!v && typeof v === 'object' && Array.isArray((v as SkuGroup).byLocation);
}

const expiryText = (v: string | null) => v ?? '—';

/** 剩余天数文案：负数 = 已过期天数 */
function daysLeftText(d: number): string {
  if (d < 0) return `过期 ${-d} 天`;
  if (d === 0) return '今天到期';
  return `${d} 天`;
}

/** 注入 antd 默认 rowKey 用的 key：静态快照数据下下标即可
 *  （预先 map 进 record，避开 rowKey 函数 index 参数的弃用警告） */
function withKeys<T extends object>(rows: T[]): (T & { key: number })[] {
  return rows.map((r, i) => ({ ...r, key: i }));
}

export default function ToolResultView({ toolId, payload }: { toolId: string; payload: unknown }) {
  switch (toolId) {
    case 'wms.inventory.query':
      return renderQuery(payload);
    case 'wms.inventory.expiring':
      return renderExpiring(payload);
    case 'wms.location.list':
      return renderLocationList(payload);
    case 'ui.ask':
      return renderAsk(payload);
    default:
      return renderPlain(payload);
  }
}

function renderQuery(payload: unknown): ReactNode {
  if (Array.isArray(payload)) {
    // 元素带 byLocation → 形态三（全部 SKU 分组清单）；否则形态一（库位平铺）
    return payload.length > 0 && isSkuGroup(payload[0])
      ? renderGroupList(payload as SkuGroup[])
      : renderFlatRows(payload as FlatRow[]);
  }
  if (isSkuGroup(payload)) return renderSingleGroup(payload);
  return renderPlain(payload);
}

/** 形态一：库位平铺（「这个库位里有什么」——行含批次与效期） */
function renderFlatRows(rows: FlatRow[]) {
  const columns: ColumnsType<FlatRow> = [
    { title: 'SKU', dataIndex: 'skuCode' },
    { title: '名称', dataIndex: 'name' },
    { title: '批次', dataIndex: 'batchNo' },
    { title: '效期', dataIndex: 'batchExpiryDate', render: expiryText },
    { title: '数量', dataIndex: 'quantity', align: 'right' },
  ];
  return (
    <>
      <Table size="small" columns={columns} dataSource={withKeys(rows)} pagination={TABLE_PAGINATION} />
    </>
  );
}

/** 形态二：单 SKU 分组——总量 + 分库位行（批次明细随库位行竖排） */
function renderSingleGroup(g: SkuGroup) {
  const columns: ColumnsType<LocationGroup> = [
    { title: '库位', dataIndex: 'locationCode' },
    { title: '名称', dataIndex: 'locationName' },
    { title: '数量', dataIndex: 'quantity', align: 'right' },
    {
      title: '批次明细',
      dataIndex: 'batches',
      render: (batches: LocationGroup['batches']) => (
        <span style={{ whiteSpace: 'pre-line', fontSize: 12 }}>
          {batches
            .map(
              (b) =>
                `${b.batchNo}${b.batchExpiryDate ? `（效期 ${b.batchExpiryDate}）` : ''} × ${b.quantity}`,
            )
            .join('\n')}
        </span>
      ),
    },
  ];
  return (
    <>
      <Descriptions column={3} size="small">
        <Descriptions.Item label="SKU">{g.skuCode}</Descriptions.Item>
        <Descriptions.Item label="名称">{g.name}</Descriptions.Item>
        <Descriptions.Item label="总量">{g.total}</Descriptions.Item>
      </Descriptions>
      <Table size="small" columns={columns} dataSource={withKeys(g.byLocation)} pagination={TABLE_PAGINATION} />
    </>
  );
}

/** 形态三：全部 SKU 分组清单——每 SKU 一行汇总（分库位明细追问具体 SKU 可得） */
function renderGroupList(groups: SkuGroup[]) {
  const columns: ColumnsType<SkuGroup> = [
    { title: 'SKU', dataIndex: 'skuCode' },
    { title: '名称', dataIndex: 'name' },
    { title: '总量', dataIndex: 'total', align: 'right' },
  ];
  return (
    <>
      <Table size="small" columns={columns} dataSource={withKeys(groups)} pagination={TABLE_PAGINATION} />
    </>
  );
}

function renderExpiring(payload: unknown) {
  if (!Array.isArray(payload)) return renderPlain(payload);
  const rows = payload as ExpiringRow[];
  const columns: ColumnsType<ExpiringRow> = [
    { title: 'SKU', dataIndex: 'skuCode' },
    { title: '库位', dataIndex: 'locationCode' },
    { title: '批次', dataIndex: 'batchNo' },
    { title: '效期', dataIndex: 'batchExpiryDate' },
    { title: '剩余', dataIndex: 'daysLeft', render: daysLeftText },
    { title: '数量', dataIndex: 'quantity', align: 'right' },
  ];
  return (
    <>
      <Table size="small" columns={columns} dataSource={withKeys(rows)} pagination={TABLE_PAGINATION} />
    </>
  );
}

function renderLocationList(payload: unknown) {
  if (!Array.isArray(payload)) return renderPlain(payload);
  const rows = payload as LocationRow[];
  const columns: ColumnsType<LocationRow> = [
    { title: '库位', dataIndex: 'locationCode' },
    { title: '名称', dataIndex: 'name' },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => v.slice(0, 10) },
  ];
  return (
    <>
      <Table size="small" columns={columns} dataSource={withKeys(rows)} pagination={TABLE_PAGINATION} />
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  skuCode: '编码',
  name: '名称',
  barcode: '条码',
  unit: '单位',
  quantity: '数量',
  orderNo: '单号',
  direction: '方向',
  state: '状态',
  locationCode: '库位',
  batchNo: '批次',
  batchExpiryDate: '效期',
  partnerCode: '往来单位',
  total: '总量',
  lineCount: '行数',
  daysLeft: '剩余',
  createdAt: '时间',
};

function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key;
}

function showCell(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'direction') return value === 'in' ? '入库' : value === 'out' ? '出库' : String(value);
  if (typeof value === 'object') return '';
  return String(value);
}

function isPlainRow(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 对象数组 → 表格。内部 id 不进列，列名用中文。 */
function renderObjectTable(rows: Record<string, unknown>[]) {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === 'key' || key.endsWith('Id') || keys.includes(key)) continue;
      if (rows.some((item) => item[key] !== null && item[key] !== undefined && typeof item[key] !== 'object')) {
        keys.push(key);
      }
      if (keys.length >= 8) break;
    }
    if (keys.length >= 8) break;
  }
  if (keys.length === 0) return null;
  const columns: ColumnsType<Record<string, unknown>> = keys.map((key) => ({
    title: fieldLabel(key),
    dataIndex: key,
    render: (value: unknown) => showCell(key, value),
  }));
  return (
    <>
      <Table size="small" columns={columns} dataSource={withKeys(rows)} pagination={TABLE_PAGINATION} />
    </>
  );
}

/** 写操作和未专门排版的结果：短句，不把对象摊成 JSON */
function renderPlain(payload: unknown): ReactNode {
  if (Array.isArray(payload) && payload.every(isPlainRow)) return renderObjectTable(payload);
  const row = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  if (row && Array.isArray(row.rows) && row.rows.every(isPlainRow)) {
    return renderObjectTable(row.rows as Record<string, unknown>[]);
  }
  if (!row) {
    if (payload === null || payload === undefined) return null;
    return <Typography.Text>{String(payload)}</Typography.Text>;
  }
  const lines = Object.entries(row)
    .filter(([key, value]) => !key.endsWith('Id') && value !== null && value !== undefined && typeof value !== 'object')
    .slice(0, 6)
    .map(([key, value]) => `${fieldLabel(key)} ${showCell(key, value)}`);
  if (lines.length === 0) return null;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** ui.ask 终态（M12 步骤3）：用户回答原文 / 未回答（跳过或超时） */
function renderAsk(payload: unknown): ReactNode {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { answer?: unknown }).answer === 'string'
  ) {
    return (
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        用户回答：{(payload as { answer: string }).answer}
      </Typography.Paragraph>
    );
  }
  return <Typography.Text type="secondary">用户未回答（跳过或超时）</Typography.Text>;
}
