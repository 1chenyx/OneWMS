/**
 * 流程页和模块页的说法。
 * 名字和长说明以服务端目录为准。这里决定流程图上的方块、开关，以及模块卡片写什么。
 */

export type FlowLane = 'inbound' | 'outbound';

export interface ModulePresentation {
  name: string;
  line: string;
}

/** 流程图上的方块。带 moduleId 的是可开关步骤，关掉后箭头绕过它。 */
export interface FlowNodeDef {
  id: string;
  lane: FlowLane;
  label: string;
  moduleId?: string;
  /** 跟某个模块一起出现，但不在这个方块上再放一个开关 */
  toggle?: boolean;
}

/** 挂在已有方块上的开关，不新增方块。 */
export interface FlowTagDef {
  moduleId: string;
  lane: FlowLane;
  nodeId: string;
  label: string;
}

export interface CapabilityCardCopy {
  moduleId: string;
  /** page = 作业里多一个页面；action = 原来的页面上多一个动作 */
  group: 'page' | 'action';
  place: string;
  detail: string;
  onResult: string;
  offResult: string;
}

export const MODULE_PRESENT: Record<string, ModulePresentation> = {
  'module.asn': { name: '到货预报', line: '货没到可以先预报，到了再收' },
  'module.qc': { name: '质检', line: '收货之后必须质检，再上架' },
  'module.putaway': { name: '上架作业', line: '收货之后必须上架，再结束' },
  'module.wave': { name: '波次', line: '多张出库单合成一波，按库位一次拣完' },
  'module.picking': { name: '拣货', line: '出库先拣货，拣完是已拣货，再发货' },
  'module.review': { name: '复核', line: '拣完之后必须复核，再打包' },
  'module.pack': { name: '打包', line: '复核之后必须打包' },
  'module.load': { name: '装车', line: '发货前必须装车' },
  'module.reservation': { name: '拣货占用', line: '进入拣货时先占住可用量' },
  'module.partial': { name: '短收短发', line: '收货或发货可以按实数入账' },
  'module.reversal': { name: '单据冲销', line: '已收货、已发货仍可取消并回冲' },
  'module.return': { name: '退货', line: '按原单做客退或退供' },
  'module.warehouse': { name: '多仓', line: '库位可以划进不同仓库' },
  'module.serial': { name: '序列号', line: '需要一物一码的商品按号收发' },
  'module.lpn': { name: '托盘', line: '把库位上的货装托，整托移走' },
  'module.replenish': { name: '补货', line: '按安全库存缺口开入库单' },
  'core.wms': { name: '仓储基础', line: '入库和出库的基本步骤' },
  'core.ai': { name: 'AI 助手', line: '助手的人设和工具授权' },
  'core.memory': { name: 'AI 记忆', line: '对话里记住的偏好和约定' },
};

export const FLOW_NODES: readonly FlowNodeDef[] = [
  { id: 'created', lane: 'inbound', label: '建单' },
  { id: 'announced', lane: 'inbound', label: '预报', moduleId: 'module.asn' },
  { id: 'received', lane: 'inbound', label: '收货' },
  { id: 'inspected', lane: 'inbound', label: '质检', moduleId: 'module.qc' },
  { id: 'putaway', lane: 'inbound', label: '上架', moduleId: 'module.putaway' },
  { id: 'done', lane: 'inbound', label: '完成' },
  { id: 'created', lane: 'outbound', label: '建单' },
  { id: 'waved', lane: 'outbound', label: '波次', moduleId: 'module.wave' },
  { id: 'picking', lane: 'outbound', label: '拣货', moduleId: 'module.picking' },
  { id: 'picked', lane: 'outbound', label: '已拣货', moduleId: 'module.picking', toggle: false },
  { id: 'reviewed', lane: 'outbound', label: '复核', moduleId: 'module.review' },
  { id: 'packed', lane: 'outbound', label: '打包', moduleId: 'module.pack' },
  { id: 'loaded', lane: 'outbound', label: '装车', moduleId: 'module.load' },
  { id: 'shipped', lane: 'outbound', label: '发货' },
  { id: 'done', lane: 'outbound', label: '完成' },
];

export const FLOW_TAGS: readonly FlowTagDef[] = [
  { moduleId: 'module.partial', lane: 'inbound', nodeId: 'received', label: '按实数' },
  { moduleId: 'module.reversal', lane: 'inbound', nodeId: 'received', label: '可冲销' },
  { moduleId: 'module.reservation', lane: 'outbound', nodeId: 'picking', label: '占库存' },
  { moduleId: 'module.partial', lane: 'outbound', nodeId: 'shipped', label: '按实数' },
  { moduleId: 'module.reversal', lane: 'outbound', nodeId: 'shipped', label: '可冲销' },
];

