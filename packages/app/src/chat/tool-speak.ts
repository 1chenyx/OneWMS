import type { ChatInvocation } from '../api/client';

/**
 * 把一次工具调用说成人话。
 * 对话里默认只露这一句；展开后才看补充说明和表格。用户不需要看到工具名和 JSON。
 */

export interface SpokenTool {
  /** 折叠条上的一句话 */
  title: string;
  /** 同类操作的短名，多条折叠在一起时用来概括 */
  action: string;
  /** 展开后的补充，不重复标题里已经说清的内容 */
  details: string[];
}

const ACTION: Record<string, string> = {
  'wms.sku.create': '创建商品',
  'wms.sku.update': '更新商品',
  'wms.sku.archive': '停用商品',
  'wms.sku.unarchive': '启用商品',
  'wms.sku.resolve': '识别条码',
  'wms.order.create': '开出入库单',
  'wms.order.transition': '推进单据',
  'wms.order.query': '查单据',
  'wms.order.putaway': '确认上架',
  'wms.order.conflict.list': '查看状态冲突',
  'wms.order.conflict.accept': '接受状态冲突',
  'wms.order.conflict.dismiss': '驳回状态冲突',
  'wms.inventory.adjust': '调整库存',
  'wms.inventory.move': '移库',
  'wms.inventory.hold': '冻结库存',
  'wms.inventory.release': '释放冻结',
  'wms.inventory.query': '查库存',
  'wms.inventory.holds': '查冻结',
  'wms.inventory.lowstock': '查低库存',
  'wms.inventory.expiring': '查临期',
  'wms.ledger.query': '查库存流水',
  'wms.location.create': '创建库位',
  'wms.location.update': '更新库位',
  'wms.location.list': '查库位',
  'wms.partner.create': '创建往来单位',
  'wms.partner.update': '更新往来单位',
  'wms.partner.list': '查往来单位',
  'wms.picking.create': '创建拣货单',
  'wms.picking.pick': '录入实拣',
  'wms.picking.close': '拣货关单',
  'wms.picking.cancel': '取消拣货单',
  'wms.picking.query': '查拣货单',
  'wms.stocktake.create': '创建盘点单',
  'wms.stocktake.count': '录入实盘',
  'wms.stocktake.close': '盘点关单',
  'wms.stocktake.cancel': '取消盘点单',
  'wms.stocktake.query': '查盘点单',
  'profile.propose': '起草配置变更',
  'memory.list': '查看记忆',
  'memory.save': '记下一条',
  'memory.forget': '忘掉一条记忆',
  'core.oplog.query': '查操作记录',
  'tools.load': '加载工具说明',
  'chat.attachment.read': '查看附件',
  'chat.attachment.apply': '按表格处理',
};

const FIELD: Record<string, string> = {
  skuCode: '编码',
  name: '名称',
  barcode: '条码',
  unit: '单位',
  reorderPoint: '安全库存',
  quantity: '数量',
  delta: '调整量',
  orderNo: '单号',
  direction: '方向',
  state: '状态',
  locationCode: '库位',
  fromLocationCode: '从',
  toLocationCode: '到',
  batchNo: '批次',
  batchExpiryDate: '效期',
  partnerCode: '往来单位',
  note: '备注',
  reason: '原因',
  total: '总量',
  lineCount: '行数',
  pickingNo: '拣货单',
  stocktakeNo: '盘点单',
  content: '内容',
  question: '问题',
  to: '目标状态',
  created: '新建',
  updated: '更新',
  skipped: '跳过',
  failedCount: '没做成',
};

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function textOf(args: Record<string, unknown>, payload: Record<string, unknown> | undefined, key: string): string | undefined {
  return str(payload?.[key]) ?? str(args[key]);
}

/** 去掉错误类名前缀，只留人能读的原因 */
export function humanError(raw: string): string {
  return raw
    .replace(/^[A-Za-z0-9_.]+Error:\s*/g, '')
    .replace(/^TOOL_REJECTED:\s*/, '')
    .trim();
}

function directionWord(v: string | undefined): string {
  if (v === 'in') return '入库';
  if (v === 'out') return '出库';
  return v ?? '';
}

function countSuffix(payload: unknown): string {
  if (Array.isArray(payload)) {
    return payload.length ? `，共 ${payload.length} 条` : '，没有记录';
  }
  const row = rec(payload);
  if (row && Array.isArray(row.rows)) {
    const total = typeof row.total === 'number' ? row.total : row.rows.length;
    return total ? `，共 ${total} 条` : '，没有记录';
  }
  if (row && typeof row.total === 'number' && Array.isArray(row.byLocation)) {
    return '';
  }
  return '';
}

