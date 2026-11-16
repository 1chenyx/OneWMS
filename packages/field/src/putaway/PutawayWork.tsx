import { useEffect, useMemo, useRef, useState } from 'react';
import { fieldGet, moduleOn } from '../api.js';
import { OnlineCommandPort } from '../command.js';
import { FieldApiError, errorMessage } from '../errors.js';
import { checkLocation, checkSku, inboundStateLabel, orderUnassigned, readReceiveOrder, readReceivePage, type ReceiveOrder } from '../receive/model.js';
import { lookupLocation, lookupSku } from '../scan/lookup.js';
import { useScanConsole } from '../scan/ScanProvider.js';
import { useFieldSession } from '../session.js';
import { clearPutawayDraft, loadPutawayDraft, savePutawayDraft, type PutawayDraftRecord } from './draft.js';
import {
  buildPutawayBody,
  nextPutawayStep,
  orderOnPutawayList,
  prevPutawayStep,
  putawayLanded,
  putawayListPath,
  putawayMoveSteps,
  putawayStepFromToken,
  putawayStepToken,
  readPutawayWarning,
  readTarget,
  type PutawayMoveStep,
} from './model.js';

type Phase =
  | { name: 'list'; rows: ReceiveOrder[]; hasMore: boolean }
  | { name: 'detail'; order: ReceiveOrder }
  | { name: 'hold'; order: ReceiveOrder }
  | { name: 'move'; order: ReceiveOrder; targets: (string | null)[]; cursor: PutawayMoveStep }
  | { name: 'done'; orderNo: string; moved: boolean; warning: string | null };

function presentError(err: unknown): { code: string; text: string } {
  if (!(err instanceof FieldApiError)) return { code: 'FIELD_OFFLINE', text: '没发出去，看完再试' };
  if (err.code === 'WMS_ZONE_USE') return { code: err.code, text: `${err.message} 这个库位不能上架` };
  if (err.code === 'WMS_INVALID_TRANSITION') return { code: err.code, text: '电脑上已经改过这张单' };
  if (err.code === 'WMS_QC_REQUIRED') return { code: err.code, text: err.message };
  if (err.code === 'FIELD_OFFLINE') return { code: err.code, text: '没发出去，看完再试' };
  return { code: err.code, text: err.message };
}

