import type { KeyValueStore } from '../prefs.js';

/** 和收货草稿分开，也和连接记录分开。 */
export const PUTAWAY_DRAFT_KEY = 'onewms.field.putawayDraft.v1';

export interface PutawayDraftRecord {
  kind: 'putaway';
  docNo: string;
  step: string;
  /** 与单据行对齐。null = 留在原位，缺省表示还没定。 */
  targets: (string | null)[];
  updatedAt: string;
}

export function loadPutawayDraft(storage: KeyValueStore): PutawayDraftRecord | null {
  const raw = storage.getItem(PUTAWAY_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PutawayDraftRecord>;
    if (parsed.kind !== 'putaway' || typeof parsed.docNo !== 'string' || !Array.isArray(parsed.targets)) return null;
    if (parsed.targets.some((item) => item !== null && typeof item !== 'string')) return null;
    return {
      kind: 'putaway',
      docNo: parsed.docNo,
      step: typeof parsed.step === 'string' ? parsed.step : 'source:0',
      targets: parsed.targets.map((item) => (typeof item === 'string' ? item : null)),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function savePutawayDraft(storage: KeyValueStore, draft: PutawayDraftRecord): void {
  storage.setItem(PUTAWAY_DRAFT_KEY, JSON.stringify(draft));
}

export function clearPutawayDraft(storage: KeyValueStore): void {
  storage.setItem(PUTAWAY_DRAFT_KEY, '');
}