function codeName(code: string | undefined, name: string | undefined): string {
  if (code && name) return `${code} ${name}`;
  return code || name || '';
}

function signed(n: unknown): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return n > 0 ? `+${n}` : String(n);
}

function applyTitle(payload: Record<string, unknown> | undefined): { title: string; details: string[] } {
  const action = str(payload?.action);
  const failedCount = typeof payload?.failedCount === 'number' ? payload.failedCount : 0;
  const failed = Array.isArray(payload?.failed) ? payload.failed : [];
  const failLines = failed.slice(0, 5).map((item) => {
    const row = rec(item);
    if (!row) return '';
    const where = typeof row.row === 'number' ? `第 ${row.row} 行` : str(row.orderNo) ? `单号 ${str(row.orderNo)}` : '有一处';
    const who = str(row.skuCode);
    const why = str(row.error) ?? '没做成';
    return `${where}${who ? ` ${who}` : ''}：${why}`;
  }).filter(Boolean);
  if (failedCount > failLines.length) failLines.push(`还有 ${failedCount - failLines.length} 处`);

  if (action === 'sku') {
    const created = typeof payload?.created === 'number' ? payload.created : 0;
    const updated = typeof payload?.updated === 'number' ? payload.updated : 0;
    let title = `按表格处理了商品：新建 ${created} 个，更新 ${updated} 个`;
    if (failedCount) title += `，${failedCount} 行没做成`;
    return { title, details: failLines };
  }
  if (action === 'orders') {
    const created = Array.isArray(payload?.created) ? payload.created : [];
    let ins = 0;
    let outs = 0;
    const nos: string[] = [];
    for (const item of created) {
      const row = rec(item);
      if (!row) continue;
      if (row.direction === 'in') ins += 1;
      else if (row.direction === 'out') outs += 1;
      const no = str(row.orderNo);
      if (no) nos.push(no);
    }
    const parts = [ins ? `${ins} 张入库单` : '', outs ? `${outs} 张出库单` : ''].filter(Boolean);
    let title = parts.length ? `按表格开了 ${parts.join('、')}` : '这张表没有开出单据';
    if (failedCount) title += `，${failedCount} 处没做成`;
    const details = nos.length ? [`单号 ${nos.slice(0, 8).join('、')}${nos.length > 8 ? ' 等' : ''}`] : [];
    return { title, details: [...details, ...failLines] };
  }
  return { title: '按表格处理完了', details: failLines };
}

