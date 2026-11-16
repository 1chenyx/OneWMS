import { putawayStates } from '../putaway/model.js';

/** 管理看板只读。这些路径都不带 warehouseCode，也不走写端口。 */

export const BOARD_ORDERS = '/api/dashboard/orders';
export const BOARD_WORKLOAD = '/api/dashboard/workload';
export const BOARD_STOCK = '/api/dashboard/stock';
export const BOARD_STOCK_FULL = '/api/dashboard/stock?full=1';
export const BOARD_URGENT = '/api/dashboard/urgent';
export const BOARD_ALERTS = '/api/dashboard/alerts';
export const BOARD_FLOW = '/api/dashboard/flow-trend?days=1';
export const BOARD_CONFLICTS = '/api/order-conflicts';
export const BOARD_ACTIVITY = '/api/dashboard/activity?limit=12';
export const BOARD_EXPIRY = '/api/inventory/expiry';
export const BOARD_PICKINGS = '/api/pickings?state=created';

const ORDER_PAGE = 50;

/**
 * 管理端单据列表。状态与现场待收、待上架相同，但不带 warehouseCode。
 * 待收固定 created,announced。待上架走 putawayStates：质检开只有 inspected。
 */
export function manageOrderListPath(kind: 'receive' | 'putaway', qcOn: boolean, offset: number): string {
  const params = new URLSearchParams();
  params.set('direction', 'in');
  params.set('state', kind === 'receive' ? 'created,announced' : putawayStates(qcOn));
  params.set('sort', 'updatedAtAsc');
  params.set('limit', String(ORDER_PAGE));
  params.set('offset', String(offset));
  return `/api/orders?${params.toString()}`;
}

export interface OrderStateCount {
  direction: 'in' | 'out';
  state: string;
  count: number;
}

export interface LowStockRow {
  skuCode: string;
  name: string;
  unit: string | null;
  total: number;
  available: number;
  reorderPoint: number;
  shortage: number;
}

export interface UrgentRow {
  skuCode: string;
  name: string;
  batchNo: string;
  batchExpiryDate: string;
  daysLeft: number;
  level: 'expired' | 'critical' | 'warning';
  quantity: number;
  unit: string | null;
}

