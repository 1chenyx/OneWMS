import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fieldGet, moduleOn } from '../api.js';
import { OnlineCommandPort } from '../command.js';
import { FieldApiError, errorMessage } from '../errors.js';
import { lookupLocation, lookupSku } from '../scan/lookup.js';
import { useScanConsole } from '../scan/ScanProvider.js';
import { screenOpen } from '../screens.js';
import { useFieldSession } from '../session.js';
import { clearPutawayDraft, loadPutawayDraft } from '../putaway/draft.js';
import { PutawayWork } from '../putaway/PutawayWork.js';
import { clearReceiveDraft, loadReceiveDraft, saveReceiveDraft, type ReceiveDraftRecord } from './draft.js';
import {
  buildRevise,
  buildTransition,
  checkLocation,
  checkSku,
  commitQty,
  doneHint,
  draftsFromOrder,
  inboundStateLabel,
  locationExpected,
  mergeDrafts,
  nextStep,
  orderUnassigned,
  prevStep,
  pushSerial,
  readReceiveOrder,
  readReceivePage,
  readWarehouses,
  receiveListPath,
  receiveSteps,
  reviseLanded,
  sameSerials,
  serialQtyBlocked,
  showPutawayButton,
  stepFromToken,
  stepToken,
  transitionLanded,
  type ReceiveLineDraft,
  type ReceiveOrder,
  type ReceiveStep,
} from './model.js';

type Phase =
  | { name: 'home' }
  | { name: 'list'; rows: ReceiveOrder[]; hasMore: boolean }
  | { name: 'detail'; order: ReceiveOrder }
  | { name: 'wizard'; order: ReceiveOrder; drafts: ReceiveLineDraft[]; cursor: ReceiveStep }
  | { name: 'done'; orderNo: string };

function presentError(err: unknown): { code: string; text: string } {
  if (!(err instanceof FieldApiError)) return { code: 'FIELD_OFFLINE', text: '没发出去，看完再试' };
  if (err.code === 'WMS_ZONE_USE') return { code: err.code, text: `${err.message} 这个库位不能收货` };
  if (err.code === 'WMS_INVALID_TRANSITION') return { code: err.code, text: '电脑上已经改过这张单' };
  if (err.code === 'FIELD_OFFLINE') return { code: err.code, text: '没发出去，看完再试' };
  return { code: err.code, text: err.message };
}

