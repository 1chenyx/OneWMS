import type { AgentToolMeta, SessionTool } from '@one/ai';
import type { WmsWorkspace } from '@one/wms';

/**
 * 对话里的文件。表格和文本先挂在会话上，模型只看预览，
 * 落库时按列名映射调用现有的建档 / 开单工具，不把整表抄进参数。
 */

const MAX_FILES = 3;
const MAX_SESSION_FILES = 6;
const MAX_ROWS = 1000;
const MAX_COLS = 40;
const MAX_CELL = 200;
const MAX_TEXT = 40_000;
const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 12;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface StoredAttachment {
  id: string;
  name: string;
  kind: 'table' | 'text';
  headers: string[];
  rows: string[][];
  text: string;
  truncated: boolean;
}

const READ_META: AgentToolMeta = {
  id: 'chat.attachment.read',
  label: '查看附件',
  description:
    '读取用户上传并挂在本会话里的附件。attachmentId 用消息里给出的 id。表格用 offset、limit 翻页（limit 最大 50），返回 headers、totalRows、rows。文本用 offset、limit 按字符截取（limit 最大 8000）。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: '附件 id' },
      offset: { type: 'integer', minimum: 0, description: '表格跳过的行数，或文本跳过的字符数' },
      limit: { type: 'integer', minimum: 1, description: '表格返回行数（最大 50）或文本字符数（最大 8000）' },
    },
    required: ['attachmentId'],
  },
};

const APPLY_META: AgentToolMeta = {
  id: 'chat.attachment.apply',
  label: '按表格处理',
  description:
    '把一张已上传的表格落成商品或出入库单。attachmentId 必填。action=sku：按行建档或更新，mode=create 只新建（已存在记失败），mode=upsert 为默认（已存在则用非空列更新）。action=orders：有单号列时按单号分组开单；没有单号时，相同方向和往来单位并成一张单。columns 的值必须是表头原文，例如 { skuCode: "SKU编码", name: "名称", quantity: "数量", direction: "方向" }。没有方向列时传 direction=in 或 out。某一行失败不影响其他行。文本附件不能用本工具。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: '附件 id' },
      action: { type: 'string', enum: ['sku', 'orders'], description: 'sku=商品档案，orders=出入库单' },
      columns: { type: 'object', description: '列名映射，值是表头原文。如 skuCode、name、quantity、direction、orderNo' },
      direction: { type: 'string', enum: ['in', 'out'], description: '没有方向列时的单据方向' },
      mode: { type: 'string', enum: ['upsert', 'create'], description: '商品：upsert 更新已有，create 只新建' },
    },
    required: ['attachmentId', 'action', 'columns'],
  },
};

function cleanName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '未命名';
  const cleaned = raw.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  return cleaned || '未命名';
}

function asCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value);
    const quantized = Math.round(value * 1000) / 1000;
    return String(quantized);
  }
  return String(value).trim().slice(0, MAX_CELL);
}

/** 校验并收口客户端传来的附件。非法时返回说明，不抛。 */
export function takeAttachments(raw: unknown): { ok: true; items: StoredAttachment[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'attachments 必须是数组' };
  if (raw.length > MAX_FILES) return { ok: false, message: `一次最多导入 ${MAX_FILES} 个文件` };
  const items: StoredAttachment[] = [];
  for (const item of raw) {
    const parsed = oneAttachment(item);
    if ('message' in parsed) return { ok: false, message: parsed.message };
    items.push(parsed);
  }
  return { ok: true, items };
}

