import type { FieldSnapshot } from '../api.js';

/** 收货向导用的单据行。库位以单据为准，手机不改。 */
export interface ReceiveOrderLine {
  skuCode: string;
  name: string;
  quantity: number;
  unit: string | null;
  locationCode: string;
  warehouseCode: string | null;
  batchNo: string;
  batchExpiryDate: string | null;
  serialTracked: boolean;
  serials?: readonly string[];
}

export interface ReceiveOrder {
  orderNo: string;
  state: string;
  partnerCode: string | null;
  partnerName: string | null;
  expectedAt: string | null;
  returnOfOrderNo: string | null;
  lines: ReceiveOrderLine[];
}

/**
 * 打开向导时抄下批次和效期。库位不放这里，提交时再读单据行。
 * key 用打开时的货品、库位、批次，改批次之后仍能对上原行。
 */
export interface ReceiveLineDraft {
  key: string;
  qty: number;
  serials: string[];
  batchNo: string;
  batchExpiryDate?: string;
}

export interface ReviseLineBody {
  skuCode: string;
  locationCode: string;
  batchNo: string;
  quantity: number;
  batchExpiryDate?: string;
  serials?: string[];
}

export interface TransitionLineBody {
  skuCode: string;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

export type ReceiveStep =
  | { kind: 'location'; lineIndex: number | null }
  | { kind: 'sku'; lineIndex: number }
  | { kind: 'qty'; lineIndex: number }
  | { kind: 'serial'; lineIndex: number }
  | { kind: 'batch'; lineIndex: number }
  | { kind: 'confirm' };

const PAGE_LIMIT = 50;

export function lineKey(line: { skuCode: string; locationCode: string; batchNo: string }): string {
  return `${line.skuCode}\u001f${line.locationCode}\u001f${line.batchNo}`;
}

export function receiveListPath(warehouseCode: string | null, offset: number): string {
  const params = new URLSearchParams();
  params.set('direction', 'in');
  params.set('state', 'created,announced');
  params.set('sort', 'updatedAtAsc');
  params.set('limit', String(PAGE_LIMIT));
  params.set('offset', String(offset));
  if (warehouseCode) params.set('warehouseCode', warehouseCode);
  return `/api/orders?${params.toString()}`;
}

export function draftsFromOrder(order: ReceiveOrder): ReceiveLineDraft[] {
  return order.lines.map((line) => ({
    key: lineKey(line),
    qty: line.quantity,
    serials: [...(line.serials ?? [])],
    batchNo: line.batchNo,
    ...(line.batchExpiryDate ? { batchExpiryDate: line.batchExpiryDate } : {}),
  }));
}

/** 恢复时按原行键合并。对不上的行用单据上的数量和批次。 */
export function mergeDrafts(order: ReceiveOrder, saved: ReceiveLineDraft[] | null): ReceiveLineDraft[] {
  const fresh = draftsFromOrder(order);
  if (!saved) return fresh;
  return fresh.map((line) => {
    const hit = saved.find((row) => row.key === line.key);
    if (!hit) return line;
    const next: ReceiveLineDraft = {
      key: line.key,
      qty: hit.qty,
      serials: [...hit.serials],
      batchNo: hit.batchNo,
    };
    if (hit.batchExpiryDate) next.batchExpiryDate = hit.batchExpiryDate;
    return next;
  });
}

export function sameSerials(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/** 非序列号的数量改动不进修订。短收走转移。 */
export function lineChanged(line: ReceiveOrderLine, draft: ReceiveLineDraft): boolean {
  if (draft.batchNo !== line.batchNo) return true;
  if ((draft.batchExpiryDate ?? null) !== (line.batchExpiryDate ?? null)) return true;
  if (!line.serialTracked) return false;
  if (draft.qty !== line.quantity) return true;
  return !sameSerials(draft.serials, line.serials ?? []);
}

export function buildRevise(order: ReceiveOrder, drafts: ReceiveLineDraft[]): { lines: ReviseLineBody[] } | null {
  if (drafts.length !== order.lines.length) return null;
  if (!order.lines.some((line, index) => lineChanged(line, drafts[index]!))) return null;
  return {
    lines: order.lines.map((line, index) => {
      const draft = drafts[index]!;
      const body: ReviseLineBody = {
        skuCode: line.skuCode,
        locationCode: line.locationCode,
        batchNo: draft.batchNo,
        quantity: line.serialTracked ? draft.qty : line.quantity,
      };
      const entered = draft.batchExpiryDate?.trim() ?? '';
      if (entered !== '') body.batchExpiryDate = entered;
      else if (line.batchExpiryDate) body.batchExpiryDate = line.batchExpiryDate;
      if (line.serialTracked && (draft.qty !== line.quantity || !sameSerials(draft.serials, line.serials ?? []))) {
        body.serials = [...draft.serials];
      }
      return body;
    }),
  };
}

/** 只有非序列号短收或跳过才带 lines。纯序列号改量靠修订后的订单数量入账。 */
export function buildTransition(
  order: ReceiveOrder,
  drafts: ReceiveLineDraft[],
): { to: 'received'; lines?: TransitionLineBody[] } {
  const short = order.lines.some((line, index) => !line.serialTracked && drafts[index]!.qty !== line.quantity);
  if (!short) return { to: 'received' };
  return {
    to: 'received',
    lines: order.lines.map((line, index) => ({
      skuCode: line.skuCode,
      locationCode: line.locationCode,
      batchNo: drafts[index]!.batchNo,
      quantity: drafts[index]!.qty,
    })),
  };
}

export function reviseLanded(order: ReceiveOrder, payload: { lines: ReviseLineBody[] }): boolean {
  if (order.lines.length !== payload.lines.length) return false;
  const used = new Set<number>();
  return payload.lines.every((body) => {
    const index = order.lines.findIndex((row, rowIndex) => {
      if (used.has(rowIndex)) return false;
      if (row.skuCode !== body.skuCode || row.locationCode !== body.locationCode || row.batchNo !== body.batchNo) return false;
      if (row.quantity !== body.quantity) return false;
      if (Object.hasOwn(body, 'batchExpiryDate')) {
        if ((row.batchExpiryDate ?? null) !== body.batchExpiryDate) return false;
      } else if (row.batchExpiryDate !== null) {
        return false;
      }
      if (Object.hasOwn(body, 'serials') && !sameSerials(row.serials ?? [], body.serials ?? [])) return false;
      return true;
    });
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

export function transitionLanded(order: { state: string }): boolean {
  return order.state !== 'created' && order.state !== 'announced';
}

export function receiveSteps(
  order: ReceiveOrder,
  drafts: ReceiveLineDraft[],
  opts: { serialModule: boolean },
): ReceiveStep[] {
  if (order.lines.length === 0) return [{ kind: 'confirm' }];
  const steps: ReceiveStep[] = [];
  const shared = order.lines.every((line) => line.locationCode === order.lines[0]!.locationCode);
  if (shared) steps.push({ kind: 'location', lineIndex: null });
  order.lines.forEach((line, index) => {
    const draft = drafts[index];
    const qty = draft?.qty ?? line.quantity;
    if (!shared) steps.push({ kind: 'location', lineIndex: index });
    steps.push({ kind: 'sku', lineIndex: index });
    steps.push({ kind: 'qty', lineIndex: index });
    if (qty === 0) return;
    if (opts.serialModule && line.serialTracked) steps.push({ kind: 'serial', lineIndex: index });
    steps.push({ kind: 'batch', lineIndex: index });
  });
  steps.push({ kind: 'confirm' });
  return steps;
}

export function stepToken(step: ReceiveStep): string {
  if (step.kind === 'confirm') return 'confirm';
  if (step.kind === 'location' && step.lineIndex === null) return 'location';
  return `${step.kind}:${step.lineIndex}`;
}

export function stepFromToken(token: string, steps: ReceiveStep[]): ReceiveStep {
  return steps.find((step) => stepToken(step) === token) ?? steps[0]!;
}

export function nextStep(steps: ReceiveStep[], current: ReceiveStep): ReceiveStep {
  const index = steps.findIndex((step) => stepToken(step) === stepToken(current));
  if (index < 0) return steps[0]!;
  return steps[Math.min(index + 1, steps.length - 1)]!;
}

export function prevStep(steps: ReceiveStep[], current: ReceiveStep): ReceiveStep | null {
  const index = steps.findIndex((step) => stepToken(step) === stepToken(current));
  if (index <= 0) return null;
  return steps[index - 1]!;
}

export function orderUnassigned(order: { lines: { warehouseCode: string | null }[] }): boolean {
  return order.lines.length > 0 && order.lines.every((line) => line.warehouseCode === null);
}

export function inboundStateLabel(snapshot: FieldSnapshot | null, state: string): string {
  return snapshot?.workflows?.inbound?.states?.find((item) => item.id === state)?.label ?? state;
}

export function doneHint(opts: { qcModule: boolean; qcScreen: boolean; putawayModule: boolean }): string {
  if (opts.qcModule && opts.qcScreen) return '下一跳是质检';
  if (opts.qcModule) return '先在电脑上质检';
  if (opts.putawayModule) return '下一跳是上架';
  return '到电脑上点完成';
}

/** 上架屏没开时不给按钮，避免走进还没做的向导。 */
export function showPutawayButton(opts: { putawayModule: boolean; qcModule: boolean; putawayScreen: boolean }): boolean {
  return opts.putawayModule && !opts.qcModule && opts.putawayScreen;
}

export function locationExpected(order: ReceiveOrder, step: ReceiveStep): string {
  if (step.kind !== 'location') return '';
  const index = step.lineIndex ?? 0;
  return order.lines[index]?.locationCode ?? '';
}

export function checkLocation(
  hit: { locationCode: string; warehouseCode: string | null } | null,
  expected: string,
  warehouseCode: string | null,
): string | null {
  if (!hit) return '没有这个库位';
  if (warehouseCode && hit.warehouseCode && hit.warehouseCode !== warehouseCode) return '库位不在当前仓库';
  if (hit.locationCode !== expected) return '库位不是这行的';
  return null;
}

export function checkSku(hit: { skuCode: string; status?: string } | null, expected: string): string | null {
  if (!hit) return '没有这个货';
  if (hit.status === 'archived') return '已停用';
  if (hit.skuCode !== expected) return '不是这张单上的';
  return null;
}

export function serialQtyBlocked(line: ReceiveOrderLine): boolean {
  return line.serialTracked && !Number.isInteger(line.quantity);
}

export function commitQty(
  line: ReceiveOrderLine,
  raw: string,
  partial: boolean,
): { ok: true; qty: number } | { ok: false; message: string | null } {
  if (serialQtyBlocked(line)) return { ok: false, message: 'WMS_SERIAL_COUNT' };
  if (!partial) return { ok: true, qty: line.quantity };
  const text = raw.trim();
  if (!text) return { ok: false, message: null };
  if (line.serialTracked) {
    if (!/^\d+$/.test(text)) return { ok: false, message: '数量不对' };
    const qty = Number(text);
    if (qty <= 0) return { ok: false, message: '数量不对' };
    if (qty > line.quantity) return { ok: false, message: '超过本行数量' };
    return { ok: true, qty };
  }
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return { ok: false, message: '数量不对' };
  const qty = Number(text);
  if (qty > line.quantity) return { ok: false, message: '超过本行数量' };
  return { ok: true, qty };
}

export function pushSerial(
  line: ReceiveOrderLine,
  draft: ReceiveLineDraft,
  progress: readonly string[],
  raw: string,
): { ok: true; progress: string[] } | { ok: false; message: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: null };
  if (progress.length > 0 && progress[progress.length - 1] === trimmed) return { ok: false, message: '刚扫过' };
  const verify = (line.serials?.length ?? 0) > 0 && draft.qty === line.quantity;
  if (progress.includes(trimmed)) return { ok: false, message: '刚扫过' };
  if (progress.length >= draft.qty) return { ok: false, message: '超过本行数量' };
  if (verify && !(line.serials ?? []).includes(trimmed)) return { ok: false, message: '不是这张单上的' };
  return { ok: true, progress: [...progress, trimmed] };
}

export function readReceiveOrder(body: unknown): ReceiveOrder | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  if (typeof rec.orderNo !== 'string' || typeof rec.state !== 'string' || !Array.isArray(rec.lines)) return null;
  const lines: ReceiveOrderLine[] = [];
  for (const item of rec.lines) {
    const line = readLine(item);
    if (!line) return null;
    lines.push(line);
  }
  return {
    orderNo: rec.orderNo,
    state: rec.state,
    partnerCode: typeof rec.partnerCode === 'string' ? rec.partnerCode : null,
    partnerName: typeof rec.partnerName === 'string' ? rec.partnerName : null,
    expectedAt: typeof rec.expectedAt === 'string' ? rec.expectedAt : null,
    returnOfOrderNo: typeof rec.returnOfOrderNo === 'string' ? rec.returnOfOrderNo : null,
    lines,
  };
}

export function readReceivePage(body: unknown): { hasMore: boolean; rows: ReceiveOrder[] } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as { hasMore?: unknown; rows?: unknown };
  if (!Array.isArray(rec.rows)) return null;
  const rows: ReceiveOrder[] = [];
  for (const item of rec.rows) {
    const order = readReceiveOrder(item);
    if (!order) return null;
    rows.push(order);
  }
  return { hasMore: rec.hasMore === true, rows };
}

export function readWarehouses(body: unknown): { warehouseCode: string; name: string }[] {
  if (!Array.isArray(body)) return [];
  const rows: { warehouseCode: string; name: string }[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { warehouseCode?: unknown; name?: unknown };
    if (typeof rec.warehouseCode !== 'string') continue;
    rows.push({ warehouseCode: rec.warehouseCode, name: typeof rec.name === 'string' ? rec.name : rec.warehouseCode });
  }
  return rows;
}

function readLine(value: unknown): ReceiveOrderLine | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.skuCode !== 'string' || typeof rec.locationCode !== 'string' || typeof rec.batchNo !== 'string') return null;
  if (typeof rec.quantity !== 'number') return null;
  const serials = Array.isArray(rec.serials) ? rec.serials.filter((item): item is string => typeof item === 'string') : [];
  return {
    skuCode: rec.skuCode,
    name: typeof rec.name === 'string' ? rec.name : '',
    quantity: rec.quantity,
    unit: typeof rec.unit === 'string' ? rec.unit : null,
    locationCode: rec.locationCode,
    warehouseCode: typeof rec.warehouseCode === 'string' ? rec.warehouseCode : null,
    batchNo: rec.batchNo,
    batchExpiryDate: typeof rec.batchExpiryDate === 'string' ? rec.batchExpiryDate : null,
    serialTracked: rec.serialTracked === true,
    ...(serials.length > 0 ? { serials } : {}),
  };
}
