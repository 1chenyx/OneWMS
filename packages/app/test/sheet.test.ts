import { describe, expect, it } from 'vitest';
import { buildXlsxBlob, readTableFile } from '../src/lib/sheet';

describe('Excel 读写', () => {
  it('xlsx 往返：表头、文本、整数和小数都还在', async () => {
    const blob = await buildXlsxBlob('SKU', ['编码', '名称', '数量'], [['A-1', '螺丝', 2.5]]);
    const file = new File([await blob.arrayBuffer()], 'sku.xlsx');
    expect(await readTableFile(file)).toEqual([
      ['编码', '名称', '数量'],
      ['A-1', '螺丝', '2.5'],
    ]);
  });

  it('导入仍认 CSV（含 BOM）', async () => {
    const file = new File(['\uFEFF编码,名称\r\nA-1,螺丝\r\n'], 'old.csv', { type: 'text/csv' });
    expect(await readTableFile(file)).toEqual([
      ['编码', '名称'],
      ['A-1', '螺丝'],
    ]);
  });

  it('不认旧版 xls，也不认随便一个扩展名', async () => {
    await expect(readTableFile(new File(['x'], 'a.xls'))).rejects.toThrow(/\.xls/);
    await expect(readTableFile(new File(['x'], 'a.txt'))).rejects.toThrow(/Excel/);
  });
});
