import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  InputNumber,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Sku } from '../api/client';
import { useProfileSnapshot, useSkus } from '../api/hooks';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';
import { downloadCsv, fileStamp, headerIndex, parseCsv, toCsv } from '../lib/csv';

/**
 * 导入导出页——CSV 是唯一格式（Excel 能直接开，不引 xlsx 依赖）。
 *
 * 导出：SKU 档案 / 库存汇总 / 库存分桶 / 库存流水，全部即时拉取当前数据，
 * 带 UTF-8 BOM（否则 Excel 打开中文乱码）。
 * 导入：只支持 SKU 档案批量建档/改档——库存数量不能靠导入改（库存的真相是
 * 流水，直接写数量会绕过护栏且丢账），期初数量请用库存页的「调整」。
 * 导入分两步：先解析出预览（新建/更新/错误 三态，含行号与原因），确认后
 * 逐行走同一套服务端工具，失败的行跳过并回报，不影响已成功的行。
 */

type ImportAction = 'create' | 'update' | 'error';

interface ImportRow {
  /** CSV 里的行号（从 2 开始，1 是表头）——出错时让人能对回原文件 */
  lineNo: number;
  action: ImportAction;
  skuCode: string;
  name: string;
  unit: string;
  barcode: string;
  reorderPoint: number | null;
  reason?: string;
}

/** 表头别名：中英文都认（模板给中文，用户自己从 Excel 存的可能是英文键） */
const COLUMN_ALIASES: Record<keyof ImportColumns, string[]> = {
  skuCode: ['skucode', '编码', 'sku编码', 'sku 编码'],
  name: ['name', '名称', '品名'],
  unit: ['unit', '单位', '数量单位'],
  barcode: ['barcode', '条码', '条形码'],
  reorderPoint: ['reorderpoint', '安全库存', '预警阈值'],
};

type ImportColumns = Pick<ImportRow, 'skuCode' | 'name' | 'unit' | 'barcode' | 'reorderPoint'>;

const SKU_HEADERS = ['编码', '名称', '单位', '条码', '安全库存'];