export interface NegativeBucket {
  skuCode: string;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

export interface ConflictRow {
  eventId: string;
  orderNo: string;
  fromState: string;
  toState: string;
  actualState: string;
}

export interface FlowPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export interface ActivityRow {
  eventId: string;
  skuCode: string;
  name: string;
  locationCode: string;
  delta: number;
  reason: string;
}

export interface PickingCard {
  pickingNo: string;
  note: string | null;
  lineCount: number;
}

export interface QtyLine {
  skuCode: string;
  name: string;
  locationCode: string;
  batchNo: string | null;
  quantity: number;
}

export interface SkuStock {
  skuCode: string;
  name: string;
  quantity: number;
  held: number;
  reserved: number;
  available: number;
  unit: string | null;
}

export interface BoardHome {
  receive: number;
  putaway: number;
  pickingOpen: number;
  lowStockCount: number;
  lowStock: LowStockRow[];
  urgent: UrgentRow[];
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  holdCount: number;
  negativeCount: number;
  negativeBuckets: NegativeBucket[];
  conflicts: ConflictRow[];
  today: FlowPoint | null;
}

/** 服务器日。用 UTC，不用手机本地午夜。 */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function receiveCount(rows: readonly OrderStateCount[]): number {
  return sumStates(rows, ['created', 'announced']);
}

/** 与现场待上架同一集合。质检开只计已质检。 */
export function putawayCount(rows: readonly OrderStateCount[], qcOn: boolean): number {
  return sumStates(rows, qcOn ? ['inspected'] : ['received', 'inspected']);
}

export function todayFlowPoint(points: readonly FlowPoint[], day: string): FlowPoint | null {
  return points.find((point) => point.day === day) ?? null;
}

export function conflictLine(row: ConflictRow): string {
  return `${row.orderNo} ${row.fromState} → ${row.toState}，实际 ${row.actualState}`;
}

export function expiryLabel(level: UrgentRow['level']): string {
  if (level === 'expired') return '过期';
  if (level === 'critical') return '临界';
  return '警告';
}

/** 占用行：这一行大于 0，或全库还有占用（分页可能看不到）。 */
export function showReserved(reserved: number, hasReserved: boolean): boolean {
  return reserved > 0 || hasReserved;
}

export function inventorySummaryPath(skuCode: string): string {
  const params = new URLSearchParams();
  params.set('skuCode', skuCode);
  params.set('limit', '5');
  return `/api/inventory?${params.toString()}`;
}

export function skuLocationPath(skuCode: string): string {
  const params = new URLSearchParams();
  params.set('view', 'location');
  params.set('q', skuCode);
  params.set('limit', '50');
  return `/api/inventory/slices?${params.toString()}`;
}

export function locationContentsPath(locationCode: string): string {
  const params = new URLSearchParams();
  params.set('view', 'location');
  params.set('locationCode', locationCode);
  params.set('limit', '50');
  return `/api/inventory/slices?${params.toString()}`;
}

export function warehouseStockPath(warehouseCode: string): string {
  return `/api/warehouses/${encodeURIComponent(warehouseCode)}/stock`;
}

export function readBoard(
  input: {
    orders: unknown;
    workload: unknown;
    stock: unknown;
    urgent: unknown;
    alerts: unknown;
    flow: unknown;
    conflicts: unknown;
  },
  qcOn: boolean,
  day: string,
): BoardHome | null {
  const orders = readOrderStats(input.orders);
  const pickingOpen = readPickingOpen(input.workload);
  const stock = readStockFocus(input.stock);
  const urgent = readUrgent(input.urgent);
  const alerts = readAlerts(input.alerts);
  const flow = readFlow(input.flow);
  const conflicts = readConflicts(input.conflicts);
  if (!orders || pickingOpen === null || !stock || !urgent || !alerts || !flow || !conflicts) return null;
  return {
    receive: receiveCount(orders),
    putaway: putawayCount(orders, qcOn),
    pickingOpen,
    lowStockCount: stock.lowStockCount,
    lowStock: stock.lowStock,
    urgent,
    ...alerts,
    conflicts,
    today: todayFlowPoint(flow, day),
  };
}

export function readActivity(body: unknown): ActivityRow[] | null {
  if (!Array.isArray(body)) return null;
  const rows: ActivityRow[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.skuCode !== 'string' || typeof rec.delta !== 'number' || typeof rec.reason !== 'string') return null;
    rows.push({
      eventId: typeof rec.eventId === 'string' ? rec.eventId : `${rows.length}`,
      skuCode: rec.skuCode,
      name: typeof rec.name === 'string' ? rec.name : '',
      locationCode: typeof rec.locationCode === 'string' ? rec.locationCode : '',
      delta: rec.delta,
      reason: rec.reason,
    });
  }
  return rows;
}

export function readExpiryRows(body: unknown): UrgentRow[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows)) return null;
  const rows: UrgentRow[] = [];
  for (const item of (body as { rows: unknown[] }).rows) {
    if (!item || typeof item !== 'object') return null;
    const level = (item as { level?: unknown }).level;
    if (level === 'safe' || level === 'unknown') continue;
    const row = readUrgentRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

export function readPickings(body: unknown): PickingCard[] | null {
  if (!Array.isArray(body)) return null;
  const rows: PickingCard[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.pickingNo !== 'string' || !Array.isArray(rec.lines)) return null;
    rows.push({
      pickingNo: rec.pickingNo,
      note: typeof rec.note === 'string' ? rec.note : null,
      lineCount: rec.lines.length,
    });
  }
  return rows;
}