function oneAttachment(raw: unknown): StoredAttachment | { message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { message: '附件格式不对' };
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !ID_RE.test(row.id)) return { message: '附件 id 不合法' };
  const name = cleanName(row.name);
  if (row.kind === 'text') {
    const text = typeof row.text === 'string' ? row.text.slice(0, MAX_TEXT) : '';
    if (!text.trim()) return { message: `${name} 是空的` };
    return {
      id: row.id,
      name,
      kind: 'text',
      headers: [],
      rows: [],
      text,
      truncated: typeof row.text === 'string' && row.text.length > MAX_TEXT,
    };
  }
  if (row.kind !== 'table') return { message: `${name} 的类型无法识别` };
  if (!Array.isArray(row.headers) || row.headers.length === 0) return { message: `${name} 没有表头` };
  const headers = row.headers.slice(0, MAX_COLS).map(asCell);
  if (headers.every((cell) => cell === '')) return { message: `${name} 没有表头` };
  if (!Array.isArray(row.rows)) return { message: `${name} 的行数据不对` };
  const truncated = row.rows.length > MAX_ROWS || row.headers.length > MAX_COLS;
  const rows = row.rows.slice(0, MAX_ROWS).map((line) => {
    const cells = Array.isArray(line) ? line : [];
    return headers.map((_, index) => asCell(cells[index]));
  });
  return { id: row.id, name, kind: 'table', headers, rows, text: '', truncated };
}

export function rememberAttachments(existing: readonly StoredAttachment[], fresh: readonly StoredAttachment[]): StoredAttachment[] {
  const next = existing.filter((item) => !fresh.some((file) => file.id === item.id));
  next.push(...fresh);
  return next.slice(Math.max(0, next.length - MAX_SESSION_FILES));
}

function renderAttachment(file: StoredAttachment): string {
  if (file.kind === 'text') {
    const excerpt = file.text.length > 4000 ? `${file.text.slice(0, 4000)}\n…（后面还有，用 chat.attachment.read 继续看）` : file.text;
    return [`【附件 ${file.id}】${file.name}`, '文本：', excerpt].join('\n');
  }
  const headers = file.headers.slice(0, PREVIEW_COLS);
  const preview = file.rows.slice(0, PREVIEW_ROWS);
  const lines = [
    `【附件 ${file.id}】${file.name}`,
    `表格，共 ${file.rows.length} 行${file.truncated ? '（文件较大，只保留了前面的部分）' : ''}。列：${file.headers.join('、')}`,
    '预览：',
    headers.join('\t'),
    ...preview.map((cells) => headers.map((_, index) => cells[index] ?? '').join('\t')),
  ];
  if (file.rows.length > PREVIEW_ROWS) {
    lines.push(`…还有 ${file.rows.length - PREVIEW_ROWS} 行。完整内容用 chat.attachment.read 按附件 id 翻页。`);
  }
  if (file.headers.length > headers.length) lines.push(`预览省略了后 ${file.headers.length - headers.length} 列。`);
  lines.push('要落库用 chat.attachment.apply，columns 的值填上面的列名原文。不要把整表抄进其他工具。');
  return lines.join('\n');
}

/**
 * 拼进模型的用户消息。没有附件时原样返回，避免改写普通对话。
 * fresh 是这一轮新上传的；session 是挂在会话上的全部（含 fresh）。
 */
export function composeUserText(message: string, fresh: readonly StoredAttachment[], session: readonly StoredAttachment[]): string {
  const said = message.trim();
  if (fresh.length === 0 && session.length === 0) return said;
  const blocks: string[] = fresh.map(renderAttachment);
  const freshIds = new Set(fresh.map((file) => file.id));
  const older = session.filter((file) => !freshIds.has(file.id));
  if (older.length > 0) {
    blocks.push(
      `本会话里还可以继续处理这些附件：${older
        .map((file) => `${file.id} ${file.name}（${file.kind === 'table' ? `表格 ${file.rows.length} 行` : '文本'}）`)
        .join('、')}`,
    );
  }
  if (!said && fresh.length > 0) {
    blocks.push('用户上传了文件，还没有说明要怎么处理。先用一两句话说明你看到的内容，再用 ui.ask 问清楚要建成商品、入库单还是出库单。不要擅自写入。');
  } else if (said) {
    blocks.push(fresh.length > 0 || older.length > 0 ? `用户说：${said}` : said);
  }
  return blocks.join('\n\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function humanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^TOOL_REJECTED:\s*/, '').trim() || '没做成';
}

function requireFile(files: readonly StoredAttachment[], id: unknown): StoredAttachment {
  if (typeof id !== 'string' || !id.trim()) fail('要指定附件 id');
  const found = files.find((file) => file.id === id);
  if (!found) fail('没有这个附件，请让用户重新导入');
  return found;
}

function columnMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('columns 要写明每一列对应表头上的哪个名字');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  if (Object.keys(out).length === 0) fail('columns 是空的，请填表头上的列名');
  return out;
}

