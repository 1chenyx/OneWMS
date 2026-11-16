import {
  lineKey,
  type ReceiveOrder,
  type ReceiveOrderLine,
} from '../receive/model.js';

/** 质检开着只等已质检。关掉之后已收货和已质检都还在，状态 id 不会因为关掉而消失。 */
export function putawayStates(qcOn: boolean): string {
  return qcOn ? 'inspected' : 'received,inspected';
}

export function putawayListPath(qcOn: boolean, warehouseCode: string | null, offset: number): string {
  const params = new URLSearchParams();
  params.set('direction', 'in');
  params.set('state', putawayStates(qcOn));
  params.set('sort', 'updatedAtAsc');
  params.set('limit', '50');
  params.set('offset', String(offset));
  if (warehouseCode) params.set('warehouseCode', warehouseCode);
  return `/api/orders?${params.toString()}`;
}

export interface PutawayTarget {
  skuCode: string;
  fromLocationCode: string;
  batchNo: string;
  toLocationCode: string;
}

/** null = 留在原位。和源库位相同也不生成移动。 */
export function buildPutawayBody(
  lines: ReceiveOrderLine[],
  targets: readonly (string | null)[],
): { targets?: PutawayTarget[] } {
  const body: PutawayTarget[] = [];
  lines.forEach((line, index) => {
    const to = targets[index];
    if (!to || to === line.locationCode) return;
    body.push({
      skuCode: line.skuCode,
      fromLocationCode: line.locationCode,
      batchNo: line.batchNo,
      toLocationCode: to,
    });
  });
  return body.length > 0 ? { targets: body } : {};
}

export function putawayLanded(order: { state: string }): boolean {
  return order.state !== 'received' && order.state !== 'inspected';
}

export function putawayLineKey(line: ReceiveOrderLine): string {
  return lineKey(line);
}

export type PutawayMoveStep = { kind: 'source' | 'sku' | 'target'; lineIndex: number } | { kind: 'confirm' };

export function putawayMoveSteps(order: ReceiveOrder): PutawayMoveStep[] {
  const steps: PutawayMoveStep[] = [];
  order.lines.forEach((_, index) => {
    steps.push({ kind: 'source', lineIndex: index });
    steps.push({ kind: 'sku', lineIndex: index });
    steps.push({ kind: 'target', lineIndex: index });
  });
  steps.push({ kind: 'confirm' });
  return steps;
}

export function putawayStepToken(step: PutawayMoveStep): string {
  if (step.kind === 'confirm') return 'confirm';
  return `${step.kind}:${step.lineIndex}`;
}

export function putawayStepFromToken(token: string, steps: PutawayMoveStep[]): PutawayMoveStep {
  return steps.find((step) => putawayStepToken(step) === token) ?? steps[0]!;
}

export function nextPutawayStep(steps: PutawayMoveStep[], current: PutawayMoveStep): PutawayMoveStep {
  const index = steps.findIndex((step) => putawayStepToken(step) === putawayStepToken(current));
  if (index < 0) return steps[0]!;
  return steps[Math.min(index + 1, steps.length - 1)]!;
}

export function prevPutawayStep(steps: PutawayMoveStep[], current: PutawayMoveStep): PutawayMoveStep | null {
  const index = steps.findIndex((step) => putawayStepToken(step) === putawayStepToken(current));
  if (index <= 0) return null;
  return steps[index - 1]!;
}

/** 目标库位和源库位一样，按留在原位，不写进 targets。 */
export function readTarget(
  hit: { locationCode: string; warehouseCode: string | null } | null,
  source: string,
  warehouseCode: string | null,
): { ok: true; toLocationCode: string | null } | { ok: false; message: string } {
  if (!hit) return { ok: false, message: '没有这个库位' };
  if (warehouseCode && hit.warehouseCode && hit.warehouseCode !== warehouseCode) {
    return { ok: false, message: '库位不在当前仓库' };
  }
  if (hit.locationCode === source) return { ok: true, toLocationCode: null };
  return { ok: true, toLocationCode: hit.locationCode };
}

export function readPutawayWarning(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const warning = (body as { warning?: unknown }).warning;
  return typeof warning === 'string' && warning.trim() !== '' ? warning : null;
}

export function orderOnPutawayList(order: { state: string }, qcOn: boolean): boolean {
  if (order.state === 'inspected') return true;
  return order.state === 'received' && !qcOn;
}