export default function DataPortPage() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  // 比对需要全量档案：已停用的 SKU 也要认出来（否则会误判成新建），includeArchived
  const { data: skus } = useSkus(undefined, true);
  const snapshot = useProfileSnapshot();
  const [ledgerLimit, setLedgerLimit] = useState(1000);
  const [exporting, setExporting] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; ok: number; fail: number } | null>(null);

  const extensions = snapshot.data?.schema.entities['sku']?.extensions ?? [];

  /** 导出任务：拉数据 → 转 CSV → 下载。失败只提示，不留半截文件 */
  const doExport = async (key: string, filename: string, build: () => Promise<[string[], unknown[][]]>) => {
    setExporting(key);
    try {
      const [headers, data] = await build();
      if (data.length === 0) {
        message.warning('没有可导出的数据（导出了一张只有表头的空文件）');
      }
      downloadCsv(`${filename}-${fileStamp()}.csv`, toCsv(headers, data));
      message.success(`${filename} 已导出：${data.length} 行`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `导出失败：${String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const exportSkus = () =>
    doExport('skus', 'SKU档案', async () => {
      const list = await api.skus({ includeArchived: true });
      const extCols = extensions.filter((e) => e.visible);
      return [
        [...SKU_HEADERS, '状态', ...extCols.map((e) => e.label)],
        list.map((s) => [
          s.skuCode,
          s.name,
          s.unit ?? '',
          s.barcode ?? '',
          s.reorderPoint,
          (s.status ?? 'active') === 'archived' ? '已停用' : '启用',
          ...extCols.map((e) => {
            const v = s.extData[e.key];
            if (v === undefined || v === null) return '';
            return typeof v === 'object' ? JSON.stringify(v) : String(v);
          }),
        ]),
      ];
    });

  const exportInventory = () =>
    doExport('inventory', '库存汇总', async () => {
      const list = await api.inventory();
      return [
        ['编码', '名称', '单位', '当前余量', '冻结量', '可用量', '安全库存', '是否低于安全库存'],
        list.map((r) => [
          r.skuCode,
          r.name,
          r.unit ?? '',
          r.quantity,
          r.held,
          r.available,
          r.reorderPoint,
          r.reorderPoint > 0 && r.available < r.reorderPoint ? '是' : '否',
        ]),
      ];
    });

  const exportBuckets = () =>
    doExport('buckets', '库存分桶', async () => {
      const list = await api.inventoryBuckets();
      return [
        ['编码', '名称', '单位', '库位', '批次号', '批次效期', '余量'],
        list.map((r) => [
          r.skuCode,
          r.name,
          r.unit ?? '',
          r.locationCode,
          r.batchNo,
          r.batchExpiryDate ?? '',
          r.quantity,
        ]),
      ];
    });

  const exportLedger = () =>
    doExport('ledger', '库存流水', async () => {
      const list = await api.ledger({ limit: ledgerLimit });
      return [
        ['时间', '编码', '名称', '库位', '批次号', '批次效期', '变动数量', '原因', '关联单据'],
        list.map((r) => [
          r.createdAt.replace('T', ' ').slice(0, 19),
          r.skuCode,
          r.name,
          r.locationCode,
          r.batchNo,
          r.batchExpiryDate ?? '',
          r.delta,
          r.reason,
          r.orderNo ?? '',
        ]),
      ];
    });

  const downloadTemplate = () => {
    downloadCsv(
      `SKU导入模板-${fileStamp()}.csv`,
      toCsv(SKU_HEADERS, [
        ['A-1001', '示例商品', '', '6901234567892', 50],
        ['BULK-01', '散装绿豆', 'kg', '', 0],
      ]),
    );
    message.success('模板已下载：5 列（编码必填，单位/条码/安全库存可留空）');
  };

  /** 解析文件 → 预览行（不落库，纯本地校验 + 与现有档案比对） */
  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        const table = parseCsv(text);
        if (table.length === 0) {
          message.error('文件是空的');
          return;
        }
        const idx = headerIndex(table[0]);
        const col = (key: keyof ImportColumns): number | undefined => {
          for (const alias of COLUMN_ALIASES[key]) {
            const i = idx.get(alias);
            if (i !== undefined) return i;
          }
          return undefined;
        };
        const cCode = col('skuCode');
        const cName = col('name');
        if (cCode === undefined) {
          message.error('表头里找不到「编码」列（也认 skuCode）——先下载模板照着填');
          return;
        }
        const byCode = new Map((skus ?? []).map((s) => [s.skuCode, s] as const));
        const barcodeOwner = new Map((skus ?? []).filter((s) => s.barcode).map((s) => [s.barcode as string, s.skuCode] as const));
        const seen = new Map<string, number>();
        const parsed: ImportRow[] = table.slice(1).map((cells, i) => {
          const lineNo = i + 2;
          const skuCode = (cells[cCode] ?? '').trim();
          const name = cName === undefined ? '' : (cells[cName] ?? '').trim();
          const cUnit = col('unit');
          const unit = cUnit === undefined ? '' : (cells[cUnit] ?? '').trim();
          const cBar = col('barcode');
          const barcode = cBar === undefined ? '' : (cells[cBar] ?? '').trim();
          const cRp = col('reorderPoint');
          const rpRaw = cRp === undefined ? '' : (cells[cRp] ?? '').trim();
          const fail = (reason: string): ImportRow => ({
            lineNo, action: 'error', skuCode, name, unit, barcode, reorderPoint: null, reason,
          });

          if (!skuCode) return fail('编码为空');
          if (seen.has(skuCode)) return fail(`编码在文件内重复（与第 ${seen.get(skuCode)} 行）`);
          seen.set(skuCode, lineNo);

          let reorderPoint: number | null = null;
          if (rpRaw !== '') {
            const n = Number(rpRaw);
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
              return fail(`安全库存「${rpRaw}」不是不小于 0 的整数（填 0 或留空 = 不预警）`);
            }
            reorderPoint = n;
          }
          const existing = byCode.get(skuCode);
          if (!existing && cName !== undefined && !name) return fail('新建 SKU 必须填名称');
          const owner = barcode ? barcodeOwner.get(barcode) : undefined;
          if (owner && owner !== skuCode) return fail(`条码 ${barcode} 已被 ${owner} 占用`);
          if (barcode) barcodeOwner.set(barcode, skuCode);

          return { lineNo, action: existing ? 'update' : 'create', skuCode, name, unit, barcode, reorderPoint };
        });
        setRows(parsed);
        setFileName(file.name);
        setProgress(null);
        const errs = parsed.filter((r) => r.action === 'error').length;
        message.info(
          `已解析 ${parsed.length} 行：新建 ${parsed.filter((r) => r.action === 'create').length}、` +
            `更新 ${parsed.filter((r) => r.action === 'update').length}、错误 ${errs}`,
        );
      } catch (e) {
        message.error(`解析失败：${String(e)}`);
      }
    };
    reader.onerror = () => message.error('文件读取失败');
    reader.readAsText(file, 'utf-8');
    return false; // 阻止 antd 自动上传——全部逻辑在本地
  };

  /** 逐行提交：一行一次工具调用，失败跳过并记录原因（不回滚已成功的行） */
  const runImport = async () => {
    const todo = rows.filter((r) => r.action !== 'error');
    if (todo.length === 0) {
      message.warning('没有可导入的行');
      return;
    }
    setImporting(true);
    setProgress({ done: 0, ok: 0, fail: 0 });
    const failures: string[] = [];
    for (let i = 0; i < todo.length; i += 1) {
      const r = todo[i];
      try {
        if (r.action === 'create') {
          await api.createSku({
            skuCode: r.skuCode,
            name: r.name,
            ...(r.unit ? { unit: r.unit } : {}),
            barcode: r.barcode || undefined,
            reorderPoint: r.reorderPoint ?? undefined,
          });
        } else {
          await api.updateSku(r.skuCode, {
            ...(r.name ? { name: r.name } : {}),
            ...(r.unit ? { unit: r.unit } : {}),
            ...(r.barcode ? { barcode: r.barcode } : {}),
            ...(r.reorderPoint !== null ? { reorderPoint: r.reorderPoint } : {}),
          });
        }
        setProgress((p) => (p ? { done: p.done + 1, ok: p.ok + 1, fail: p.fail } : p));
      } catch (e) {
        const reason = e instanceof ApiError ? e.message : String(e);
        failures.push(`第 ${r.lineNo} 行 ${r.skuCode}：${reason}`);
        setRows((prev) =>
          prev.map((x) => (x.lineNo === r.lineNo ? { ...x, action: 'error', reason } : x)),
        );
        setProgress((p) => (p ? { done: p.done + 1, ok: p.ok, fail: p.fail + 1 } : p));
      }
    }
    setImporting(false);
    void qc.invalidateQueries({ queryKey: ['skus'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    if (failures.length === 0) {
      message.success(`导入完成：${todo.length} 行全部成功`);
    } else {
      message.warning(`导入完成：成功 ${todo.length - failures.length} 行，失败 ${failures.length} 行（见下表原因）`);
    }
  };

  const stats = useMemo(() => {
    const ok = rows.filter((r) => r.action !== 'error');
    return {
      total: rows.length,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      error: rows.filter((r) => r.action === 'error').length,
      submittable: ok.length,
    };
  }, [rows]);

  const columns: ColumnsType<ImportRow> = [
    { title: '行号', dataIndex: 'lineNo', width: 70, align: 'right', onCell: numCell },
    {
      title: '动作',
      dataIndex: 'action',
      width: 90,
      render: (v: ImportAction) =>
        v === 'create' ? <Tag color="green">新建</Tag> : v === 'update' ? <Tag color="blue">更新</Tag> : <Tag color="red">跳过</Tag>,
    },
    { title: '编码', dataIndex: 'skuCode', onCell: monoCell, width: 140 },
    { title: '名称', dataIndex: 'name', render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
    { title: '单位', dataIndex: 'unit', width: 80, render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
    { title: '条码', dataIndex: 'barcode', onCell: monoCell, render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
    {
      title: '安全库存',
      dataIndex: 'reorderPoint',
      width: 90,
      align: 'right',
      onCell: numCell,
      render: (v: number | null) => (v === null ? <Typography.Text type="secondary">—</Typography.Text> : v),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      render: (v: string | undefined) =>
        v ? <Typography.Text type="danger">{v}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  const exportItem = (
    key: string,
    title: string,
    desc: string,
    onClick: () => void,
    extra?: ReactNode,
  ) => (
    <Card key={key} size="small" title={title}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{desc}</Typography.Text>
        {extra}
        <Button icon={<DownloadOutlined />} loading={exporting === key} onClick={onClick} block>
          导出 CSV
        </Button>
      </Space>
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, overflow: 'auto' }}>
      <PageHeader
        title="导入导出"
        subtitle="CSV 格式（Excel 可直接打开）：档案与账目一键导出，SKU 档案批量导入"
      />

      <Card title={<><DownloadOutlined /> 导出</>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {exportItem('skus', 'SKU 档案', '全部 SKU：编码 / 名称 / 条码 / 安全库存 + 你的自定义字段。改完可以再导回来（导入只认前 4 列）。', exportSkus)}
          {exportItem('inventory', '库存汇总', '每个 SKU 一行：余量 / 冻结 / 可用量 / 安全库存，并标出是否低于安全库存。', exportInventory)}
          {exportItem('buckets', '库存分桶', '到「SKU × 库位 × 批次」粒度：东西放在哪、哪一批什么时候过期，一目了然。', exportBuckets)}
          {exportItem(
            'ledger',
            '库存流水',
            '每一次出入库/调整/盘点/移库的原始记录（只增不改），用于对账与追溯。',
            exportLedger,
            <Space size={4}>
              <Typography.Text type="secondary">最多导出</Typography.Text>
              <InputNumber
                size="small"
                min={1}
                max={5000}
                step={100}
                precision={0}
                value={ledgerLimit}
                onChange={(v) => setLedgerLimit(v ?? 1000)}
                style={{ width: 100 }}
              />
              <Typography.Text type="secondary">条（最近的在前）</Typography.Text>
            </Space>,
          )}
        </div>
      </Card>

      <Card title={<><InboxOutlined /> 导入 SKU 档案</>}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="能导入什么、不能导入什么"
            description={
              <>
                只能批量建档/改档 <Typography.Text strong>SKU 档案</Typography.Text>：编码已存在就更新（名称/条码/安全库存，留空的列不改），不存在就新建。
                <br />
                <Typography.Text type="danger">库存数量不能靠导入修改</Typography.Text>
                ——库存的真相是流水，直接写数量会绕过「不可为负」等护栏而且丢账。要录期初数量，请用库存页的「调整」。
              </>
            }
          />
          <Space wrap>
            <Button icon={<DownloadOutlined />} onClick={downloadTemplate}>
              下载导入模板
            </Button>
            <Upload accept=".csv,text/csv" maxCount={1} showUploadList={false} beforeUpload={handleFile}>
              <Button type="primary" icon={<InboxOutlined />} loading={importing}>
                选择 CSV 文件
              </Button>
            </Upload>
            {fileName ? <Typography.Text type="secondary">已选：{fileName}</Typography.Text> : null}
            {rows.length > 0 ? (
              <Button onClick={() => { setRows([]); setFileName(''); setProgress(null); }}>清空预览</Button>
            ) : null}
          </Space>

          {rows.length > 0 ? (
            <>
              <Space size={8} wrap>
                <Tag>共 {stats.total} 行</Tag>
                <Tag color="green">新建 {stats.create}</Tag>
                <Tag color="blue">更新 {stats.update}</Tag>
                <Tag color={stats.error > 0 ? 'red' : 'default'}>跳过 {stats.error}</Tag>
                <Button
                  type="primary"
                  disabled={stats.submittable === 0}
                  loading={importing}
                  onClick={runImport}
                >
                  确认导入 {stats.submittable} 行
                </Button>
              </Space>
              {progress ? (
                <Progress
                  percent={Math.round((progress.done / Math.max(stats.submittable, 1)) * 100)}
                  status={progress.fail > 0 ? 'exception' : progress.done >= stats.submittable ? 'success' : 'active'}
                  format={() => `成功 ${progress.ok} / 失败 ${progress.fail}`}
                />
              ) : null}
              <Table<ImportRow>
                rowKey="lineNo"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={TABLE_PAGINATION}
              />
            </>
          ) : null}
        </Space>
      </Card>
    </div>
  );
}