function headerIndex(headers: string[], columns: Record<string, string>, key: string): number | undefined {
  const name = columns[key];
  if (!name) return undefined;
  const found = headers.findIndex((header) => header.trim().toLowerCase() === name.trim().toLowerCase());
  if (found < 0) fail(`表头里没有「${name}」这一列。现有列：${headers.join('、')}`);
  return found;
}

function cell(row: string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (row[index] ?? '').trim();
}

function parseDirection(raw: string): 'in' | 'out' | undefined {
  const value = raw.trim().toLowerCase();
  if (['in', 'inbound', '入库', '入', '收货', '进货'].includes(value)) return 'in';
  if (['out', 'outbound', '出库', '出', '发货', '销售'].includes(value)) return 'out';
  return undefined;
}

function parseQty(raw: string): number | undefined {
  const value = raw.replace(/,/g, '').trim();
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000) / 1000;
}

interface FailRow {
  row?: number;
  orderNo?: string;
  skuCode?: string;
  error: string;
}

function capFailed(failed: FailRow[]): { failedCount: number; failed: FailRow[] } {
  return { failedCount: failed.length, failed: failed.slice(0, 20) };
}

async function applySku(
  ws: WmsWorkspace,
  actor: string,
  file: StoredAttachment,
  columns: Record<string, string>,
  mode: string,
): Promise<unknown> {
  if (mode !== 'create' && mode !== 'upsert') fail('mode 只能是 upsert 或 create');
  const skuCol = headerIndex(file.headers, columns, 'skuCode');
  if (skuCol === undefined) fail('处理商品需要 columns.skuCode，值是编码那一列的表头');
  const nameCol = headerIndex(file.headers, columns, 'name');
  const unitCol = headerIndex(file.headers, columns, 'unit');
  const barcodeCol = headerIndex(file.headers, columns, 'barcode');
  const pointCol = headerIndex(file.headers, columns, 'reorderPoint');
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failed: FailRow[] = [];

  for (let index = 0; index < file.rows.length; index += 1) {
    const line = file.rows[index] ?? [];
    const rowNo = index + 2;
    const skuCode = cell(line, skuCol);
    const name = cell(line, nameCol);
    const unit = cell(line, unitCol);
    const barcode = cell(line, barcodeCol);
    const pointText = cell(line, pointCol);
    if (!skuCode && !name && !unit && !barcode && !pointText) continue;
    if (!skuCode) {
      failed.push({ row: rowNo, error: '缺少编码' });
      continue;
    }
    let reorderPoint: number | undefined;
    if (pointText) {
      const n = Number(pointText);
      if (!Number.isInteger(n) || n < 0) {
        failed.push({ row: rowNo, skuCode, error: '安全库存必须是非负整数' });
        continue;
      }
      reorderPoint = n;
    }
    try {
      ws.sync();
      const existing = ws.skus.byCode(skuCode);
      if (existing) {
        if (mode === 'create') {
          failed.push({ row: rowNo, skuCode, error: '编码已存在' });
          continue;
        }
        const patch: { skuCode: string; name?: string; unit?: string; barcode?: string; reorderPoint?: number } = { skuCode };
        if (name) patch.name = name;
        if (unit) patch.unit = unit;
        if (barcode) patch.barcode = barcode;
        if (reorderPoint !== undefined) patch.reorderPoint = reorderPoint;
        if (Object.keys(patch).length === 1) {
          skipped += 1;
          continue;
        }
        await ws.tools.invoke('wms.sku.update', patch, actor);
        updated += 1;
      } else {
        if (!name) {
          failed.push({ row: rowNo, skuCode, error: '新建商品要有名称' });
          continue;
        }
        await ws.tools.invoke(
          'wms.sku.create',
          {
            skuCode,
            name,
            ...(unit ? { unit } : {}),
            ...(barcode ? { barcode } : {}),
            ...(reorderPoint !== undefined ? { reorderPoint } : {}),
          },
          actor,
        );
        created += 1;
      }
    } catch (err) {
      failed.push({ row: rowNo, skuCode, error: humanError(err) });
    }
  }

  return { attachmentId: file.id, name: file.name, action: 'sku', created, updated, skipped, ...capFailed(failed) };
}

