/**
 * 库区分类。编码进事件，名称给界面。
 * 本文件零依赖，前端可以按别名直接引用。
 */

export const ZONE_KINDS = [
  { id: 'receiving', label: '收货区' },
  { id: 'qc', label: '质检区' },
  { id: 'storage', label: '存货区' },
  { id: 'picking', label: '拣货区' },
  { id: 'staging', label: '暂存区' },
  { id: 'shipping', label: '发货区' },
  { id: 'return', label: '退货区' },
  { id: 'defective', label: '不良品区' },
] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number]['id'];

const KIND_IDS = new Set<string>(ZONE_KINDS.map((kind) => kind.id));

export function isZoneKind(value: string): value is ZoneKind {
  return KIND_IDS.has(value);
}

export function zoneKindLabel(kind: string): string {
  return ZONE_KINDS.find((item) => item.id === kind)?.label ?? kind;
}

/** 工具说明里的分类词表。 */
export function zoneKindHint(): string {
  return ZONE_KINDS.map((kind) => `${kind.id} ${kind.label}`).join('、');
}
