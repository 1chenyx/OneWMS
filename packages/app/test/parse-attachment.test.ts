import { describe, expect, it } from 'vitest';
import { parseChatFile } from '../src/chat/parse-attachment';

describe('parseChatFile', () => {
  it('CSV 读成表头和数据行', async () => {
    const file = new File(['\uFEFF编码,名称\r\nA-1,螺丝\r\n'], 'sku.csv', { type: 'text/csv' });
    const parsed = await parseChatFile(file);
    expect(parsed.kind).toBe('table');
    expect(parsed.headers).toEqual(['编码', '名称']);
    expect(parsed.rows).toEqual([['A-1', '螺丝']]);
  });

  it('文本文件保留原文', async () => {
    const file = new File(['先入库再上架'], '说明.txt', { type: 'text/plain' });
    const parsed = await parseChatFile(file);
    expect(parsed).toMatchObject({ kind: 'text', name: '说明.txt', text: '先入库再上架' });
  });

  it('不认识的类型直接拒绝', async () => {
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    await expect(parseChatFile(file)).rejects.toThrow(/Excel/);
  });
});