export function readSkuStockPage(
  body: unknown,
  skuCode: string,
  name: string,
): { row: SkuStock; hasReserved: boolean } | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows)) return null;
  const page = body as { rows: unknown[]; hasReserved?: unknown };
  const hasReserved = page.hasReserved === true;
  for (const item of page.rows) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.skuCode !== 'string' || typeof rec.quantity !== 'number') return null;
    if (typeof rec.held !== 'number' || typeof rec.reserved !== 'number' || typeof rec.available !== 'number') return null;
    if (rec.skuCode !== skuCode) continue;
    return {
      hasReserved,
      row: {
        skuCode: rec.skuCode,
        name: typeof rec.name === 'string' ? rec.name : name,
        quantity: rec.quantity,
        held: rec.held,
        reserved: rec.reserved,
        available: rec.available,
        unit: typeof rec.unit === 'string' ? rec.unit : null,
      },
    };
  }
  return {
    hasReserved,
    row: { skuCode, name, quantity: 0, held: 0, reserved: 0, available: 0, unit: null },
  };
}

/** 桶行只有实物余量。 */
export function readSliceQty(body: unknown): QtyLine[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows)) return null;
  const lines: QtyLine[] = [];
  for (const item of (body as { rows: unknown[] }).rows) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.skuCode !== 'string') return null;
    const name = typeof rec.name === 'string' ? rec.name : '';
    if (Array.isArray(rec.details) && rec.details.length > 0) {
      for (const detail of rec.details) {
        const line = readDetailQty(rec.skuCode, name, detail);
        if (!line) return null;
        lines.push(line);
      }
      continue;
    }
    if (typeof rec.quantity !== 'number') return null;
    lines.push({
      skuCode: rec.skuCode,
      name,
      locationCode: typeof rec.locationCode === 'string' ? rec.locationCode : '',
      batchNo: typeof rec.batchNo === 'string' ? rec.batchNo : null,
      quantity: rec.quantity,
    });
  }
  return lines;
}

export function readWarehouseStock(body: unknown): { warehouseCode: string; name: string; rows: QtyLine[] } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as { warehouseCode?: unknown; name?: unknown; rows?: unknown };
  if (typeof rec.warehouseCode !== 'string' || !Array.isArray(rec.rows)) return null;
  const rows: QtyLine[] = [];
  for (const item of rec.rows) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (typeof row.skuCode !== 'string' || typeof row.quantity !== 'number' || typeof row.locationCode !== 'string') return null;
    rows.push({
      skuCode: row.skuCode,
      name: typeof row.name === 'string' ? row.name : '',
      locationCode: row.locationCode,
      batchNo: typeof row.batchNo === 'string' ? row.batchNo : null,
      quantity: row.quantity,
    });
  }
  return { warehouseCode: rec.warehouseCode, name: typeof rec.name === 'string' ? rec.name : rec.warehouseCode, rows };
}

function sumStates(rows: readonly OrderStateCount[], states: readonly string[]): number {
  return rows.reduce((sum, row) => (row.direction === 'in' && states.includes(row.state) ? sum + row.count : sum), 0);
}

function readOrderStats(body: unknown): OrderStateCount[] | null {
  if (!Array.isArray(body)) return null;
  const rows: OrderStateCount[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if ((rec.direction !== 'in' && rec.direction !== 'out') || typeof rec.state !== 'string' || typeof rec.count !== 'number') {
      return null;
    }
    rows.push({ direction: rec.direction, state: rec.state, count: rec.count });
  }
  return rows;
}

function readPickingOpen(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { pickingOpen?: unknown }).pickingOpen;
  return typeof value === 'number' ? value : null;
}

function readStockFocus(body: unknown): { lowStockCount: number; lowStock: LowStockRow[] } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as { lowStockCount?: unknown; lowStock?: unknown };
  if (typeof rec.lowStockCount !== 'number' || !Array.isArray(rec.lowStock)) return null;
  const lowStock: LowStockRow[] = [];
  for (const item of rec.lowStock) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (typeof row.skuCode !== 'string' || typeof row.available !== 'number' || typeof row.shortage !== 'number') return null;
    if (typeof row.total !== 'number' || typeof row.reorderPoint !== 'number') return null;
    lowStock.push({
      skuCode: row.skuCode,
      name: typeof row.name === 'string' ? row.name : '',
      unit: typeof row.unit === 'string' ? row.unit : null,
      total: row.total,
      available: row.available,
      reorderPoint: row.reorderPoint,
      shortage: row.shortage,
    });
  }
  return { lowStockCount: rec.lowStockCount, lowStock };
}

