import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fieldGet, moduleOn } from '../api.js';
import { errorMessage } from '../errors.js';
import { readReceivePage, type ReceiveOrder } from '../receive/model.js';
import { screenOpen } from '../screens.js';
import { useFieldSession } from '../session.js';
import { OrderDrill } from './OrderDrill.js';
import {
  BOARD_ACTIVITY,
  BOARD_ALERTS,
  BOARD_CONFLICTS,
  BOARD_EXPIRY,
  BOARD_FLOW,
  BOARD_ORDERS,
  BOARD_PICKINGS,
  BOARD_STOCK,
  BOARD_STOCK_FULL,
  BOARD_URGENT,
  BOARD_WORKLOAD,
  conflictLine,
  expiryLabel,
  manageOrderListPath,
  readActivity,
  readBoard,
  readExpiryRows,
  readPickings,
  utcDay,
  type ActivityRow,
  type BoardHome,
  type LowStockRow,
  type PickingCard,
  type UrgentRow,
} from './model.js';

type OrderKind = 'receive' | 'putaway';

type Phase =
  | { name: 'home' }
  | { name: 'low'; rows: LowStockRow[]; count: number }
  | { name: 'expiry'; rows: UrgentRow[] }
  | { name: 'activity'; rows: ActivityRow[] }
  | { name: 'pickings'; rows: PickingCard[] }
  | { name: 'alerts' }
  | { name: 'orders'; kind: OrderKind; rows: ReceiveOrder[]; hasMore: boolean }
  | { name: 'order'; kind: OrderKind; order: ReceiveOrder; rows: ReceiveOrder[]; hasMore: boolean };

