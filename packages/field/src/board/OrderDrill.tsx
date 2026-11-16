import { inboundStateLabel, orderUnassigned, type ReceiveOrder } from '../receive/model.js';
import { useFieldSession } from '../session.js';

/** 看板磁贴下的只读单据。没有收货、上架或确认按钮。 */
export function OrderDrill({
  title,
  empty,
  rows,
  hasMore,
  order,
  loading,
  error,
  warehouseOn,
  onOpen,
  onMore,
  onBack,
}: {
  title: string;
  empty: string;
  rows: ReceiveOrder[];
  hasMore: boolean;
  order: ReceiveOrder | null;
  loading: boolean;
  error: string | null;
  warehouseOn: boolean;
  onOpen(order: ReceiveOrder): void;
  onMore(): void;
  onBack(): void;
}) {
  if (order) {
    return (
      <>
        <h1 className="field-title">{title}</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <OrderFace order={order} warehouseOn={warehouseOn} />
        <ul className="field-switches">
          {order.lines.map((line) => (
            <li key={`${line.skuCode}-${line.locationCode}-${line.batchNo}`}>
              <span>
                <span className="field-mono">{line.skuCode}</span> {line.name} {String(line.quantity)}{line.unit ?? ''} · {line.locationCode} · {line.batchNo}
                {line.batchExpiryDate ? ` · ${line.batchExpiryDate}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <Back onClick={onBack} />
      </>
    );
  }

  return (
    <>
      <h1 className="field-title">{title}</h1>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {loading ? <p className="field-empty">正在读取</p> : null}
      {rows.length === 0 && !loading ? <p className="field-empty">{empty}</p> : null}
      {rows.map((row) => (
        <button
          key={row.orderNo}
          type="button"
          className="field-choice"
          aria-label={row.orderNo}
          onClick={() => onOpen(row)}
        >
          <OrderFace order={row} warehouseOn={warehouseOn} />
        </button>
      ))}
      {hasMore ? (
        <button type="button" className="field-secondary" onClick={onMore}>
          还有更新的单
        </button>
      ) : null}
      <Back onClick={onBack} />
    </>
  );
}

function OrderFace({ order, warehouseOn }: { order: ReceiveOrder; warehouseOn: boolean }) {
  const session = useFieldSession();
  return (
    <>
      <span className="field-mono">{order.orderNo}</span>
      {warehouseOn && orderUnassigned(order) ? <span className="field-badge">未分仓</span> : null}
      <span className="field-meta">{order.partnerName || order.partnerCode || '未填往来单位'}</span>
      {order.returnOfOrderNo ? <span className="field-meta">退货 · 原单 {order.returnOfOrderNo}</span> : null}
      <span className="field-meta">
        {order.lines.length} 行 · {inboundStateLabel(session.snapshot, order.state)}
      </span>
    </>
  );
}

function Back({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="field-secondary" onClick={onClick}>
      返回
    </button>
  );
}