function successTitle(
  toolId: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  raw: unknown,
): { title: string; details: string[] } {
  const sku = textOf(args, payload, 'skuCode');
  const name = textOf(args, payload, 'name');
  const goods = codeName(sku, name);
  const orderNo = textOf(args, payload, 'orderNo');
  const dir = directionWord(textOf(args, payload, 'direction'));

  switch (toolId) {
    case 'wms.sku.create':
      return { title: goods ? `创建了商品 ${goods}` : '创建了商品', details: extraSku(args, payload) };
    case 'wms.sku.update':
      return { title: goods ? `更新了商品 ${goods}` : '更新了商品', details: extraSku(args, payload) };
    case 'wms.sku.archive':
      return { title: sku ? `停用了商品 ${sku}` : '停用了商品', details: [] };
    case 'wms.sku.unarchive':
      return { title: sku ? `启用了商品 ${sku}` : '启用了商品', details: [] };
    case 'wms.sku.resolve':
      return { title: goods ? `条码对应商品 ${goods}` : '识别了条码', details: [] };
    case 'wms.order.create':
      return {
        title: `${dir ? `开了${dir}单` : '开了单据'}${orderNo ? ` ${orderNo}` : ''}`,
        details: lineHint(args),
      };
    case 'wms.order.transition':
      return {
        title: `${orderNo ? `单据 ${orderNo}` : '单据'} 转到了 ${str(args.to) ?? str(payload?.state) ?? '下一步'}`,
        details: [],
      };
    case 'wms.order.query':
      return { title: `查了单据${orderNo ? ` ${orderNo}` : ''}${countSuffix(raw)}`, details: [] };
    case 'wms.order.putaway':
      return { title: orderNo ? `确认了 ${orderNo} 的上架` : '确认了上架', details: [] };
    case 'wms.order.conflict.list':
      return { title: `看了还没处理的状态冲突${countSuffix(raw)}`, details: [] };
    case 'wms.order.conflict.accept':
      return { title: '接受了一条状态冲突', details: [] };
    case 'wms.order.conflict.dismiss':
      return { title: '驳回了一条状态冲突', details: [] };
    case 'wms.inventory.adjust': {
      const d = signed(args.delta);
      return { title: `调整了 ${sku ?? '库存'}${d ? `（${d}）` : ''}`, details: placeHint(args, payload) };
    }
    case 'wms.inventory.move':
      return {
        title: `把 ${sku ?? '商品'} 从 ${str(args.fromLocationCode) ?? '默认库位'} 移到了 ${str(args.toLocationCode) ?? '默认库位'}`,
        details: [],
      };
    case 'wms.inventory.hold':
      return { title: sku ? `冻结了 ${sku} 的库存` : '冻结了库存', details: [] };
    case 'wms.inventory.release':
      return { title: sku ? `释放了 ${sku} 的冻结` : '释放了冻结', details: [] };
    case 'wms.inventory.query': {
      const loc = str(args.locationCode);
      const focus = sku ?? (loc ? `库位 ${loc}` : '');
      return { title: `${focus ? `查了 ${focus} 的库存` : '查了库存'}${countSuffix(raw)}`, details: [] };
    }
    case 'wms.inventory.holds':
      return { title: `查了冻结${sku ? ` ${sku}` : ''}${countSuffix(raw)}`, details: [] };
    case 'wms.inventory.lowstock':
      return { title: `查了低库存${countSuffix(raw)}`, details: [] };
    case 'wms.inventory.expiring':
      return { title: `查了临期${sku ? ` ${sku}` : ''}${countSuffix(raw)}`, details: [] };
    case 'wms.ledger.query':
      return { title: `查了库存流水${countSuffix(raw)}`, details: [] };
    case 'wms.location.create':
    case 'wms.location.update': {
      const code = textOf(args, payload, 'locationCode');
      const verb = toolId.endsWith('create') ? '创建了库位' : '更新了库位';
      return { title: code ? `${verb} ${code}` : verb, details: [] };
    }
    case 'wms.location.list':
      return { title: `查了库位${countSuffix(raw)}`, details: [] };
    case 'wms.partner.create':
    case 'wms.partner.update': {
      const code = textOf(args, payload, 'partnerCode');
      const verb = toolId.endsWith('create') ? '创建了往来单位' : '更新了往来单位';
      return { title: codeName(code, name) ? `${verb} ${codeName(code, name)}` : verb, details: [] };
    }
    case 'wms.partner.list':
      return { title: `查了往来单位${countSuffix(raw)}`, details: [] };
    case 'wms.picking.create':
      return { title: `创建了拣货单${textOf(args, payload, 'pickingNo') ? ` ${textOf(args, payload, 'pickingNo')}` : ''}`, details: [] };
    case 'wms.picking.pick':
      return { title: '录入了实拣数量', details: [] };
    case 'wms.picking.close':
      return { title: '拣货单已关单', details: [] };
    case 'wms.picking.cancel':
      return { title: '取消了拣货单', details: [] };
    case 'wms.picking.query':
      return { title: `查了拣货单${countSuffix(raw)}`, details: [] };
    case 'wms.stocktake.create':
      return { title: `创建了盘点单${textOf(args, payload, 'stocktakeNo') ? ` ${textOf(args, payload, 'stocktakeNo')}` : ''}`, details: [] };
    case 'wms.stocktake.count':
      return { title: '录入了实盘数', details: [] };
    case 'wms.stocktake.close':
      return { title: '盘点单已关单', details: [] };
    case 'wms.stocktake.cancel':
      return { title: '取消了盘点单', details: [] };
    case 'wms.stocktake.query':
      return { title: `查了盘点单${countSuffix(raw)}`, details: [] };
    case 'profile.propose':
      return { title: '起草了配置变更，等你确认', details: [] };
    case 'memory.save':
      return { title: str(args.content) ? `记下了：${clip(str(args.content)!)}` : '记下了一条', details: [] };
    case 'memory.forget':
      return { title: '忘掉了一条记忆', details: [] };
    case 'memory.list':
      return { title: `看了记忆${countSuffix(raw)}`, details: [] };
    case 'core.oplog.query':
      return { title: `查了操作记录${countSuffix(raw)}`, details: [] };
    case 'tools.load': {
      const group = str(args.group) ?? str(payload?.group);
      return { title: group ? `加载了 ${group} 的完整说明` : '加载了工具说明', details: [] };
    }
    case 'chat.attachment.read': {
      const file = str(payload?.name) ?? str(args.attachmentId);
      return { title: file ? `查看了附件 ${file}` : '查看了附件', details: [] };
    }
    case 'chat.attachment.apply':
      return applyTitle(payload);
    default:
      return { title: ACTION[toolId] ? `做完了：${ACTION[toolId]}` : '做完了一项操作', details: humanFields(payload) };
  }
}

