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

/**
 * 这个工作区启用了哪些分类。
 * 不是数组（老库没这个键、或值写坏了）→ 八种都启用。
 * 是数组 → 只留合法且不重复的编码，按词表顺序。空数组、或全是非法项，表示一种都不启用。
 */
export function readEnabledZoneKinds(raw: unknown): ZoneKind[] {
  if (!Array.isArray(raw)) return ZONE_KINDS.map((kind) => kind.id);
  const picked = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && KIND_IDS.has(item)) picked.add(item);
  }
  return ZONE_KINDS.map((kind) => kind.id).filter((id) => picked.has(id));
}

export function zoneKindLabel(kind: string): string {
  return ZONE_KINDS.find((item) => item.id === kind)?.label ?? kind;
}

/** 库区对单据的限制。移库、调整、盘点不在这里。 */
export type ZoneUse = 'receive' | 'returnIn' | 'putaway' | 'issue' | 'returnOut';

export const ZONE_USE_LABEL: Record<ZoneUse, string> = {
  receive: '入库收货',
  returnIn: '客退收货',
  putaway: '上架',
  issue: '拣货发货',
  returnOut: '退供发货',
};

/** 这个分类允许哪些单据动作。空数组 = 只能移库放进来。 */
export const ZONE_KIND_USES: Record<ZoneKind, readonly ZoneUse[]> = {
  receiving: ['receive'],
  qc: [],
  storage: ['putaway'],
  picking: ['putaway', 'issue'],
  staging: [],
  shipping: ['issue'],
  return: ['returnIn', 'returnOut'],
  defective: ['returnOut'],
};

export function zoneKindAllows(kind: string, use: ZoneUse): boolean {
  return isZoneKind(kind) && ZONE_KIND_USES[kind].includes(use);
}

/** 界面和报错里的一句话。 */
export function zoneKindUseText(kind: string): string {
  if (!isZoneKind(kind)) return '分类不在名单里';
  const uses = ZONE_KIND_USES[kind];
  if (uses.length === 0) return '只能移库放进来，不能收货、上架或发货';
  return `可以${uses.map((use) => ZONE_USE_LABEL[use]).join('、')}`;
}

/** 工具说明里的分类词表。 */
export function zoneKindHint(): string {
  return ZONE_KINDS.map((kind) => `${kind.id} ${kind.label}`).join('、');
}

/** 给工具说明的整段规则。未分区不限制。关掉的分类也不再限制。 */
export function zoneKindRuleText(): string {
  return '库位划进库区后按分类限制：收货区只能入库收货；存货区只能上架；拣货区可以上架和拣货发货；发货区只能拣货发货；退货区只能客退收货和退供发货；不良品区只能退供发货；质检区和暂存区只能移库放进来。未分区和 DEFAULT 不限制。移库、库存调整、盘点不看分类。这个工作区启用哪些分类看 /modules/module.zone/settings/enabledKinds，缺省八种都启用，空数组表示一种都不启用。没启用的分类不能新建；已经建好的库区还在，但不再限制作业。';
}
