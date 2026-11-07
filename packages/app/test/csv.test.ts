import { describe, it, expect } from 'vitest';
import { downloadCsv, headerIndex, parseCsv, toCsv, UTF8_BOM } from '../src/lib/csv';

/**
 * CSV 编解码单测——导出给 Excel 打开、导入把 Excel 存的文件读回来，
 * 两个方向都必须无损。重点盯三个真实坑：BOM、引号转义、字段内换行。
 */

describe('toCsv：导出侧', () => {
  it('前置 UTF-8 BOM（否则 Excel 打开中文乱码）', () => {
    const csv = toCsv(['编码', '名称'], [['A-1', '螺丝']]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('含逗号/引号/换行的字段整体加引号，内部引号翻倍', () => {
    const csv = toCsv(['a', 'b', 'c'], [['x,y', 'say "hi"', 'line1\nline2']]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('空值写成空串（不是 undefined/null 字面量）', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe(`${UTF8_BOM}a,b\r\n,\r\n`);
  });

  it('数字原样输出（安全库存 0 不能变成空）', () => {
    expect(toCsv(['n'], [[0]])).toContain('\r\n0\r\n');
  });

  it('行分隔用 CRLF，且文件以换行收尾', () => {
    const csv = toCsv(['a'], [['1'], ['2']]);
    expect(csv.slice(1)).toBe('a\r\n1\r\n2\r\n');
  });
});

describe('parseCsv：导入侧', () => {
  it('剥掉 BOM，按逗号/换行切分', () => {
    expect(parseCsv(`${UTF8_BOM}编码,名称\r\nA-1,螺丝\r\n`)).toEqual([
      ['编码', '名称'],
      ['A-1', '螺丝'],
    ]);
  });

  it('还原引号字段：逗号、翻倍引号、字段内换行', () => {
    const rows = parseCsv('a,b,c\n"x,y","say ""hi""","line1\nline2"\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x,y', 'say "hi"', 'line1\nline2']]);
  });

  it('LF / CRLF / 无尾换行 都能解析', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('丢掉纯空行（Excel 存盘常带尾随空行）', () => {
    expect(parseCsv('a,b\n1,2\n\n,,\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('空单元格保留位置（列不串位）', () => {
    expect(parseCsv('a,b,c\n1,,3\n')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });

  it('与 toCsv 往返无损', () => {
    const headers = ['编码', '名称', '条码', '安全库存'];
    const rows: unknown[][] = [
      ['A-1', '螺丝, M4', '6901234567892', 50],
      ['B-2', '带"引号"的品名', '', 0],
      ['C-3', '两行\n备注', 'X1', 5],
    ];
    expect(parseCsv(toCsv(headers, rows))).toEqual([
      headers,
      ...rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))),
    ]);
  });
});

describe('headerIndex：表头容错', () => {
  it('大小写与首尾空白不敏感，同名列取第一个', () => {
    const idx = headerIndex(['  SKUcode ', 'skucode', '名称']);
    expect(idx.get('skucode')).toBe(0);
    expect(idx.get('名称')).toBe(2);
    expect(idx.has('编码')).toBe(false);
  });

  it('空表头不占位', () => {
    expect(headerIndex(['', 'a']).get('a')).toBe(1);
  });
});

describe('downloadCsv：触发下载', () => {
  it('生成 a[download] 并点击，用完撤掉 DOM 与 objectURL', () => {
    const clicked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => {
      clicked.push('create');
      return 'blob:mock';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {
      clicked.push('revoke');
    }) as typeof URL.revokeObjectURL;

    const anchorClicks: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      anchorClicks.push(this.download);
    };

    try {
      downloadCsv('库存-20261106.csv', toCsv(['a'], [['1']]));
      expect(clicked).toEqual(['create', 'revoke']);
      expect(anchorClicks).toEqual(['库存-20261106.csv']);
      // 临时 a 标签不留在 DOM 里
      expect(document.querySelectorAll('a[download]').length).toBe(0);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
