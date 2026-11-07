import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DownloadOutlined, DownOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Dropdown, Modal, Progress, Space, Table, Tag, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQueryClient } from '@tanstack/react-query';
import type { PreviewRow } from '../lib/exchange';
import { downloadXlsx, readTableFile, xlsxName } from '../lib/sheet';
import type { SheetTable } from '../lib/sheet';
import { TABLE_PAGINATION, monoCell, numCell } from './table-style';

/**
 * 挂在档案/单据页头上的导入导出。导出只出 Excel；导入认 Excel，也认 CSV。
 * 预览确认后才落库：一行（或同一张单）失败不影响已经成功的行。
 */

export interface ExportJob {
  key: string;
  /** 多项导出时的菜单文案。只有一项时按钮固定写「导出 Excel」。 */
  label: string;
  filename: string;
  sheetName: string;
  build: () => Promise<SheetTable>;
}

export interface ImportSpec<T extends PreviewRow> {
  title: string;
  hint: ReactNode;
  template: {
    filename: string;
    sheetName: string;
    headers: string[];
    rows: unknown[][];
    success: string;
  };
  columns: ColumnsType<T>;
  parse: (table: string[][]) => Promise<T[]> | T[];
  /** 按行提交（档案）。 */
  commit?: (row: T) => Promise<void>;
  /** 按 groupKey 整组提交（一张出入库单）。与 commit 二选一。 */
  commitGroup?: (rows: T[]) => Promise<void>;
  invalidateKeys?: readonly (readonly unknown[])[];
}

const ACCEPT = '.xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function lineNoColumn<T extends PreviewRow>(): ColumnsType<T>[number] {
  return { title: '行号', dataIndex: 'lineNo', width: 70, align: 'right', onCell: numCell };
}

export function actionColumn<T extends PreviewRow>(): ColumnsType<T>[number] {
  return {
    title: '动作',
    dataIndex: 'action',
    width: 90,
    render: (value: PreviewRow['action']) =>
      value === 'create' ? (
        <Tag color="green">新建</Tag>
      ) : value === 'update' ? (
        <Tag color="blue">更新</Tag>
      ) : (
        <Tag color="red">跳过</Tag>
      ),
  };
}

export function reasonColumn<T extends PreviewRow>(): ColumnsType<T>[number] {
  return {
    title: '原因',
    dataIndex: 'reason',
    render: (value: string | undefined) =>
      value ? (
        <Typography.Text type="danger">{value}</Typography.Text>
      ) : (
        <Typography.Text type="secondary">-</Typography.Text>
      ),
  };
}

export function textColumn<T extends PreviewRow>(
  title: string,
  dataIndex: keyof T & string,
  opts?: { mono?: boolean; width?: number },
): ColumnsType<T>[number] {
  return {
    title,
    dataIndex,
    width: opts?.width,
    onCell: opts?.mono ? monoCell : undefined,
    render: (value: unknown) =>
      value === null || value === undefined || value === '' ? (
        <Typography.Text type="secondary">-</Typography.Text>
      ) : (
        String(value)
      ),
  };
}