function lineQty(order: ReceiveOrder): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function FloorWork({
  tab,
  onJob,
  onTab,
}: {
  tab: 'tasks' | 'drafts';
  onJob(open: boolean): void;
  onTab(tab: 'tasks' | 'drafts'): void;
}) {
  const session = useFieldSession();
  const scan = useScanConsole();
  const baseUrl = session.store.connection?.baseUrl ?? '';
  const snapshot = session.snapshot;
  const warehouseOn = moduleOn(snapshot, 'module.warehouse');
  const warehouseCode = warehouseOn ? session.store.prefs.warehouseCode : null;
  const serialModule = moduleOn(snapshot, 'module.serial');
  const partial = moduleOn(snapshot, 'module.partial');
  const receiveOpen = screenOpen('receive') && moduleOn(snapshot, 'core.wms');
  const putawayOpen = screenOpen('putaway') && moduleOn(snapshot, 'module.putaway');
  const [lane, setLane] = useState<'putaway' | null>(null);
  const [putawaySeed, setPutawaySeed] = useState<string | null>(null);
  const consumePutawaySeed = useCallback(() => setPutawaySeed(null), []);
  const port = useMemo(() => new OnlineCommandPort(baseUrl), [baseUrl]);
  const clientId = useRef(crypto.randomUUID()).current;

  const [phase, setPhase] = useState<Phase>({ name: 'home' });
  const [draftRecord, setDraftRecord] = useState<ReceiveDraftRecord | null>(() => loadReceiveDraft(window.localStorage));
  const [warehouses, setWarehouses] = useState<{ warehouseCode: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [qtyLocked, setQtyLocked] = useState(false);
  const [reviseReady, setReviseReady] = useState(false);
  const [raw, setRaw] = useState('');
  const [expiry, setExpiry] = useState('');
  const [progress, setProgress] = useState<string[]>([]);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const pendingRef = useRef(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const flagsRef = useRef({ serialModule, warehouseCode, partial });
  flagsRef.current = { serialModule, warehouseCode, partial };
  const lastScanRef = useRef<{ token: string; raw: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = phase.name === 'wizard' ? stepToken(phase.cursor) : '';

  useEffect(() => {
    onJob(tab === 'tasks' && (lane === 'putaway' || phase.name !== 'home'));
  }, [lane, onJob, phase.name, tab]);

  useEffect(() => {
    if (!moduleOn(session.snapshot, 'core.wms')) {
      clearReceiveDraft(window.localStorage);
      setDraftRecord(null);
    }
    if (!moduleOn(session.snapshot, 'module.putaway')) clearPutawayDraft(window.localStorage);
  }, [session.snapshot]);

  useEffect(() => {
    if (phase.name !== 'wizard') return;
    const record: ReceiveDraftRecord = {
      kind: 'receive',
      docNo: phase.order.orderNo,
      step: stepToken(phase.cursor),
      lines: phase.drafts,
      updatedAt: new Date().toISOString(),
    };
    saveReceiveDraft(window.localStorage, record);
    setDraftRecord(record);
  }, [phase]);

  useEffect(() => {
    if (phase.name !== 'wizard') return;
    const step = phase.cursor;
    if (step.kind === 'location') setRaw(locationExpected(phase.order, step));
    else if (step.kind === 'batch') setRaw(phase.drafts[step.lineIndex]!.batchNo);
    else if (step.kind === 'qty') setRaw(String(phase.drafts[step.lineIndex]!.qty));
    else setRaw('');
    const expiryLine = step.kind === 'batch' ? phase.drafts[step.lineIndex] : undefined;
    setExpiry(expiryLine?.batchExpiryDate ?? '');
    setProgress([]);
    progressRef.current = [];
    // 只在换步骤时预填。错误留在原地，避免确认失败后被清掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (tab !== 'tasks' || phase.name !== 'home' || !warehouseOn || warehouseCode || !baseUrl) return;
    let cancelled = false;
    setWarehouses(null);
    void fieldGet(baseUrl, '/api/warehouses')
      .then((body) => {
        if (!cancelled) setWarehouses(readWarehouses(body));
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, '没发出去，看完再试'));
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, phase.name, tab, warehouseCode, warehouseOn]);

  useEffect(() => scan.subscribe((event) => void onScan(event.raw)), [scan]);

  function setBusy(value: boolean) {
    pendingRef.current = value;
    setPending(value);
  }

  function remember(order: ReceiveOrder, drafts: ReceiveLineDraft[], cursor: ReceiveStep) {
    const steps = receiveSteps(order, drafts, { serialModule: flagsRef.current.serialModule });
    const resolved = steps.some((step) => stepToken(step) === stepToken(cursor)) ? cursor : steps[0]!;
    setError(null);
    setPhase({ name: 'wizard', order, drafts, cursor: resolved });
  }

  function advance(order: ReceiveOrder, drafts: ReceiveLineDraft[], cursor: ReceiveStep) {
    const steps = receiveSteps(order, drafts, { serialModule: flagsRef.current.serialModule });
    remember(order, drafts, nextStep(steps, cursor));
  }

  async function loadList(offset: number, prev: ReceiveOrder[]) {
    setLoading(true);
    setError(null);
    setStale(false);
    try {
      const page = readReceivePage(await fieldGet(baseUrl, receiveListPath(flagsRef.current.warehouseCode, offset)));
      if (!page) {
        setError('没读到待收列表');
        return;
      }
      setPhase({ name: 'list', rows: [...prev, ...page.rows], hasMore: page.hasMore });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setLoading(false);
    }
  }

  async function acceptLocation(text: string) {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'location') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const expected = locationExpected(current.order, current.cursor);
    setBusy(true);
    setError(null);
    try {
      const hit = await lookupLocation(baseUrl, trimmed);
      if (phaseRef.current.name !== 'wizard' || stepToken(phaseRef.current.cursor) !== stepToken(current.cursor)) return;
      const message = checkLocation(hit, expected, flagsRef.current.warehouseCode);
      if (message) {
        setError(message);
        return;
      }
      advance(current.order, current.drafts, current.cursor);
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function acceptSku(text: string) {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'sku') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const expected = current.order.lines[current.cursor.lineIndex]!.skuCode;
    setBusy(true);
    setError(null);
    try {
      const hit = await lookupSku(baseUrl, trimmed);
      if (phaseRef.current.name !== 'wizard' || stepToken(phaseRef.current.cursor) !== stepToken(current.cursor)) return;
      const message = checkSku(hit, expected);
      if (message) {
        setError(message);
        return;
      }
      advance(current.order, current.drafts, current.cursor);
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  function acceptBatch() {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'batch') return;
    const index = current.cursor.lineIndex;
    const line = current.order.lines[index]!;
    const batchNo = raw.trim() || current.drafts[index]!.batchNo;
    if (line.batchNo !== 'DEFAULT') {
      if (batchNo !== line.batchNo) {
        setError('批次不对');
        return;
      }
      advance(current.order, current.drafts, current.cursor);
      return;
    }
    if (batchNo === 'DEFAULT' && expiry.trim()) {
      setError('DEFAULT 不能写效期');
      return;
    }
    const drafts = current.drafts.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const next: ReceiveLineDraft = { key: item.key, qty: item.qty, serials: [...item.serials], batchNo };
      if (batchNo !== 'DEFAULT' && expiry.trim()) next.batchExpiryDate = expiry.trim();
      return next;
    });
    advance(current.order, drafts, current.cursor);
  }

  function acceptQuantity() {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'qty') return;
    const index = current.cursor.lineIndex;
    const line = current.order.lines[index]!;
    const result = commitQty(line, raw, flagsRef.current.partial);
    if (!result.ok) {
      if (result.message) setError(result.message);
      return;
    }
    const drafts = current.drafts.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const serials = line.serialTracked && result.qty !== line.quantity ? [] : item.serials;
      return { ...item, qty: result.qty, serials };
    });
    advance(current.order, drafts, current.cursor);
  }

  function skipLine() {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'qty') return;
    const index = current.cursor.lineIndex;
    const drafts = current.drafts.map((item, itemIndex) =>
      itemIndex === index ? { ...item, qty: 0, serials: [] } : item,
    );
    advance(current.order, drafts, current.cursor);
  }

  async function onScan(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pendingRef.current) return;
    const current = phaseRef.current;
    if (current.name !== 'wizard') return;
    const step = current.cursor;
    if (step.kind === 'confirm' || step.kind === 'qty') return;
    const tokenNow = stepToken(step);
    if (lastScanRef.current?.token === tokenNow && lastScanRef.current.raw === trimmed) {
      setError('刚扫过');
      return;
    }
    lastScanRef.current = { token: tokenNow, raw: trimmed };
    if (step.kind === 'location') {
      setRaw(trimmed);
      await acceptLocation(trimmed);
      return;
    }
    if (step.kind === 'sku') {
      setRaw(trimmed);
      await acceptSku(trimmed);
      return;
    }
    if (step.kind === 'batch') {
      const line = current.order.lines[step.lineIndex]!;
      if (line.batchNo !== 'DEFAULT') {
        if (trimmed !== line.batchNo) setError('批次不对');
        else advance(current.order, current.drafts, current.cursor);
        return;
      }
      setRaw(trimmed);
      return;
    }
    const index = step.lineIndex;
    const line = current.order.lines[index]!;
    const draft = current.drafts[index]!;
    const result = pushSerial(line, draft, progressRef.current, trimmed);
    if (!result.ok) {
      if (result.message) setError(result.message);
      return;
    }
    progressRef.current = result.progress;
    setProgress(result.progress);
    if (result.progress.length < draft.qty) return;
    const verify = (line.serials?.length ?? 0) > 0 && draft.qty === line.quantity;
    if (verify && !sameSerials(result.progress, line.serials ?? [])) {
      setError('不是这张单上的');
      return;
    }
    const drafts = verify
      ? current.drafts
      : current.drafts.map((item, itemIndex) => (itemIndex === index ? { ...item, serials: result.progress } : item));
    advance(current.order, drafts, current.cursor);
  }

  function finish(orderNo: string) {
    clearReceiveDraft(window.localStorage);
    setDraftRecord(null);
    setStale(false);
    setPhase({ name: 'done', orderNo });
  }

  async function submit() {
    const current = phaseRef.current;
    if (current.name !== 'wizard' || current.cursor.kind !== 'confirm' || pendingRef.current || !session.online) return;
    setBusy(true);
    setError(null);
    const orderNo = current.order.orderNo;
    const revise = reviseReady ? null : buildRevise(current.order, current.drafts);
    const transition = buildTransition(current.order, current.drafts);
    const path = `/api/orders/${encodeURIComponent(orderNo)}`;
    try {
      if (revise) {
        try {
          await port.submit({ clientId, method: 'POST', path: `${path}/revise`, body: revise });
          setReviseReady(true);
        } catch (err) {
          if (err instanceof FieldApiError && err.code === 'FIELD_OFFLINE') {
            try {
              const fresh = readReceiveOrder(await fieldGet(baseUrl, path));
              if (fresh && reviseLanded(fresh, revise)) setReviseReady(true);
            } catch {
              /* 对不上就留在确认，让人再提交同一份 */
            }
          }
          throw err;
        }
      }
      try {
        await port.submit({ clientId, method: 'POST', path: `${path}/transition`, body: transition });
      } catch (err) {
        if (err instanceof FieldApiError && err.code === 'FIELD_OFFLINE') {
          try {
            const fresh = readReceiveOrder(await fieldGet(baseUrl, path));
            if (fresh && transitionLanded(fresh)) {
              finish(orderNo);
              return;
            }
          } catch {
            /* 状态没离开待收，不自动再打一次 */
          }
        }
        throw err;
      }
      finish(orderNo);
    } catch (err) {
      const presented = presentError(err);
      if (presented.code === 'WMS_INVALID_TRANSITION') setStale(true);
      if (presented.code === 'WMS_SERIAL_REQUIRED' || presented.code === 'WMS_SERIAL_COUNT') {
        setQtyLocked(true);
        setPhase((p) => {
          if (p.name !== 'wizard') return p;
          const serial = receiveSteps(p.order, p.drafts, { serialModule: flagsRef.current.serialModule }).find(
            (step) => step.kind === 'serial',
          );
          return serial ? { ...p, cursor: serial } : p;
        });
      }
      setError(presented.text);
    } finally {
      setBusy(false);
    }
  }

  function start(order: ReceiveOrder) {
    const saved = loadReceiveDraft(window.localStorage);
    const drafts = saved?.docNo === order.orderNo ? mergeDrafts(order, saved.lines) : draftsFromOrder(order);
    const steps = receiveSteps(order, drafts, { serialModule });
    const cursor = saved?.docNo === order.orderNo ? stepFromToken(saved.step, steps) : steps[0]!;
    setReviseReady(false);
    setQtyLocked(false);
    setStale(false);
    remember(order, drafts, cursor);
  }

  async function resume() {
    const saved = loadReceiveDraft(window.localStorage);
    if (!saved) return;
    if (phaseRef.current.name === 'wizard' && phaseRef.current.order.orderNo === saved.docNo) {
      onTab('tasks');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const order = readReceiveOrder(await fieldGet(baseUrl, `/api/orders/${encodeURIComponent(saved.docNo)}`));
      if (!order || (order.state !== 'created' && order.state !== 'announced')) {
        clearReceiveDraft(window.localStorage);
        setDraftRecord(null);
        setError('电脑上已经改过这张单');
        return;
      }
      const drafts = mergeDrafts(order, saved.lines);
      const steps = receiveSteps(order, drafts, { serialModule });
      setReviseReady(false);
      remember(order, drafts, stepFromToken(saved.step, steps));
      onTab('tasks');
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setLoading(false);
    }
  }

  function leaveWarehouse() {
    session.patchPrefs({ warehouseCode: null });
    setPhase({ name: 'home' });
  }

  if (tab === 'drafts') {
    return (
      <>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {draftRecord && receiveOpen ? (
          <button type="button" className="field-choice" onClick={() => void resume()}>
            <span className="field-mono">{draftRecord.docNo}</span>
            <span className="field-meta">收货还没提交</span>
          </button>
        ) : null}
        {putawayOpen && loadPutawayDraft(window.localStorage) ? (
          <button
            type="button"
            className="field-choice"
            onClick={() => {
              const saved = loadPutawayDraft(window.localStorage);
              if (!saved) return;
              setPutawaySeed(saved.docNo);
              setLane('putaway');
              onTab('tasks');
            }}
          >
            <span className="field-mono">{loadPutawayDraft(window.localStorage)?.docNo}</span>
            <span className="field-meta">上架还没提交</span>
          </button>
        ) : null}
        {!draftRecord && !(putawayOpen && loadPutawayDraft(window.localStorage)) ? (
          <p className="field-empty">没有进行中的作业</p>
        ) : null}
      </>
    );
  }

  if (!receiveOpen && !putawayOpen) return <p className="field-empty">没有待办</p>;

  if (phase.name === 'home' && lane !== 'putaway' && warehouseOn && !warehouseCode) {
    return (
      <>
        <p className="field-kicker">选仓库</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {warehouses === null ? <p className="field-empty">正在读取</p> : null}
        {warehouses && warehouses.length === 0 ? <p className="field-empty">没有仓库</p> : null}
        {warehouses?.map((row) => (
          <button
            key={row.warehouseCode}
            type="button"
            className="field-choice"
            onClick={() => session.patchPrefs({ warehouseCode: row.warehouseCode })}
          >
            <span className="field-mono">{row.warehouseCode}</span>
            <span className="field-meta">{row.name}</span>
          </button>
        ))}
      </>
    );
  }

  if (lane === 'putaway') {
    return (
      <PutawayWork
        seedOrderNo={putawaySeed}
        onSeedConsumed={consumePutawaySeed}
        onExit={() => {
          setLane(null);
          setPhase({ name: 'home' });
        }}
      />
    );
  }

  if (phase.name === 'home') {
    return (
      <>
        {warehouseCode ? (
          <p className="field-kicker">
            当前仓库 <span className="field-mono">{warehouseCode}</span>
          </p>
        ) : null}
        {receiveOpen ? (
          <button type="button" className="field-launch is-suggested" aria-label="待收货" onClick={() => void loadList(0, [])}>
            <span className="field-launch-title">待收货</span>
            <span className="field-meta">按单核对入库</span>
          </button>
        ) : null}
        {putawayOpen ? (
          <button type="button" className="field-launch" aria-label="待上架" onClick={() => setLane('putaway')}>
            <span className="field-launch-title">待上架</span>
            <span className="field-meta">把已收货放到库位</span>
          </button>
        ) : null}
        {warehouseOn && warehouseCode ? (
          <button type="button" className="field-secondary" onClick={leaveWarehouse}>
            换仓库
          </button>
        ) : null}
      </>
    );
  }

  if (phase.name === 'list') {
    return (
      <>
        <h1 className="field-title">待收货</h1>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {phase.rows.length === 0 && !loading ? <p className="field-empty">没有待收</p> : null}
        {phase.rows.map((order) => (
          <button key={order.orderNo} type="button" className="field-choice" aria-label={order.orderNo} onClick={() => setPhase({ name: 'detail', order })}>
            <OrderCard order={order} warehouseOn={warehouseOn} />
          </button>
        ))}
        {phase.hasMore ? (
          <button type="button" className="field-secondary" onClick={() => void loadList(phase.rows.length, phase.rows)}>
            还有更新的单
          </button>
        ) : null}
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'home' })}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'detail') {
    const order = phase.order;
    return (
      <>
        <h1 className="field-title">收货</h1>
        <p className="field-mono">{order.orderNo}</p>
        <OrderCard order={order} warehouseOn={warehouseOn} />
        <ul className="field-switches">
          {order.lines.map((line) => (
            <li key={`${line.skuCode}-${line.locationCode}-${line.batchNo}`}>
              <span>
                <span className="field-mono">{line.skuCode}</span> {line.name} {line.quantity}
                {line.unit ?? ''} · {line.locationCode} · {line.batchNo}
                {line.batchExpiryDate ? ` · ${line.batchExpiryDate}` : ''}
                {line.serials && line.serials.length > 0 ? ` · ${line.serials.join(' ')}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="field-primary" onClick={() => start(order)}>
          开始收货
        </button>
        <button type="button" className="field-secondary" onClick={() => void loadList(0, [])}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'done') {
    const hint = doneHint({
      qcModule: moduleOn(snapshot, 'module.qc'),
      qcScreen: screenOpen('qc'),
      putawayModule: moduleOn(snapshot, 'module.putaway'),
    });
    const putaway = showPutawayButton({
      putawayModule: moduleOn(snapshot, 'module.putaway'),
      qcModule: moduleOn(snapshot, 'module.qc'),
      putawayScreen: screenOpen('putaway'),
    });
    return (
      <>
        <h1 className="field-title">已收货</h1>
        <p className="field-mono">{phase.orderNo}</p>
        <p>已收货</p>
        <p className="field-hint">{hint}</p>
        <button type="button" className="field-primary" onClick={() => void loadList(0, [])}>
          下一张
        </button>
        {putaway ? (
          <button
            type="button"
            className="field-secondary"
            onClick={() => {
              setPutawaySeed(phase.orderNo);
              setLane('putaway');
            }}
          >
            去上架
          </button>
        ) : null}
      </>
    );
  }

  const order = phase.order;
  const step = phase.cursor;
  const line = step.kind === 'confirm' || step.lineIndex === null ? undefined : order.lines[step.lineIndex];
  const draft = step.kind === 'confirm' || step.lineIndex === null ? undefined : phase.drafts[step.lineIndex];
  const titles: Record<ReceiveStep['kind'], string> = {
    location: '核对库位',
    sku: '扫货',
    qty: '数量',
    serial: '序列号',
    batch: '批次',
    confirm: '确认收货',
  };

  return (
    <div data-scan-step={step.kind === 'qty' || step.kind === 'confirm' ? undefined : ''}>
      <h1 className="field-title">{titles[step.kind]}</h1>
      <p className="field-mono">{order.orderNo}</p>
      {line ? (
        <p className="field-hint">
          <span className="field-mono">{line.skuCode}</span>
          {step.kind === 'sku' ? ` 还要 ${line.quantity}` : ''} · {line.locationCode}
        </p>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {step.kind === 'location' || step.kind === 'sku' || step.kind === 'batch' || step.kind === 'serial' ? (
        <>
          <label className="field-label" htmlFor="field-receive-raw">
            {step.kind === 'location' ? '库位' : step.kind === 'sku' ? '货品' : step.kind === 'batch' ? '批次' : '序列号'}
          </label>
          <input
            id="field-receive-raw"
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
      {step.kind === 'location' ? (
        <button type="button" className="field-primary" disabled={pending} onClick={() => void acceptLocation(raw)}>
          确认库位
        </button>
      ) : null}
      {step.kind === 'sku' ? (
        <button type="button" className="field-primary" disabled={pending} onClick={() => void acceptSku(raw)}>
          确认货品
        </button>
      ) : null}
      {step.kind === 'qty' && line && draft ? (
        <>
          {serialQtyBlocked(line) ? <p className="field-error">WMS_SERIAL_COUNT 回电脑改单</p> : null}
          <label className="field-label" htmlFor="field-receive-qty">
            数量
          </label>
          <input
            id="field-receive-qty"
            className="field-input field-mono"
            inputMode="decimal"
            value={raw}
            readOnly={!partial || qtyLocked || serialQtyBlocked(line)}
            onChange={(event) => setRaw(event.target.value)}
          />
          {serialQtyBlocked(line) ? null : (
            <button type="button" className="field-primary" onClick={acceptQuantity}>
              行确认
            </button>
          )}
          {partial && !line.serialTracked ? (
            <button type="button" className="field-secondary" onClick={skipLine}>
              跳过此行
            </button>
          ) : null}
        </>
      ) : null}
      {step.kind === 'serial' && draft ? (
        <>
          <p className="field-hint">还要 {Math.max(draft.qty - progress.length, 0)}</p>
          <ul className="field-switches">
            {progress.map((serial) => (
              <li key={serial}>
                <span className="field-mono">{serial}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="field-primary" onClick={() => void onScan(raw)}>
            记下这个号
          </button>
        </>
      ) : null}
      {step.kind === 'batch' && line ? (
        <>
          {raw.trim() !== '' && raw.trim() !== 'DEFAULT' ? (
            <>
              <label className="field-label" htmlFor="field-receive-expiry">
                效期
              </label>
              <input
                id="field-receive-expiry"
                className="field-input field-mono"
                placeholder="YYYY-MM-DD"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </>
          ) : null}
          <button type="button" className="field-primary" onClick={acceptBatch}>
            批次没错
          </button>
        </>
      ) : null}
      {step.kind === 'confirm' ? (
        <>
          <ul className="field-switches">
            {order.lines.map((item, index) => (
              <li key={phase.drafts[index]!.key}>
                <span>
                  <span className="field-mono">{item.skuCode}</span> {phase.drafts[index]!.qty}
                  {item.quantity !== phase.drafts[index]!.qty ? ` / ${item.quantity}` : ''} · {item.locationCode} · {phase.drafts[index]!.batchNo}
                </span>
              </li>
            ))}
          </ul>
          {stale ? (
            <button type="button" className="field-primary" onClick={() => void loadList(0, [])}>
              回列表
            </button>
          ) : (
            <button type="button" className="field-primary" disabled={pending || !session.online} onClick={() => void submit()}>
              确认收货
            </button>
          )}
          <button
            type="button"
            className="field-secondary"
            onClick={() => {
              const qty = receiveSteps(order, phase.drafts, { serialModule }).find((item) => item.kind === 'qty');
              if (qty) remember(order, phase.drafts, qty);
            }}
          >
            返回改数量
          </button>
        </>
      ) : (
        <button
          type="button"
          className="field-secondary"
          onClick={() => {
            const steps = receiveSteps(order, phase.drafts, { serialModule });
            const prev = prevStep(steps, step);
            if (prev) remember(order, phase.drafts, prev);
            else setPhase({ name: 'detail', order });
          }}
        >
          返回
        </button>
      )}
    </div>
  );
}

function OrderCard({ order, warehouseOn }: { order: ReceiveOrder; warehouseOn: boolean }) {
  const session = useFieldSession();
  return (
    <>
      <span className="field-mono">{order.orderNo}</span>
      {order.state === 'announced' ? <span className="field-badge">预报</span> : null}
      {warehouseOn && orderUnassigned(order) ? <span className="field-badge">未分仓</span> : null}
      <span className="field-meta">{order.partnerName || order.partnerCode || '未填往来单位'}</span>
      {order.returnOfOrderNo ? <span className="field-meta">退货 · 原单 {order.returnOfOrderNo}</span> : null}
      <span className="field-meta">
        {order.lines.length} 行 / {lineQty(order)} · {inboundStateLabel(session.snapshot, order.state)}
        {order.expectedAt ? ` · 预计 ${order.expectedAt}` : ''}
      </span>
    </>
  );
}