export function PutawayWork({
  seedOrderNo,
  onSeedConsumed,
  onExit,
}: {
  seedOrderNo: string | null;
  onSeedConsumed(): void;
  onExit(): void;
}) {
  const session = useFieldSession();
  const scan = useScanConsole();
  const baseUrl = session.store.connection?.baseUrl ?? '';
  const warehouseOn = moduleOn(session.snapshot, 'module.warehouse');
  const warehouseCode = warehouseOn ? session.store.prefs.warehouseCode : null;
  const qcOn = moduleOn(session.snapshot, 'module.qc');
  const port = useMemo(() => new OnlineCommandPort(baseUrl), [baseUrl]);
  const clientId = useRef(crypto.randomUUID()).current;
  const [phase, setPhase] = useState<Phase>({ name: 'list', rows: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [raw, setRaw] = useState('');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const pendingRef = useRef(false);
  const flagsRef = useRef({ warehouseCode, qcOn });
  flagsRef.current = { warehouseCode, qcOn };
  const lastScanRef = useRef<{ token: string; raw: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = phase.name === 'move' ? putawayStepToken(phase.cursor) : '';

  useEffect(() => {
    if (!moduleOn(session.snapshot, 'module.putaway')) {
      clearPutawayDraft(window.localStorage);
    }
  }, [session.snapshot]);

  useEffect(() => {
    if (phase.name !== 'move') return;
    const record: PutawayDraftRecord = {
      kind: 'putaway',
      docNo: phase.order.orderNo,
      step: putawayStepToken(phase.cursor),
      targets: phase.targets,
      updatedAt: new Date().toISOString(),
    };
    savePutawayDraft(window.localStorage, record);
  }, [phase]);

  useEffect(() => {
    if (phase.name !== 'move') return;
    const step = phase.cursor;
    if (step.kind === 'source') setRaw(phase.order.lines[step.lineIndex]!.locationCode);
    else setRaw('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!seedOrderNo) return;
    let cancelled = false;
    setLoading(true);
    void fieldGet(baseUrl, `/api/orders/${encodeURIComponent(seedOrderNo)}`)
      .then((body) => {
        if (cancelled) return;
        const order = readReceiveOrder(body);
        if (!order || !orderOnPutawayList(order, flagsRef.current.qcOn)) {
          setError(order && flagsRef.current.qcOn && order.state === 'received' ? '要先质检' : '电脑上已经改过这张单');
          return;
        }
        setPhase({ name: 'detail', order });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, '没发出去，看完再试'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          onSeedConsumed();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, onSeedConsumed, seedOrderNo]);

  useEffect(() => {
    if (seedOrderNo || phaseRef.current.name !== 'list' || phaseRef.current.rows.length > 0) return;
    void loadList(0, []);
    // 只在进入上架时拉第一页。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => scan.subscribe((event) => void onScan(event.raw)), [scan]);

  function setBusy(value: boolean) {
    pendingRef.current = value;
    setPending(value);
  }

  async function loadList(offset: number, prev: ReceiveOrder[]) {
    setLoading(true);
    setError(null);
    setStale(false);
    try {
      const page = readReceivePage(await fieldGet(baseUrl, putawayListPath(flagsRef.current.qcOn, flagsRef.current.warehouseCode, offset)));
      if (!page) {
        setError('没读到待上架');
        return;
      }
      setPhase({ name: 'list', rows: [...prev, ...page.rows], hasMore: page.hasMore });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setLoading(false);
    }
  }

  function startMove(order: ReceiveOrder) {
    const saved = loadPutawayDraft(window.localStorage);
    const steps = putawayMoveSteps(order);
    const targets = order.lines.map((_, index) => (saved?.docNo === order.orderNo ? (saved.targets[index] ?? null) : null));
    const cursor = saved?.docNo === order.orderNo ? putawayStepFromToken(saved.step, steps) : steps[0]!;
    setStale(false);
    setPhase({ name: 'move', order, targets, cursor });
  }

  async function acceptSource(text: string) {
    const current = phaseRef.current;
    if (current.name !== 'move' || current.cursor.kind !== 'source') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const line = current.order.lines[current.cursor.lineIndex]!;
    setBusy(true);
    setError(null);
    try {
      const hit = await lookupLocation(baseUrl, trimmed);
      if (phaseRef.current.name !== 'move' || putawayStepToken(phaseRef.current.cursor) !== putawayStepToken(current.cursor)) return;
      const message = checkLocation(hit, line.locationCode, flagsRef.current.warehouseCode);
      if (message) {
        setError(message);
        return;
      }
      const steps = putawayMoveSteps(current.order);
      setPhase({ ...current, cursor: nextPutawayStep(steps, current.cursor) });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function acceptSku(text: string) {
    const current = phaseRef.current;
    if (current.name !== 'move' || current.cursor.kind !== 'sku') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const line = current.order.lines[current.cursor.lineIndex]!;
    setBusy(true);
    setError(null);
    try {
      const hit = await lookupSku(baseUrl, trimmed);
      if (phaseRef.current.name !== 'move' || putawayStepToken(phaseRef.current.cursor) !== putawayStepToken(current.cursor)) return;
      const message = checkSku(hit, line.skuCode);
      if (message) {
        setError(message);
        return;
      }
      const steps = putawayMoveSteps(current.order);
      setPhase({ ...current, cursor: nextPutawayStep(steps, current.cursor) });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function placeLine(text: string) {
    const current = phaseRef.current;
    if (current.name !== 'move' || current.cursor.kind !== 'target') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const index = current.cursor.lineIndex;
    const line = current.order.lines[index]!;
    setBusy(true);
    setError(null);
    try {
      const hit = await lookupLocation(baseUrl, trimmed);
      if (phaseRef.current.name !== 'move' || putawayStepToken(phaseRef.current.cursor) !== putawayStepToken(current.cursor)) return;
      const result = readTarget(hit, line.locationCode, flagsRef.current.warehouseCode);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const targets = current.targets.map((item, itemIndex) => (itemIndex === index ? result.toLocationCode : item));
      const steps = putawayMoveSteps(current.order);
      setPhase({ ...current, targets, cursor: nextPutawayStep(steps, current.cursor) });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  function leaveLine() {
    const current = phaseRef.current;
    if (current.name !== 'move' || current.cursor.kind !== 'target') return;
    const index = current.cursor.lineIndex;
    const targets = current.targets.map((item, itemIndex) => (itemIndex === index ? null : item));
    const steps = putawayMoveSteps(current.order);
    setPhase({ ...current, targets, cursor: nextPutawayStep(steps, current.cursor) });
  }

  async function onScan(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pendingRef.current) return;
    const current = phaseRef.current;
    if (current.name !== 'move' || current.cursor.kind === 'confirm') return;
    const tokenNow = putawayStepToken(current.cursor);
    if (lastScanRef.current?.token === tokenNow && lastScanRef.current.raw === trimmed) {
      setError('刚扫过');
      return;
    }
    lastScanRef.current = { token: tokenNow, raw: trimmed };
    setRaw(trimmed);
    if (current.cursor.kind === 'source') await acceptSource(trimmed);
    else if (current.cursor.kind === 'sku') await acceptSku(trimmed);
    else await placeLine(trimmed);
  }

  function finish(orderNo: string, moved: boolean, warning: string | null) {
    clearPutawayDraft(window.localStorage);
    setStale(false);
    setPhase({ name: 'done', orderNo, moved, warning });
  }

  async function submit(order: ReceiveOrder, targets: (string | null)[] | null) {
    if (pendingRef.current || !session.online) return;
    setBusy(true);
    setError(null);
    const body = targets ? buildPutawayBody(order.lines, targets) : {};
    const path = `/api/orders/${encodeURIComponent(order.orderNo)}`;
    try {
      let response: unknown;
      try {
        response = await port.submit({ clientId, method: 'POST', path: `${path}/putaway`, body });
      } catch (err) {
        if (err instanceof FieldApiError && err.code === 'FIELD_OFFLINE') {
          try {
            const fresh = readReceiveOrder(await fieldGet(baseUrl, path));
            if (fresh && putawayLanded(fresh)) {
              finish(order.orderNo, Boolean(body.targets?.length), null);
              return;
            }
          } catch {
            /* 状态还在待上架，不自动再提交 */
          }
        }
        if (err instanceof FieldApiError && err.code === 'WMS_PUTAWAY_ORDER_SHARE') {
          try {
            const fresh = readReceiveOrder(await fieldGet(baseUrl, path));
            if (fresh && phaseRef.current.name === 'move') {
              setPhase({ ...phaseRef.current, order: fresh });
            } else if (fresh && phaseRef.current.name === 'hold') {
              setPhase({ name: 'hold', order: fresh });
            }
          } catch {
            /* 刷新失败仍把份额不够留在确认屏 */
          }
        }
        throw err;
      }
      finish(order.orderNo, Boolean(body.targets?.length), readPutawayWarning(response));
    } catch (err) {
      const presented = presentError(err);
      if (presented.code === 'WMS_INVALID_TRANSITION' || presented.code === 'WMS_QC_REQUIRED') setStale(true);
      setError(presented.text);
    } finally {
      setBusy(false);
    }
  }

  if (phase.name === 'list') {
    return (
      <>
        <h1 className="field-title">待上架</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {loading ? <p className="field-empty">正在读取</p> : null}
        {phase.rows.length === 0 && !loading ? <p className="field-empty">没有待上架</p> : null}
        {phase.rows.map((order) => (
          <button key={order.orderNo} type="button" className="field-choice" aria-label={order.orderNo} onClick={() => setPhase({ name: 'detail', order })}>
            <span className="field-mono">{order.orderNo}</span>
            {warehouseOn && orderUnassigned(order) ? <span className="field-badge">未分仓</span> : null}
            <span className="field-meta">{order.partnerName || order.partnerCode || '未填往来单位'}</span>
            <span className="field-meta">
              {order.lines.length} 行 · {inboundStateLabel(session.snapshot, order.state)}
            </span>
          </button>
        ))}
        {phase.hasMore ? (
          <button type="button" className="field-secondary" onClick={() => void loadList(phase.rows.length, phase.rows)}>
            还有更新的单
          </button>
        ) : null}
        <button type="button" className="field-secondary" onClick={onExit}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'detail') {
    const order = phase.order;
    return (
      <>
        <h1 className="field-title">上架</h1>
        <p className="field-mono">{order.orderNo}</p>
        <ul className="field-switches">
          {order.lines.map((line) => (
            <li key={`${line.skuCode}-${line.locationCode}-${line.batchNo}`}>
              <span>
                <span className="field-mono">{line.skuCode}</span> {line.name} {line.quantity}
                {line.unit ?? ''} · {line.locationCode} · {line.batchNo}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="field-primary" onClick={() => startMove(order)}>
          开始上架
        </button>
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'hold', order })}>
          只确认、先不挪货
        </button>
        <button type="button" className="field-secondary" onClick={() => void loadList(0, [])}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'hold') {
    return (
      <>
        <h1 className="field-title">确认上架</h1>
        <p>货留在收货库位，单据变为已上架</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {stale ? (
          <button type="button" className="field-primary" onClick={() => void loadList(0, [])}>
            回列表
          </button>
        ) : (
          <button type="button" className="field-primary" disabled={pending || !session.online} onClick={() => void submit(phase.order, null)}>
            确认上架
          </button>
        )}
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'detail', order: phase.order })}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'done') {
    return (
      <>
        <h1 className="field-title">已上架</h1>
        <p className="field-mono">{phase.orderNo}</p>
        <p>已上架</p>
        <p className="field-hint">
          {phase.moved ? '库存已挪到目标库位。电脑上还要再点一次完成。' : '货留在收货库位。电脑上还要再点一次完成。'}
        </p>
        {phase.warning ? <p className="field-warn">{phase.warning}</p> : null}
        <button type="button" className="field-primary" onClick={() => void loadList(0, [])}>
          下一张
        </button>
      </>
    );
  }

  const order = phase.order;
  const step = phase.cursor;
  const line = step.kind === 'confirm' ? undefined : order.lines[step.lineIndex];
  const titles = { source: '核对库位', sku: '扫货', target: '目标库位', confirm: '确认上架' };

  return (
    <div data-scan-step={step.kind === 'confirm' ? undefined : ''}>
      <h1 className="field-title">{titles[step.kind]}</h1>
      <p className="field-mono">{order.orderNo}</p>
      {line ? (
        <p className="field-hint">
          <span className="field-mono">{line.skuCode}</span> {line.quantity}
          {line.unit ?? ''} · {line.locationCode} · {line.batchNo}
        </p>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {step.kind !== 'confirm' ? (
        <>
          <label className="field-label" htmlFor="field-putaway-raw">
            {step.kind === 'source' ? '库位' : step.kind === 'sku' ? '货品' : '目标库位'}
          </label>
          <input
            id="field-putaway-raw"
            ref={inputRef}
            className="field-input field-mono"
            autoCapitalize="none"
            autoCorrect="off"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <button type="button" className="field-secondary" onClick={() => inputRef.current?.focus()}>
            改用手输
          </button>
        </>
      ) : null}
      {step.kind === 'source' ? (
        <button type="button" className="field-primary" disabled={pending} onClick={() => void acceptSource(raw)}>
          确认库位
        </button>
      ) : null}
      {step.kind === 'sku' ? (
        <button type="button" className="field-primary" disabled={pending} onClick={() => void acceptSku(raw)}>
          确认货品
        </button>
      ) : null}
      {step.kind === 'target' && line ? (
        <>
          <p className="field-hint">这一行搬走 {line.quantity}</p>
          <button type="button" className="field-primary" disabled={pending} onClick={() => void placeLine(raw)}>
            此行放入
          </button>
          <button type="button" className="field-secondary" onClick={leaveLine}>
            这一行留在原位
          </button>
        </>
      ) : null}
      {step.kind === 'confirm' ? (
        <>
          <ul className="field-switches">
            {order.lines.map((item, index) => {
              const to = phase.targets[index];
              const stay = !to || to === item.locationCode;
              return (
                <li key={`${item.skuCode}-${item.locationCode}-${item.batchNo}`}>
                  <span>
                    <span className="field-mono">{item.skuCode}</span> {item.locationCode} → {stay ? '留在原位' : to}
                  </span>
                </li>
              );
            })}
          </ul>
          {stale ? (
            <button type="button" className="field-primary" onClick={() => void loadList(0, [])}>
              回列表
            </button>
          ) : (
            <button type="button" className="field-primary" disabled={pending || !session.online} onClick={() => void submit(order, phase.targets)}>
              确认上架
            </button>
          )}
        </>
      ) : null}
      {step.kind === 'confirm' ? null : (
        <button
          type="button"
          className="field-secondary"
          onClick={() => {
            const steps = putawayMoveSteps(order);
            const prev = prevPutawayStep(steps, step);
            if (prev) setPhase({ ...phase, cursor: prev });
            else setPhase({ name: 'detail', order });
          }}
        >
          返回
        </button>
      )}
    </div>
  );
}