export default function SheetPort<T extends PreviewRow>({
  exports = [],
  importSpec,
}: {
  exports?: ExportJob[];
  importSpec?: ImportSpec<T>;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [exporting, setExporting] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<T[]>([]);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; ok: number; fail: number } | null>(null);

  const runExport = async (job: ExportJob) => {
    setExporting(job.key);
    try {
      const table = await job.build();
      if (table.rows.length === 0) {
        message.warning('没有可导出的数据（导出了一张只有表头的空文件）');
      }
      await downloadXlsx(xlsxName(job.filename), job.sheetName, table);
      message.success(`${job.filename} 已导出：${table.rows.length} 行`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : `导出失败：${String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const downloadTemplate = async () => {
    if (!importSpec) return;
    try {
      await downloadXlsx(xlsxName(importSpec.template.filename), importSpec.template.sheetName, {
        headers: importSpec.template.headers,
        rows: importSpec.template.rows,
      });
      message.success(importSpec.template.success);
    } catch (e) {
      message.error(e instanceof Error ? e.message : `模板下载失败：${String(e)}`);
    }
  };

  const handleFile = (file: File) => {
    if (!importSpec) return false;
    setParsing(true);
    void (async () => {
      try {
        const table = await readTableFile(file);
        if (table.length === 0) {
          message.error('文件是空的');
          return;
        }
        const parsed = await importSpec.parse(table);
        if (parsed.length === 0) {
          message.error('除了表头没有数据行');
          return;
        }
        setRows(parsed);
        setFileName(file.name);
        setProgress(null);
        const created = parsed.filter((row) => row.action === 'create').length;
        const updated = parsed.filter((row) => row.action === 'update').length;
        const errors = parsed.filter((row) => row.action === 'error').length;
        message.info(`已解析 ${parsed.length} 行：新建 ${created}、更新 ${updated}、跳过 ${errors}`);
      } catch (e) {
        message.error(e instanceof Error ? e.message : `解析失败：${String(e)}`);
      } finally {
        setParsing(false);
      }
    })();
    return false;
  };

  const stats = useMemo(() => {
    const submittable = rows.filter((row) => row.action !== 'error');
    return {
      total: rows.length,
      create: rows.filter((row) => row.action === 'create').length,
      update: rows.filter((row) => row.action === 'update').length,
      error: rows.filter((row) => row.action === 'error').length,
      submittable: submittable.length,
    };
  }, [rows]);

  const runImport = async () => {
    if (!importSpec) return;
    const todo = rows.filter((row) => row.action !== 'error');
    if (todo.length === 0) {
      message.warning('没有可导入的行');
      return;
    }
    setImporting(true);
    setProgress({ done: 0, ok: 0, fail: 0 });
    let failed = 0;

    const bump = (okCount: number, failCount: number) => {
      setProgress((prev) =>
        prev
          ? { done: prev.done + okCount + failCount, ok: prev.ok + okCount, fail: prev.fail + failCount }
          : prev,
      );
    };
    const failRows = (targets: T[], reason: string) => {
      const lines = new Set(targets.map((row) => row.lineNo));
      setRows((prev) =>
        prev.map((row) => (lines.has(row.lineNo) ? { ...row, action: 'error', reason } : row)),
      );
    };

    if (importSpec.commitGroup) {
      const groups = new Map<string, T[]>();
      for (const row of todo) {
        const key = row.groupKey ?? `line:${row.lineNo}`;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      for (const group of groups.values()) {
        try {
          await importSpec.commitGroup(group);
          bump(group.length, 0);
        } catch (e) {
          failed += group.length;
          failRows(group, e instanceof Error ? e.message : String(e));
          bump(0, group.length);
        }
      }
    } else if (importSpec.commit) {
      for (const row of todo) {
        try {
          await importSpec.commit(row);
          bump(1, 0);
        } catch (e) {
          failed += 1;
          failRows([row], e instanceof Error ? e.message : String(e));
          bump(0, 1);
        }
      }
    }

    setImporting(false);
    for (const key of importSpec.invalidateKeys ?? []) {
      void qc.invalidateQueries({ queryKey: [...key] });
    }
    if (failed === 0) {
      message.success(`导入完成：${todo.length} 行全部成功`);
    } else {
      message.warning(`导入完成：成功 ${todo.length - failed} 行，失败 ${failed} 行（见下表原因）`);
    }
  };

  const exportButton =
    exports.length === 0 ? null : exports.length === 1 ? (
      <Button
        icon={<DownloadOutlined />}
        loading={exporting !== null}
        onClick={() => void runExport(exports[0]!)}
      >
        导出 Excel
      </Button>
    ) : (
      <Dropdown
        menu={{
          items: exports.map((job) => ({ key: job.key, label: job.label })),
          onClick: ({ key }) => {
            const job = exports.find((item) => item.key === key);
            if (job) void runExport(job);
          },
        }}
      >
        <Button icon={<DownloadOutlined />} loading={exporting !== null}>
          导出 Excel <DownOutlined />
        </Button>
      </Dropdown>
    );

  return (
    <>
      <Space size={8}>
        {exportButton}
        {importSpec ? (
          <Button icon={<InboxOutlined />} onClick={() => setOpen(true)}>
            导入
          </Button>
        ) : null}
      </Space>
      {importSpec && open ? (
        <Modal
          title={importSpec.title}
          open
          onCancel={() => setOpen(false)}
          footer={null}
          width={960}
          destroyOnHidden
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert type="info" showIcon message="导入前先看一眼" description={importSpec.hint} />
            <Space wrap>
              <Button icon={<DownloadOutlined />} onClick={() => void downloadTemplate()}>
                下载导入模板
              </Button>
              <Upload accept={ACCEPT} maxCount={1} showUploadList={false} beforeUpload={handleFile}>
                <Button type="primary" icon={<InboxOutlined />} loading={parsing || importing}>
                  选择 Excel 或 CSV
                </Button>
              </Upload>
              {fileName ? <Typography.Text type="secondary">已选：{fileName}</Typography.Text> : null}
              {rows.length > 0 ? (
                <Button
                  onClick={() => {
                    setRows([]);
                    setFileName('');
                    setProgress(null);
                  }}
                >
                  清空预览
                </Button>
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
                    onClick={() => void runImport()}
                  >
                    确认导入 {stats.submittable} 行
                  </Button>
                </Space>
                {progress ? (
                  <Progress
                    percent={Math.round((progress.done / Math.max(stats.submittable, 1)) * 100)}
                    status={
                      progress.fail > 0 ? 'exception' : progress.done >= stats.submittable ? 'success' : 'active'
                    }
                    format={() => `成功 ${progress.ok} / 失败 ${progress.fail}`}
                  />
                ) : null}
                <Table<T>
                  rowKey="lineNo"
                  size="small"
                  columns={importSpec.columns}
                  dataSource={rows}
                  pagination={TABLE_PAGINATION}
                  scroll={{ x: 'max-content' }}
                />
              </>
            ) : null}
          </Space>
        </Modal>
      ) : null}
    </>
  );
}