function clip(s: string): string {
  return s.length > 36 ? `${s.slice(0, 36)}…` : s;
}

function extraSku(args: Record<string, unknown>, payload: Record<string, unknown> | undefined): string[] {
  const lines: string[] = [];
  const unit = textOf(args, payload, 'unit');
  const barcode = textOf(args, payload, 'barcode');
  const point = textOf(args, payload, 'reorderPoint');
  if (unit) lines.push(`单位 ${unit}`);
  if (barcode) lines.push(`条码 ${barcode}`);
  if (point && point !== '0') lines.push(`安全库存 ${point}`);
  return lines;
}

function lineHint(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.lines)) return [];
  return args.lines.length ? [`共 ${args.lines.length} 行`] : [];
}

function placeHint(args: Record<string, unknown>, payload: Record<string, unknown> | undefined): string[] {
  const lines: string[] = [];
  const loc = textOf(args, payload, 'locationCode');
  const batch = textOf(args, payload, 'batchNo');
  if (loc && loc !== 'DEFAULT') lines.push(`库位 ${loc}`);
  if (batch && batch !== 'DEFAULT') lines.push(`批次 ${batch}`);
  const reason = str(args.reason);
  if (reason) lines.push(`原因 ${reason}`);
  return lines;
}

function humanFields(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('Id') || key === 'error' || value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const label = FIELD[key] ?? key;
    const shown = key === 'direction' ? directionWord(String(value)) : String(value);
    if (!shown) continue;
    lines.push(`${label} ${shown}`);
    if (lines.length >= 6) break;
  }
  return lines;
}

export function speakInvocation(invocation: ChatInvocation): SpokenTool {
  const action = ACTION[invocation.toolId] ?? '操作';
  const payload = rec(invocation.payload);
  if (invocation.ok === undefined) {
    return {
      title: `正在${action}${subjectOf(invocation.args)}`.replace(/\s+/g, ' ').trim(),
      action,
      details: [],
    };
  }
  if (invocation.ok === false) {
    const why = humanError(str(payload?.error) ?? '');
    const who = subjectOf(invocation.args);
    const title = `${action}${who}没做成${why ? `：${why}` : ''}`.replace('没做成', ' 没做成');
    return { title: title.replace(/\s+/g, ' ').trim(), action, details: [] };
  }
  const spoken = successTitle(invocation.toolId, invocation.args, payload, invocation.payload);
  return {
    title: spoken.title.replace(/\s+/g, ' ').trim(),
    action,
    details: spoken.details,
  };
}

function subjectOf(args: Record<string, unknown>): string {
  const sku = str(args.skuCode);
  const name = str(args.name);
  const goods = codeName(sku, name);
  if (goods) return ` ${goods}`;
  const orderNo = str(args.orderNo);
  if (orderNo) return ` ${orderNo}`;
  const loc = str(args.locationCode);
  if (loc) return ` ${loc}`;
  return '';
}

/** 一组工具调用在折叠条上的概括。只有一条时直接用那一句。 */
export function speakRun(invocations: ChatInvocation[]): string {
  if (invocations.length === 0) return '没有操作';
  if (invocations.length === 1) return speakInvocation(invocations[0]).title;
  const names = [...new Set(invocations.map((inv) => speakInvocation(inv).action))];
  const kind = names.slice(0, 3).join('、') + (names.length > 3 ? '等' : '');
  const pending = invocations.some((inv) => inv.ok === undefined);
  const failed = invocations.filter((inv) => inv.ok === false).length;
  if (pending) {
    const done = invocations.filter((inv) => inv.ok !== undefined).length;
    return done
      ? `正在处理 ${invocations.length} 项（${kind}），已完成 ${done} 项`
      : `正在处理 ${invocations.length} 项（${kind}）`;
  }
  if (failed) return `做了 ${invocations.length} 项（${kind}），${failed} 项没做成`;
  return `做了 ${invocations.length} 项（${kind}）`;
}
