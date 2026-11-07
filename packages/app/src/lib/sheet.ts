/**
 * 表格文件读写。导出只产 Excel（.xlsx）；导入以 Excel 为主，CSV 仍可读
 * （以前导出的文件、Excel「另存为 CSV」都能进）。
 * 编解码走 read-excel-file / write-excel-file，不使用有未修复漏洞的 SheetJS `xlsx`。
 */
import { readSheet } from 'read-excel-file/universal';
import writeXlsxFile from 'write-excel-file/universal';
import type { Cell, SheetData } from 'write-excel-file/universal';
import { fileStamp, parseCsv } from './csv';

export { fileStamp };

export interface SheetTable {
  headers: string[];
  rows: unknown[][];
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel 工作表名：最长 31，且不能含 \ / ? * [ ] : */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

function sheetCell(value: unknown): Cell {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function toSheetData(headers: string[], rows: unknown[][]): SheetData {
  const head: Cell[] = headers.map((header) => ({ value: header, fontWeight: 'bold' }));
  return [head, ...rows.map((row) => row.map(sheetCell))];
}

/** 生成 xlsx，不触发下载（测试与下载共用） */
export async function buildXlsxBlob(sheetName: string, headers: string[], rows: unknown[][]): Promise<Blob> {
  const book = writeXlsxFile(toSheetData(headers, rows), { sheet: safeSheetName(sheetName) });
  return book.toBlob();
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 下载一张工作表。文件名由调用方带上日期戳。 */
export async function downloadXlsx(filename: string, sheetName: string, table: SheetTable): Promise<void> {
  const blob = await buildXlsxBlob(sheetName, table.headers, table.rows);
  triggerDownload(filename, blob);
}

/** 带日期戳的导出文件名：库存汇总-20261107-2215.xlsx */
export function xlsxName(title: string, d = new Date()): string {
  return `${title}-${fileStamp(d)}.xlsx`;
}

function formatDate(value: Date): string {
  const localMidnight = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0;
  const utcMidnight =
    value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0;
  const useUtc = utcMidnight && !localMidnight;
  const year = useUtc ? value.getUTCFullYear() : value.getFullYear();
  const month = (useUtc ? value.getUTCMonth() : value.getMonth()) + 1;
  const day = useUtc ? value.getUTCDate() : value.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 单元格统一成导入侧可比的字符串。整数不用科学计数法，3 位以内的小数去掉二进制噪声。 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    const quantized = Math.round(value * 1000) / 1000;
    if (Math.abs(value - quantized) < 1e-9) return String(quantized);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return formatDate(value);
  return String(value).trim();
}

function normalizeRows(rows: readonly (readonly unknown[])[]): string[][] {
  return rows
    .map((row) => Array.from(row, cellToString))
    .filter((row) => row.some((cell) => cell !== ''));
}

/**
 * 读用户选的文件。`.xlsx` 走 Excel；`.csv`（以及 Excel 另存的 CSV）走原有 CSV 解析。
 * 旧版 `.xls` 不是 zip 包，这里打不开。
 */
export async function readTableFile(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || file.type === 'text/csv' || file.type === 'application/csv') {
    return parseCsv(await file.text());
  }
  if (name.endsWith('.xls') && !name.endsWith('.xlsx') && !name.endsWith('.xlsm')) {
    throw new Error('不支持旧版 .xls，请在 Excel 里另存为 .xlsx，或改存 CSV');
  }
  if (!name.endsWith('.xlsx') && !name.endsWith('.xlsm')) {
    throw new Error('只支持 Excel（.xlsx）或 CSV 文件');
  }
  try {
    const rows = await readSheet(await file.arrayBuffer());
    return normalizeRows(rows);
  } catch {
    throw new Error('这个 Excel 打不开，请确认是 .xlsx 工作簿');
  }
}

export { XLSX_MIME };