interface DraftLine {
  skuCode: string;
  quantity: number;
  locationCode?: string;
  batchNo?: string;
  batchExpiryDate?: string;
}

interface DraftOrder {
  orderNo?: string;
  direction: 'in' | 'out';
  partnerCode?: string;
  note?: string;
  lines: DraftLine[];
  error?: string;
}

function lineKey(line: DraftLine): string {
  return `${line.skuCode}\0${line.locationCode ?? ''}\0${line.batchNo ?? ''}`;
}

async function applyOrders(
  ws: WmsWorkspace,
  actor: string,
  file: StoredAttachment,
  columns: Record<string, string>,
  fallbackDirection: unknown,
): Promise<unknown> {
  const skuCol = headerIndex(file.headers, columns, 'skuCode');
  const qtyCol = headerIndex(file.headers, columns, 'quantity');
  if (skuCol === undefined) fail('开单需要 columns.skuCode，值是商品编码那一列的表头');
  if (qtyCol === undefined) fail('开单需要 columns.quantity，值是数量那一列的表头');
  const orderCol = headerIndex(file.headers, columns, 'orderNo');
  const dirCol = headerIndex(file.headers, columns, 'direction');
  const partnerCol = headerIndex(file.headers, columns, 'partnerCode');
  const noteCol = headerIndex(file.headers, columns, 'note');
  const locCol = headerIndex(file.headers, columns, 'locationCode');
  const batchCol = headerIndex(file.headers, columns, 'batchNo');
  const expiryCol = headerIndex(file.headers, columns, 'batchExpiryDate');
  const constantDir = typeof fallbackDirection === 'string' ? parseDirection(fallbackDirection) : undefined;
  if (fallbackDirection !== undefined && fallbackDirection !== '' && !constantDir) {
    fail('direction 只能是 in（入库）或 out（出库）');
  }
  if (dirCol === undefined && !constantDir) fail('表里没有方向列，请在参数里传 direction=in 或 out');

  const failed: FailRow[] = [];
  const groups = new Map<string, DraftOrder>();

  for (let index = 0; index < file.rows.length; index += 1) {
    const line = file.rows[index] ?? [];
    const rowNo = index + 2;
    const skuCode = cell(line, skuCol);
    const qtyText = cell(line, qtyCol);
    const orderNo = cell(line, orderCol);
    const dirText = cell(line, dirCol);
    const partnerCode = cell(line, partnerCol);
    const note = cell(line, noteCol);
    const locationCode = cell(line, locCol);
    const batchNo = cell(line, batchCol);
    const expiry = cell(line, expiryCol);
    if (!skuCode && !qtyText && !orderNo) continue;
    const direction = (dirText ? parseDirection(dirText) : undefined) ?? constantDir;
    if (!skuCode) {
      failed.push({ row: rowNo, orderNo: orderNo || undefined, error: '缺少商品编码' });
      continue;
    }
    const quantity = parseQty(qtyText);
    if (quantity === undefined) {
      failed.push({ row: rowNo, skuCode, orderNo: orderNo || undefined, error: '数量必须是正数' });
      continue;
    }
    if (!direction) {
      failed.push({ row: rowNo, skuCode, error: `看不懂方向「${dirText}」，请用入库或出库` });
      continue;
    }
    const key = orderNo ? `no:${orderNo}` : `auto:${direction}:${partnerCode}:${note}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        orderNo: orderNo || undefined,
        direction,
        partnerCode: partnerCode || undefined,
        note: note || undefined,
        lines: [],
      };
      groups.set(key, group);
    } else if (group.direction !== direction) {
      group.error = `单号 ${orderNo} 里入库和出库混在一起了`;
    } else if (partnerCode && group.partnerCode && group.partnerCode !== partnerCode) {
      group.error = `单号 ${orderNo || '这张单'} 的往来单位不一致`;
    } else if (partnerCode && !group.partnerCode) {
      group.partnerCode = partnerCode;
    }
    const draft: DraftLine = {
      skuCode,
      quantity,
      ...(locationCode ? { locationCode } : {}),
      ...(batchNo ? { batchNo } : {}),
      ...(expiry && direction === 'in' ? { batchExpiryDate: expiry } : {}),
    };
    const prev = group.lines.find((item) => lineKey(item) === lineKey(draft));
    if (prev) {
      prev.quantity = Math.round((prev.quantity + draft.quantity) * 1000) / 1000;
      if (draft.batchExpiryDate && prev.batchExpiryDate && draft.batchExpiryDate !== prev.batchExpiryDate) {
        group.error = `${skuCode} 的效期不一致`;
      } else if (draft.batchExpiryDate && !prev.batchExpiryDate) {
        prev.batchExpiryDate = draft.batchExpiryDate;
      }
    } else {
      group.lines.push(draft);
    }
  }

  const created: { orderNo: string; direction: 'in' | 'out'; lineCount: number }[] = [];
  for (const group of groups.values()) {
    if (group.error) {
      failed.push({ orderNo: group.orderNo, error: group.error });
      continue;
    }
    if (group.lines.length === 0) continue;
    try {
      const result = (await ws.tools.invoke(
        'wms.order.create',
        {
          direction: group.direction,
          lines: group.lines,
          ...(group.orderNo ? { orderNo: group.orderNo } : {}),
          ...(group.partnerCode ? { partnerCode: group.partnerCode } : {}),
          ...(group.note ? { note: group.note } : {}),
        },
        actor,
      )) as { orderNo?: string };
      created.push({
        orderNo: result.orderNo ?? group.orderNo ?? '',
        direction: group.direction,
        lineCount: group.lines.length,
      });
    } catch (err) {
      failed.push({ orderNo: group.orderNo, error: humanError(err) });
    }
  }

  return { attachmentId: file.id, name: file.name, action: 'orders', created, ...capFailed(failed) };
}

export async function applyAttachment(
  ws: WmsWorkspace,
  actor: string,
  files: readonly StoredAttachment[],
  args: Record<string, unknown>,
): Promise<unknown> {
  const file = requireFile(files, args.attachmentId);
  if (file.kind !== 'table') fail('这是文本，不能按表格落库。需要的话直接根据文本内容回答。');
  const columns = columnMap(args.columns);
  if (args.action === 'sku') return applySku(ws, actor, file, columns, typeof args.mode === 'string' ? args.mode : 'upsert');
  if (args.action === 'orders') return applyOrders(ws, actor, file, columns, args.direction);
  fail('action 只能是 sku（商品）或 orders（出入库单）');
}

export function readAttachment(files: readonly StoredAttachment[], args: Record<string, unknown>): unknown {
  const file = requireFile(files, args.attachmentId);
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
  if (file.kind === 'text') {
    const limit = typeof args.limit === 'number' ? Math.min(8000, Math.max(1, Math.floor(args.limit))) : 4000;
    return {
      attachmentId: file.id,
      name: file.name,
      kind: 'text',
      totalChars: file.text.length,
      offset,
      text: file.text.slice(offset, offset + limit),
    };
  }
  const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 20;
  return {
    attachmentId: file.id,
    name: file.name,
    kind: 'table',
    headers: file.headers,
    totalRows: file.rows.length,
    offset,
    rows: file.rows.slice(offset, offset + limit),
  };
}

/** 会话里已经有附件时才挂上。能写业务数据的助手才有落库工具。 */
export function attachmentSessionTools(options: {
  getFiles: () => readonly StoredAttachment[];
  allowApply: boolean;
  ws: WmsWorkspace;
}): SessionTool[] {
  const read: SessionTool = {
    meta: READ_META,
    invoke: async (args) => readAttachment(options.getFiles(), args),
  };
  if (!options.allowApply) return [read];
  const apply: SessionTool = {
    meta: APPLY_META,
    invoke: (args, actor) => applyAttachment(options.ws, actor, options.getFiles(), args),
  };
  return [read, apply];
}
