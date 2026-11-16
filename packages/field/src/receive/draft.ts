import type { KeyValueStore } from '../prefs.js';
import type { ReceiveLineDraft } from './model.js';

/** 跟 onewms.field.v1 分开。健康检查重写连接记录时不能把草稿清掉。 */
export const RECEIVE_DRAFT_KEY = 'onewms.field.receiveDraft.v1';

export interface ReceiveDraftRecord {
  kind: 'receive';
  docNo: string;
  step: string;
  lines: ReceiveLineDraft[];
  updatedAt: string;
}

export function loadReceiveDraft(storage: KeyValueStore): ReceiveDraftRecord | null {
  const raw = storage.getItem(RECEIVE_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReceiveDraftRecord>;
    if (parsed.kind !== 'receive' || typeof parsed.docNo !== 'string' || !Array.isArray(parsed.lines)) return null;
    const lines: ReceiveLineDraft[] = [];
    for (const item of parsed.lines) {
      if (!item || typeof item !== 'object') return null;
      const line = item as Partial<ReceiveLineDraft>;
      if (typeof line.key !== 'string' || typeof line.qty !== 'number' || typeof line.batchNo !== 'string') return null;
      if (!Array.isArray(line.serials) || line.serials.some((serial) => typeof serial !== 'string')) return null;
      const next: ReceiveLineDraft = {
        key: line.key,
        qty: line.qty,
        serials: [...line.serials],
        batchNo: line.batchNo,
      };
      if (typeof line.batchExpiryDate === 'string' && line.batchExpiryDate) next.batchExpiryDate = line.batchExpiryDate;
      lines.push(next);
    }
    return {
      kind: 'receive',
      docNo: parsed.docNo,
      step: typeof parsed.step === 'string' ? parsed.step : 'location',
      lines,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function saveReceiveDraft(storage: KeyValueStore, draft: ReceiveDraftRecord): void {
  storage.setItem(RECEIVE_DRAFT_KEY, JSON.stringify(draft));
}

export function clearReceiveDraft(storage: KeyValueStore): void {
  storage.setItem(RECEIVE_DRAFT_KEY, '');
}
