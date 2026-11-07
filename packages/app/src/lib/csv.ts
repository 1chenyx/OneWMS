/**
 * CSV 编解码——导入兼容用。导出已经改走 Excel（见 sheet.ts），
 * 这里留下是为了还能读以前的 CSV、以及 Excel「另存为 CSV」。
 *
 * 两个坑必须处理，否则从 Excel 存出来的 CSV 会乱码/串列：
 *  1. BOM：Excel 靠 UTF-8 BOM 识别编码，不加就按 GBK 解成乱码；
 *  2. 引号转义：字段内含逗号/引号/换行时整体加引号，内部引号翻倍。
 * 解析端对称：支持引号包裹、"" 转义、字段内换行、CRLF/LF 混排。
 */

/** UTF-8 BOM——导出时前置，Excel 才能正确识别中文 */
export const UTF8_BOM = '\uFEFF';

/** 单个字段转 CSV 安全文本 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行数组 → CSV 文本（含 BOM，可直接下载给 Excel 打开） */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))];
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

/** 触发浏览器下载（Blob + 临时 a 标签，用完即撤） */
export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 日期戳文件名后缀：20261106-2215 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * CSV 文本 → 二维字符串数组（含表头行）。
 * 逐字符状态机：引号内不认分隔符，"" 还原成一个引号，引号内允许换行。
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // CRLF：\n 交给下一轮的行结束分支
      if (src[i + 1] !== '\n') {
        row.push(cell);
        cell = '';
        rows.push(row);
        row = [];
      }
    } else if (ch === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  // 收尾：最后一个单元格/行（文件末尾无换行时）
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // 丢掉纯空行（Excel 存盘常带尾随空行）
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** 表头行 → 列名到列下标的映射（大小写/空白容错） */
export function headerIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}