const FLOW_RESULT: Record<string, { on: string; off: string }> = {
  'module.asn': { on: '打开后，收货前先预报', off: '关掉后，从建单直接到收货' },
  'module.qc': {
    on: '打开后，收货后必须先质检。质检在质检页做',
    off: '关掉后，收货后直接上架或结束。已经质检的单仍可继续',
  },
  'module.wave': {
    on: '打开后，建单后要把出库单组成波次。一波按库位一起拣。组波在波次页做',
    off: '关掉后，从建单直接拣货或发货。已经组波的单仍可继续',
  },
  'module.putaway': {
    on: '打开后，收货后必须先上架再结束。上架在上架页做',
    off: '关掉后，收完直接结束。已经上架的单仍可结束',
  },
  'module.picking': {
    on: '打开后，出库单进入拣货中。拣完关单后是已拣货，再到出库单发货。不能直接发货或完成',
    off: '关掉后，跳过拣货和已拣货。已经在拣货中的单仍可发货或取消，已经拣完的单仍可发货',
  },
  'module.review': {
    on: '打开后，发货前必须复核。复核在复核页做',
    off: '关掉后，跳过复核。已经复核的单仍可继续',
  },
  'module.pack': {
    on: '打开后，发货前必须打包。打包在打包页做',
    off: '关掉后，跳过打包。已经打包的单仍可继续',
  },
  'module.load': {
    on: '打开后，发货前必须装车。装车在装车页做',
    off: '关掉后，跳过装车。已经装车的单仍可发货',
  },
  'module.reservation': { on: '打开后，拣货时先占住这部分货', off: '关掉后，拣货不再占库存' },
  'module.partial': { on: '打开后，收货和发货可以按实数', off: '关掉后，收货和发货都按单上的数量' },
  'module.reversal': { on: '打开后，收货或发货之后可以取消并冲回库存', off: '关掉后，收货或发货之后不能再冲销' },
};

export const CAPABILITY_CARDS: readonly CapabilityCardCopy[] = [
  {
    moduleId: 'module.serial',
    group: 'page',
    place: '作业里会出现「序列号」',
    detail: '收发时要填写每一件的号',
    onResult: '打开后，作业里会出现序列号',
    offResult: '关掉后，作业里不再出现序列号',
  },
  {
    moduleId: 'module.lpn',
    group: 'page',
    place: '作业里会出现「托盘」',
    detail: '可以把库位上的货装托，整托移走',
    onResult: '打开后，作业里会出现托盘',
    offResult: '关掉后，作业里不再出现托盘',
  },
  {
    moduleId: 'module.warehouse',
    group: 'action',
    place: '库位页可以新建仓库，把库位划进去',
    detail: '',
    onResult: '打开后，库位页可以新建仓库，把库位划进去',
    offResult: '关掉后，不能再新建仓库或把库位划进仓库',
  },
  {
    moduleId: 'module.return',
    group: 'action',
    place: '出入库单可以按原单开客退或退供',
    detail: '',
    onResult: '打开后，出入库单可以按原单开客退或退供',
    offResult: '关掉后，不能再开新的退货单',
  },
  {
    moduleId: 'module.replenish',
    group: 'action',
    place: '库存偏低时，可以按缺口开一张入库单',
    detail: '',
    onResult: '打开后，库存偏低时可以按缺口开一张入库单',
    offResult: '关掉后，不能再按缺口开入库单',
  },
];

export function presentOf(id: string): ModulePresentation {
  return MODULE_PRESENT[id] ?? { name: id, line: '' };
}

export function oneLine(id: string, description: string): string {
  const known = MODULE_PRESENT[id]?.line;
  if (known) return known;
  const sentence = description.split(/[。！？]/)[0]?.trim();
  return sentence || '已安装的能力';
}

export function isFlowModule(id: string): boolean {
  return FLOW_NODES.some((node) => node.moduleId === id) || FLOW_TAGS.some((tag) => tag.moduleId === id);
}

export function capabilityCard(id: string): CapabilityCardCopy | undefined {
  return CAPABILITY_CARDS.find((item) => item.moduleId === id);
}

export function flowResult(moduleId: string, enabled: boolean): string {
  const row = FLOW_RESULT[moduleId];
  const line = row ? (enabled ? row.on : row.off) : enabled ? '打开这项' : '关掉这项';
  return `${line}。已经做完的单据不变。`;
}

export function capabilityResult(moduleId: string, enabled: boolean, name: string): string {
  const card = capabilityCard(moduleId);
  if (card) return `${enabled ? card.onResult : card.offResult}。已经做完的单据不变。`;
  return enabled
    ? `打开后，可以使用${name}。已经做完的单据不变。`
    : `关掉后，不再使用${name}。已经做完的单据不变。`;
}

export function laneTitle(lane: FlowLane): string {
  return lane === 'inbound' ? '入库' : '出库';
}

/** 影响报告里的模块 id、流程 key 换成页面上的叫法。对不上的原样留下。 */
export function humanizeImpact(text: string, nameOf: (id: string) => string): string {
  return text
    .replace(/\b(?:module|core)\.[A-Za-z0-9][A-Za-z0-9._-]*/g, (id) => {
      const name = nameOf(id);
      return name === id ? id : name;
    })
    .replaceAll('「inbound」', '「入库」')
    .replaceAll('「outbound」', '「出库」');
}
