import type { ChatAttachmentPayload } from '../api/client';
import { readTableFile } from '../lib/sheet';

/** 一次对话最多带上的文件数 */
export const MAX_CHAT_FILES = 3;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_COLS = 40;
const MAX_CELL = 200;
const MAX_TEXT = 40_000;

const TEXT_EXT = ['.txt', '.text', '.md', '.log'];

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `att-${crypto.randomUUID().slice(0, 8)}`;
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clipCell(value: string): string {
  return value.trim().slice(0, MAX_CELL);
}

/**
 * 把用户选的文件收成对话附件。
 * Excel / CSV 变成表头加行；文本保持原文。过大的部分截断，服务端还会再收一次口。
 */
export async function parseChatFile(file: File): Promise<ChatAttachmentPayload> {
  if (file.size > MAX_BYTES) throw new Error('文件超过 5MB，请拆开再导入');
  const name = file.name?.trim() || '未命名';
  const lower = name.toLowerCase();
  const spreadsheet =
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv') ||
    file.type === 'text/csv' ||
    file.type === 'application/csv';

  if (spreadsheet) {
    const table = await readTableFile(file);
    if (table.length === 0) throw new Error(`${name} 是空的`);
    const width = Math.min(
      MAX_COLS,
      table.reduce((max, row) => Math.max(max, row.length), 0),
    );
    const headers = (table[0] ?? []).slice(0, width).map(clipCell);
    if (headers.every((cell) => cell === '')) throw new Error(`${name} 没有表头`);
    const rows = table.slice(1, 1 + MAX_ROWS).map((row) => headers.map((_, index) => clipCell(row[index] ?? '')));
    return { id: newId(), name, kind: 'table', headers, rows, text: '' };
  }

  const textFile = TEXT_EXT.some((ext) => lower.endsWith(ext)) || file.type.startsWith('text/');
  if (textFile) {
    const text = (await file.text()).replace(/^\uFEFF/, '').slice(0, MAX_TEXT);
    if (!text.trim()) throw new Error(`${name} 是空的`);
    return { id: newId(), name, kind: 'text', headers: [], rows: [], text };
  }

  throw new Error('只支持 Excel（.xlsx）、CSV 或文本文件（.txt）');
}