export function BoardWork({ onDrill }: { onDrill(open: boolean): void }) {
  const session = useFieldSession();
  const baseUrl = session.store.connection?.baseUrl ?? '';
  const qcOn = moduleOn(session.snapshot, 'module.qc');
  const putawayOn = moduleOn(session.snapshot, 'module.putaway');
  const warehouseOn = moduleOn(session.snapshot, 'module.warehouse');
  const ordersOpen = screenOpen('manageOrders');
  const [home, setHome] = useState<BoardHome | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'home' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const listTicket = useRef(0);
  const day = utcDay();

  useEffect(() => {
    onDrill(phase.name !== 'home');
    return () => onDrill(false);
  }, [onDrill, phase.name]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [orders, workload, stock, urgent, alerts, flow, conflicts] = await Promise.all([
          fieldGet(baseUrl, BOARD_ORDERS),
          fieldGet(baseUrl, BOARD_WORKLOAD),
          fieldGet(baseUrl, BOARD_STOCK),
          fieldGet(baseUrl, BOARD_URGENT),
          fieldGet(baseUrl, BOARD_ALERTS),
          fieldGet(baseUrl, BOARD_FLOW),
          fieldGet(baseUrl, BOARD_CONFLICTS),
        ]);
        if (cancelled) return;
        const next = readBoard({ orders, workload, stock, urgent, alerts, flow, conflicts }, qcOn, day);
        setHome(next);
        setError(next ? null : '没读到看板');
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, '没发出去，看完再试'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, day, qcOn, tick]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function openOrders(kind: OrderKind, offset: number, prev: ReceiveOrder[]) {
    const ticket = ++listTicket.current;
    setError(null);
    setLoading(true);
    if (offset === 0) setPhase({ name: 'orders', kind, rows: [], hasMore: false });
    try {
      const page = readReceivePage(await fieldGet(baseUrl, manageOrderListPath(kind, qcOn, offset)));
      if (ticket !== listTicket.current) return;
      if (!page) {
        setError(kind === 'receive' ? '没读到待收列表' : '没读到待上架列表');
        return;
      }
      setPhase({ name: 'orders', kind, rows: [...prev, ...page.rows], hasMore: page.hasMore });
    } catch (err) {
      if (ticket === listTicket.current) setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      if (ticket === listTicket.current) setLoading(false);
    }
  }

  async function openLow() {
    setError(null);
    setLoading(true);
    try {
      const body = await fieldGet(baseUrl, BOARD_STOCK_FULL);
      const next = readBoard(
        { orders: [], workload: { pickingOpen: 0 }, stock: body, urgent: [], alerts: emptyAlerts(), flow: [], conflicts: [] },
        false,
        day,
      );
      if (!next) {
        setError('没读到低库存');
        return;
      }
      setPhase({ name: 'low', rows: next.lowStock, count: next.lowStockCount });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setLoading(false);
    }
  }

  async function openList(kind: 'expiry' | 'activity' | 'pickings') {
    setError(null);
    setLoading(true);
    try {
      if (kind === 'expiry') {
        const rows = readExpiryRows(await fieldGet(baseUrl, BOARD_EXPIRY));
        if (!rows) {
          setError('没读到临期');
          return;
        }
        setPhase({ name: 'expiry', rows });
      } else if (kind === 'activity') {
        const rows = readActivity(await fieldGet(baseUrl, BOARD_ACTIVITY));
        if (!rows) {
          setError('没读到库存变动');
          return;
        }
        setPhase({ name: 'activity', rows });
      } else {
        const rows = readPickings(await fieldGet(baseUrl, BOARD_PICKINGS));
        if (!rows) {
          setError('没读到待拣');
          return;
        }
        setPhase({ name: 'pickings', rows });
      }
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setLoading(false);
    }
  }

  if (!home && loading) return <p className="field-empty">正在读取</p>;
  if (!home) {
    return (
      <>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <button type="button" className="field-secondary" onClick={() => setTick((value) => value + 1)}>
          刷新
        </button>
      </>
    );
  }

  if (phase.name === 'low') {
    return (
      <>
        <h1 className="field-title">全库低库存</h1>
        <p className="field-hint">按补货点，不是库存查找</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <p className="field-figure">{phase.count}</p>
        <QtyList>
          {phase.rows.map((row) => (
            <li key={row.skuCode}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {row.name} 可用 {row.available} / 补货点 {row.reorderPoint}
              </span>
            </li>
          ))}
        </QtyList>
        {phase.rows.length === 0 ? <p className="field-empty">没有低库存</p> : null}
        <Back onClick={() => setPhase({ name: 'home' })} />
      </>
    );
  }

  if (phase.name === 'expiry') {
    return (
      <>
        <h1 className="field-title">全库临期</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <QtyList>
          {phase.rows.map((row) => (
            <li key={`${row.skuCode}-${row.batchNo}`}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {row.batchNo} {expiryLabel(row.level)} {row.batchExpiryDate} 实物 {row.quantity}
              </span>
            </li>
          ))}
        </QtyList>
        {phase.rows.length === 0 ? <p className="field-empty">没有临期</p> : null}
        <Back onClick={() => setPhase({ name: 'home' })} />
      </>
    );
  }

  if (phase.name === 'activity') {
    return (
      <>
        <h1 className="field-title">最近库存变动</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <QtyList>
          {phase.rows.map((row) => (
            <li key={row.eventId}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {row.locationCode} {row.delta} {row.reason}
              </span>
            </li>
          ))}
        </QtyList>
        {phase.rows.length === 0 ? <p className="field-empty">没有库存变动</p> : null}
        <Back onClick={() => setPhase({ name: 'home' })} />
      </>
    );
  }

  if (phase.name === 'pickings') {
    return (
      <>
        <h1 className="field-title">全库待拣</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {phase.rows.map((row) => (
          <p key={row.pickingNo} className="field-card">
            <span className="field-mono">{row.pickingNo}</span>
            <span className="field-meta">{row.lineCount} 行{row.note ? ` · ${row.note}` : ''}</span>
          </p>
        ))}
        {phase.rows.length === 0 ? <p className="field-empty">没有待拣</p> : null}
        <Back onClick={() => setPhase({ name: 'home' })} />
      </>
    );
  }

  if (phase.name === 'orders' || phase.name === 'order') {
    const title = phase.kind === 'receive' ? '全库待收' : '全库待上架';
    return (
      <OrderDrill
        title={title}
        empty={phase.kind === 'receive' ? '没有待收' : '没有待上架'}
        rows={phase.rows}
        hasMore={phase.hasMore}
        order={phase.name === 'order' ? phase.order : null}
        loading={loading}
        error={error}
        warehouseOn={warehouseOn}
        onOpen={(order) => setPhase({ name: 'order', kind: phase.kind, order, rows: phase.rows, hasMore: phase.hasMore })}
        onMore={() => void openOrders(phase.kind, phase.rows.length, phase.rows)}
        onBack={() => {
          if (phase.name === 'order') {
            setPhase({ name: 'orders', kind: phase.kind, rows: phase.rows, hasMore: phase.hasMore });
            return;
          }
          listTicket.current += 1;
          setPhase({ name: 'home' });
        }}
      />
    );
  }

  if (phase.name === 'alerts') {
    return (
      <>
        <h1 className="field-title">全库异常</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <p className="field-hint">冻结 {home.holdCount} 笔</p>
        <QtyList>
          {home.negativeBuckets.map((row) => (
            <li key={`${row.skuCode}-${row.locationCode}-${row.batchNo}`}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {row.locationCode} {row.batchNo} {row.quantity}
              </span>
            </li>
          ))}
        </QtyList>
        <ul className="field-switches">
          {home.conflicts.map((row) => (
            <li key={row.eventId}>
              <span>{conflictLine(row)}</span>
            </li>
          ))}
        </ul>
        {home.negativeBuckets.length === 0 && home.conflicts.length === 0 ? <p className="field-empty">没有异常明细</p> : null}
        <Back onClick={() => setPhase({ name: 'home' })} />
      </>
    );
  }

  return (
    <>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <h2 className="field-section">作业</h2>
      <div className="field-metrics">
      <section className="field-card field-metric" aria-label="全库待收">
        <span className="field-kicker">全库待收</span>
        <span className="field-figure">{home.receive}</span>
        {ordersOpen ? (
          <button type="button" className="field-secondary" onClick={() => void openOrders('receive', 0, [])}>
            查看待收
          </button>
        ) : null}
      </section>
      {putawayOn ? (
        <section className="field-card field-metric" aria-label="全库待上架">
          <span className="field-kicker">全库待上架</span>
          <span className="field-figure">{home.putaway}</span>
          {ordersOpen ? (
            <button type="button" className="field-secondary" onClick={() => void openOrders('putaway', 0, [])}>
              查看待上架
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="field-card field-metric" aria-label="全库待拣">
        <span className="field-kicker">全库待拣</span>
        <span className="field-figure">{home.pickingOpen}</span>
        <button type="button" className="field-secondary" onClick={() => void openList('pickings')}>
          查看待拣
        </button>
      </section>
      </div>
      <h2 className="field-section">库存</h2>
      <section className="field-card field-tile" aria-label="全库低库存">
        <span className="field-kicker">全库低库存</span>
        <span className="field-figure">{home.lowStockCount}</span>
        <QtyList>
          {home.lowStock.map((row) => (
            <li key={row.skuCode}>
              <span>
                <span className="field-mono">{row.skuCode}</span> 可用 {row.available}
              </span>
            </li>
          ))}
        </QtyList>
        <button type="button" className="field-secondary" onClick={() => void openLow()}>
          查看全部低库存
        </button>
      </section>
      <section className="field-card field-tile" aria-label="全库临期">
        <span className="field-kicker">全库临期</span>
        <p className="field-hint">
          过期 {home.expiredCount} · 临界 {home.criticalCount} · 警告 {home.warningCount}
        </p>
        <QtyList>
          {home.urgent.map((row) => (
            <li key={`${row.skuCode}-${row.batchNo}`}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {expiryLabel(row.level)}
              </span>
            </li>
          ))}
        </QtyList>
        <button type="button" className="field-secondary" onClick={() => void openList('expiry')}>
          查看临期
        </button>
      </section>
      <h2 className="field-section">今天</h2>
      <section className="field-card field-tile" aria-label="全库今日收发">
        <span className="field-kicker">全库今日收发</span>
        <span className="field-meta">按服务器日期 {home.today?.day ?? day}{home.today ? '' : ' 没有这一天'}</span>
        <span className="field-row">
          <span>入库</span>
          <span className="field-mono">{home.today?.inbound ?? 0}</span>
        </span>
        <span className="field-row">
          <span>出库</span>
          <span className="field-mono">{home.today?.outbound ?? 0}</span>
        </span>
        <button type="button" className="field-secondary" onClick={() => void openList('activity')}>
          最近库存变动
        </button>
      </section>
      <section className="field-card field-tile" aria-label="全库异常">
        <span className="field-kicker">全库异常</span>
        <p className="field-hint">
          过期 {home.expiredCount} · 负库存 {home.negativeCount} · 冻结 {home.holdCount} · 冲突 {home.conflicts.length}
        </p>
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'alerts' })}>
          查看异常
        </button>
      </section>
      <button type="button" className="field-secondary" onClick={() => setTick((value) => value + 1)}>
        刷新
      </button>
    </>
  );
}

function emptyAlerts() {
  return {
    expiredCount: 0,
    criticalCount: 0,
    warningCount: 0,
    holdCount: 0,
    negativeCount: 0,
    negativeBuckets: [],
  };
}

function QtyList({ children }: { children: ReactNode }) {
  return <ul className="field-switches">{children}</ul>;
}

function Back({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="field-secondary" onClick={onClick}>
      返回
    </button>
  );
}
