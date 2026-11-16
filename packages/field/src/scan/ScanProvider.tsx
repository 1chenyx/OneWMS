import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFieldSession } from '../session.js';
import { ScanBus } from './bus.js';
import { createFakeBroadcast, type ScanBroadcastPlugin } from './broadcast.js';
import type { ScanEvent } from './types.js';

interface ScanConsoleValue {
  log: string;
  lastBroadcast: string | null;
  probe: boolean;
  startProbe(): Promise<void>;
  stopProbe(): Promise<void>;
  subscribe(listener: (event: ScanEvent) => void): () => void;
}

const ScanConsoleContext = createContext<ScanConsoleValue | null>(null);

export function ScanProvider({
  children,
  plugin,
}: {
  children: ReactNode;
  plugin?: ScanBroadcastPlugin;
}) {
  const session = useFieldSession();
  const pluginRef = useRef<ScanBroadcastPlugin>(plugin ?? createFakeBroadcast());
  const prefsRef = useRef(session.store.prefs.scan);
  prefsRef.current = session.store.prefs.scan;
  const busRef = useRef<ScanBus | null>(null);
  if (!busRef.current) {
    busRef.current = new ScanBus({
      getPrefs: () => prefsRef.current,
      plugin: pluginRef.current,
      now: () => Date.now(),
      target: () => window,
      focusInScanStep: () =>
        document.activeElement instanceof Element && document.activeElement.closest('[data-scan-step]') !== null,
    });
  }
  const bus = busRef.current;
  const [log, setLog] = useState('');
  const [lastBroadcast, setLastBroadcast] = useState<string | null>(null);
  const [probe, setProbe] = useState(false);

  useEffect(() => {
    return bus.subscribe((event) => {
      setLog(bus.log.text());
      if (event.source === 'broadcast') setLastBroadcast(event.raw);
    });
  }, [bus]);

  const scanKey = JSON.stringify(session.store.prefs.scan);
  useEffect(() => {
    let cancelled = false;
    void bus.start().then(() => {
      if (cancelled) void bus.stop();
    });
    return () => {
      cancelled = true;
      void bus.stop();
    };
  }, [bus, scanKey]);

  const subscribe = useCallback((listener: (event: ScanEvent) => void) => bus.subscribe(listener), [bus]);

  const value = useMemo<ScanConsoleValue>(
    () => ({
      log,
      lastBroadcast,
      probe,
      subscribe,
      async startProbe() {
        setProbe(true);
        await bus.armBroadcast();
      },
      async stopProbe() {
        setProbe(false);
        if (!prefsRef.current.broadcast) await bus.disarmBroadcast();
      },
    }),
    [bus, lastBroadcast, log, probe, subscribe],
  );

  return <ScanConsoleContext.Provider value={value}>{children}</ScanConsoleContext.Provider>;
}

export function useScanConsole(): ScanConsoleValue {
  const value = useContext(ScanConsoleContext);
  if (!value) throw new Error('ScanProvider 缺失');
  return value;
}
