import { useEffect, useRef, useState } from 'react';
import { fieldGet, moduleOn } from '../api.js';
import { errorMessage } from '../errors.js';
import { readWarehouses } from '../receive/model.js';
import { lookupLocation, lookupSku } from '../scan/lookup.js';
import { useScanConsole } from '../scan/ScanProvider.js';
import { useFieldSession } from '../session.js';
import {
  inventorySummaryPath,
  locationContentsPath,
  readSliceQty,
  readSkuStockPage,
  readWarehouseStock,
  showReserved,
  skuLocationPath,
  warehouseStockPath,
  type QtyLine,
  type SkuStock,
} from './model.js';

type Phase = { name: 'search' } | { name: 'locations' } | { name: 'warehouse'; title: string } | { name: 'pick' };

export function StockLookup() {
  const session = useFieldSession();
  const scan = useScanConsole();
  const baseUrl = session.store.connection?.baseUrl ?? '';
  const warehouseOn = moduleOn(session.snapshot, 'module.warehouse');
  const warehouseCode = warehouseOn ? session.store.prefs.warehouseCode : null;
  const [phase, setPhase] = useState<Phase>({ name: 'search' });
  const [raw, setRaw] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [stock, setStock] = useState<SkuStock | null>(null);
  const [hasReserved, setHasReserved] = useState(false);
  const [lines, setLines] = useState<QtyLine[]>([]);
  const [warehouses, setWarehouses] = useState<{ warehouseCode: string; name: string }[] | null>(null);
  const pendingRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const baseRef = useRef(baseUrl);
  baseRef.current = baseUrl;
  const lastRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => scan.subscribe((event) => void accept(event.raw)), [scan]);

  function setBusy(value: boolean) {
    pendingRef.current = value;
    setPending(value);
  }

  async function accept(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pendingRef.current || phaseRef.current.name !== 'search') return;
    if (lastRef.current === trimmed) {
      setError('刚扫过');
      return;
    }
    lastRef.current = trimmed;
    setRaw(trimmed);
    setBusy(true);
    setArchived(false);
    try {
      const sku = await lookupSku(baseRef.current, trimmed);
      if (sku) {
        const page = readSkuStockPage(await fieldGet(baseRef.current, inventorySummaryPath(sku.skuCode)), sku.skuCode, sku.name);
        if (!page) {
          setError('没读到库存');
          return;
        }
        setStock(page.row);
        setHasReserved(page.hasReserved);
        setArchived(sku.status === 'archived');
        setError(sku.status === 'archived' ? '已停用' : null);
        setLines([]);
        return;
      }
      const location = await lookupLocation(baseRef.current, trimmed);
      if (!location) {
        setStock(null);
        setError('没有这个货');
        return;
      }
      const rows = readSliceQty(await fieldGet(baseRef.current, locationContentsPath(location.locationCode)));
      if (!rows) {
        setError('没读到库存');
        return;
      }
      setStock(null);
      setLines(rows);
      setError(null);
      setPhase({ name: 'locations' });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function openLocations() {
    if (!stock) return;
    setBusy(true);
    setError(null);
    try {
      const rows = readSliceQty(await fieldGet(baseUrl, skuLocationPath(stock.skuCode)));
      if (!rows) {
        setError('没读到库存');
        return;
      }
      setLines(rows.filter((row) => row.skuCode === stock.skuCode));
      setPhase({ name: 'locations' });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function openWarehouse(code: string) {
    setBusy(true);
    setError(null);
    try {
      const page = readWarehouseStock(await fieldGet(baseUrl, warehouseStockPath(code)));
      if (!page) {
        setError('没读到库存');
        return;
      }
      setLines(page.rows);
      setPhase({ name: 'warehouse', title: page.name });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    if (warehouseCode) {
      await openWarehouse(warehouseCode);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setWarehouses(readWarehouses(await fieldGet(baseUrl, '/api/warehouses')));
      setPhase({ name: 'pick' });
    } catch (err) {
      setError(errorMessage(err, '没发出去，看完再试'));
    } finally {
      setBusy(false);
    }
  }

  if (phase.name === 'locations' || phase.name === 'warehouse') {
    const title = phase.name === 'warehouse' ? phase.title : '全库';
    return (
      <>
        <p className="field-kicker">{phase.name === 'locations' && !stock ? '这个库位有什么' : title}</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <ul className="field-switches">
          {lines.map((row) => (
            <li key={`${row.skuCode}-${row.locationCode}-${row.batchNo ?? ''}`}>
              <span>
                <span className="field-mono">{row.skuCode}</span> {row.locationCode}
                {row.batchNo ? ` ${row.batchNo}` : ''} 实物 {row.quantity}
              </span>
            </li>
          ))}
        </ul>
        {lines.length === 0 ? <p className="field-empty">没有库存</p> : null}
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'search' })}>
          返回
        </button>
      </>
    );
  }

  if (phase.name === 'pick') {
    return (
      <>
        <p className="field-kicker">选仓库</p>
        {warehouses?.map((row) => (
          <button
            key={row.warehouseCode}
            type="button"
            className="field-choice"
            onClick={() => {
              session.patchPrefs({ warehouseCode: row.warehouseCode });
              void openWarehouse(row.warehouseCode);
            }}
          >
            <span className="field-mono">{row.warehouseCode}</span>
            <span className="field-meta">{row.name}</span>
          </button>
        ))}
        {warehouses && warehouses.length === 0 ? <p className="field-empty">没有仓库</p> : null}
        <button type="button" className="field-secondary" onClick={() => setPhase({ name: 'search' })}>
          返回
        </button>
      </>
    );
  }

  return (
    <div data-scan-step="">
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <label className="field-label" htmlFor="field-stock-raw">
        货品或库位
      </label>
      <input
        id="field-stock-raw"
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
      <button type="button" className="field-primary" disabled={pending} onClick={() => void accept(raw)}>
        查找
      </button>
      {stock ? (
        <section className="field-card" aria-label="全库">
          <span className="field-kicker">全库</span>
          {archived ? <span className="field-badge">已停用</span> : null}
          <span className="field-mono">{stock.skuCode}</span>
          <span className="field-meta">{stock.name}</span>
          <span className="field-row">
            <span>实物</span>
            <span className="field-mono">{stock.quantity}{stock.unit ? ` ${stock.unit}` : ''}</span>
          </span>
          <span className="field-row">
            <span>冻结</span>
            <span className="field-mono">{stock.held}</span>
          </span>
          {showReserved(stock.reserved, hasReserved) ? (
            <span className="field-row">
              <span>占用</span>
              <span className="field-mono">{stock.reserved}</span>
            </span>
          ) : null}
          <span className="field-row">
            <span>可用</span>
            <span className="field-mono">{stock.available}</span>
          </span>
          <button type="button" className="field-secondary" disabled={pending} onClick={() => void openLocations()}>
            看库位
          </button>
          {warehouseOn ? (
            <button type="button" className="field-secondary" disabled={pending} onClick={() => void openPicker()}>
              看本仓
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
