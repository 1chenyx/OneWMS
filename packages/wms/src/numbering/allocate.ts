import type { WmsWorkspace } from '../wms.js';
import {
  compilePattern,
  isNumberPlace,
  nextFromExisting,
  NUMBERING_PLACES,
  readNumbering,
  RESET_LABEL,
  type NumberPlaceId,
  type ResetScope,
} from './pattern.js';

const ORDER_PLACES = new Set<NumberPlaceId>([
  'order.in',
  'order.out',
  'order.asn',
  'order.return.in',
  'order.return.out',
]);

/** 这个位置已经用过的编号。同一张表上的号一起看，避免两条规则发出同一个号。 */
export function codesFor(ws: WmsWorkspace, place: NumberPlaceId): string[] {
  if (ORDER_PLACES.has(place)) return ws.orders.list().map((order) => order.orderNo);
  switch (place) {
    case 'picking':
      return ws.pickings.list().map((row) => row.pickingNo);
    case 'wave':
      return ws.waves.list().map((row) => row.waveNo);
    case 'stocktake':
      return ws.stocktakes.list().map((row) => row.stocktakeNo);
    case 'transfer':
      return ws.transfers.list().map((row) => row.transferNo);
    case 'scrap':
      return ws.scraps.list().map((row) => row.scrapNo);
    case 'sku':
      return ws.skus.list().map((row) => row.skuCode);
    case 'partner.supplier':
    case 'partner.customer':
      return ws.partners.list().map((row) => row.partnerCode);
    case 'location':
      return ws.locations.list().map((row) => row.locationCode);
    case 'warehouse':
      return ws.warehouses.list().map((row) => row.warehouseCode);
    case 'lpn':
      return ws.lpns.list().map((row) => row.lpnCode);
    default:
      return [];
  }
}

function codesOf(ws: WmsWorkspace): (place: NumberPlaceId) => string[] {
  const cache = new Map<string, string[]>();
  return (place) => {
    const key = ORDER_PLACES.has(place)
      ? 'order'
      : place === 'partner.supplier' || place === 'partner.customer'
        ? 'partner'
        : place;
    const hit = cache.get(key);
    if (hit) return hit;
    const codes = codesFor(ws, place);
    cache.set(key, codes);
    return codes;
  };
}

/** 传了编号就用传入的（去掉两端空白）。空着则按当前规则取下一号。调用方需先 sync。 */
export function allocateCode(ws: WmsWorkspace, place: NumberPlaceId, raw?: unknown, now = new Date()): string {
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (given) return given;
  const source = readNumbering(ws.profile.getSnapshot().modules['core.wms']?.settings).byId[place].pattern;
  const compiled = compilePattern(source);
  if (!compiled.ok) throw new Error(`TOOL_REJECTED: ${compiled.error}`);
  try {
    return nextFromExisting(compiled.pattern, codesFor(ws, place), now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TOOL_REJECTED: ${message}`);
  }
}

export interface NumberingPlaceView {
  place: NumberPlaceId;
  label: string;
  group: '作业' | '档案';
  pattern: string;
  configured: string | null;
  invalid: string | null;
  reset: ResetScope;
  resetLabel: string;
  next: string;
}

export interface NumberingView {
  stored: boolean;
  patchOp: 'add' | 'replace';
  path: '/modules/core.wms/settings/numbering';
  /** 完整对象，可直接作为 profile.propose 的 value。试算时只替换那一个位置。 */
  numbering: Record<string, string>;
  places: NumberingPlaceView[];
}

function rejectPlace(place: string): never {
  throw new Error(`TOOL_REJECTED: 没有这个编号位置：${place}`);
}

/** 当前规则下各处的下一号。place 省略则全部。调用方需先 sync。 */
export function describeNumbering(ws: WmsWorkspace, place?: string, now = new Date()): NumberingView {
  const raw = place?.trim() ?? '';
  if (raw && !isNumberPlace(raw)) rejectPlace(raw);
  return buildView(ws, isNumberPlace(raw) ? raw : undefined, undefined, now);
}

/** 用一条还没保存的模板试算下一号。模板不合法会拒绝。 */
export function previewCandidate(ws: WmsWorkspace, place: string, pattern: string, now = new Date()): NumberingView {
  const id = place.trim();
  if (!isNumberPlace(id)) rejectPlace(id);
  const compiled = compilePattern(pattern);
  if (!compiled.ok) throw new Error(`TOOL_REJECTED: ${compiled.error}`);
  return buildView(ws, id, compiled.pattern.source, now);
}

function buildView(ws: WmsWorkspace, filter: NumberPlaceId | undefined, trial: string | undefined, now: Date): NumberingView {
  const rules = readNumbering(ws.profile.getSnapshot().modules['core.wms']?.settings);
  const codes = codesOf(ws);
  const numbering: Record<string, string> = {};
  const places: NumberingPlaceView[] = [];
  for (const item of NUMBERING_PLACES) {
    const resolved = rules.byId[item.id];
    const useTrial = filter === item.id && trial !== undefined;
    const source = useTrial ? trial : resolved.pattern;
    const compiled = compilePattern(source);
    if (!compiled.ok) throw new Error(`TOOL_REJECTED: ${compiled.error}`);
    numbering[item.id] = compiled.pattern.source;
    if (filter && item.id !== filter) continue;
    places.push({
      place: item.id,
      label: item.label,
      group: item.group,
      pattern: compiled.pattern.source,
      configured: useTrial ? trial : resolved.configured,
      invalid: useTrial ? null : resolved.invalid,
      reset: compiled.pattern.reset,
      resetLabel: RESET_LABEL[compiled.pattern.reset],
      next: nextFromExisting(compiled.pattern, codes(item.id), now),
    });
  }
  return {
    stored: rules.stored,
    patchOp: rules.patchOp,
    path: '/modules/core.wms/settings/numbering',
    numbering,
    places,
  };
}