function readUrgent(body: unknown): UrgentRow[] | null {
  if (!Array.isArray(body)) return null;
  const rows: UrgentRow[] = [];
  for (const item of body) {
    const row = readUrgentRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function readUrgentRow(item: unknown): UrgentRow | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  if (rec.level !== 'expired' && rec.level !== 'critical' && rec.level !== 'warning') return null;
  if (typeof rec.skuCode !== 'string' || typeof rec.batchNo !== 'string' || typeof rec.batchExpiryDate !== 'string') return null;
  if (typeof rec.daysLeft !== 'number' || typeof rec.quantity !== 'number') return null;
  return {
    skuCode: rec.skuCode,
    name: typeof rec.name === 'string' ? rec.name : '',
    batchNo: rec.batchNo,
    batchExpiryDate: rec.batchExpiryDate,
    daysLeft: rec.daysLeft,
    level: rec.level,
    quantity: rec.quantity,
    unit: typeof rec.unit === 'string' ? rec.unit : null,
  };
}

function readAlerts(body: unknown): Pick<
  BoardHome,
  'expiredCount' | 'criticalCount' | 'warningCount' | 'holdCount' | 'negativeCount' | 'negativeBuckets'
> | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const expiredCount = rec.expiredCount;
  const criticalCount = rec.criticalCount;
  const warningCount = rec.warningCount;
  const holdCount = rec.holdCount;
  const negativeCount = rec.negativeCount;
  if (
    typeof expiredCount !== 'number' ||
    typeof criticalCount !== 'number' ||
    typeof warningCount !== 'number' ||
    typeof holdCount !== 'number' ||
    typeof negativeCount !== 'number' ||
    !Array.isArray(rec.negativeBuckets)
  ) {
    return null;
  }
  const negativeBuckets: NegativeBucket[] = [];
  for (const item of rec.negativeBuckets) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (typeof row.skuCode !== 'string' || typeof row.locationCode !== 'string' || typeof row.batchNo !== 'string') return null;
    if (typeof row.quantity !== 'number') return null;
    negativeBuckets.push({
      skuCode: row.skuCode,
      locationCode: row.locationCode,
      batchNo: row.batchNo,
      quantity: row.quantity,
    });
  }
  return { expiredCount, criticalCount, warningCount, holdCount, negativeCount, negativeBuckets };
}

function readFlow(body: unknown): FlowPoint[] | null {
  if (!Array.isArray(body)) return null;
  const rows: FlowPoint[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.day !== 'string' || typeof rec.inbound !== 'number' || typeof rec.outbound !== 'number') return null;
    rows.push({ day: rec.day, inbound: rec.inbound, outbound: rec.outbound });
  }
  return rows;
}

function readConflicts(body: unknown): ConflictRow[] | null {
  if (!Array.isArray(body)) return null;
  const rows: ConflictRow[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.orderNo !== 'string' || typeof rec.fromState !== 'string' || typeof rec.toState !== 'string') return null;
    if (typeof rec.actualState !== 'string') return null;
    rows.push({
      eventId: typeof rec.eventId === 'string' ? rec.eventId : `${rec.orderNo}:${rows.length}`,
      orderNo: rec.orderNo,
      fromState: rec.fromState,
      toState: rec.toState,
      actualState: rec.actualState,
    });
  }
  return rows;
}

function readDetailQty(skuCode: string, name: string, detail: unknown): QtyLine | null {
  if (!detail || typeof detail !== 'object') return null;
  const row = detail as Record<string, unknown>;
  if (typeof row.locationCode !== 'string' || typeof row.quantity !== 'number') return null;
  return {
    skuCode,
    name,
    locationCode: row.locationCode,
    batchNo: typeof row.batchNo === 'string' ? row.batchNo : null,
    quantity: row.quantity,
  };
}
