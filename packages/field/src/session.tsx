import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  platformLogin,
  platformLogout,
  probeServer,
  selectPlatformWorkspace,
  type FieldSnapshot,
  type HealthDto,
  type PlatformMembership,
} from './api.js';
import { FieldApiError, errorMessage } from './errors.js';
import { fieldLink, type FieldLink } from './platform.js';
import {
  loadFieldStore,
  saveFieldStore,
  type FieldConnection,
  type FieldMode,
  type FieldPrefsPatch,
  type FieldStore,
} from './prefs.js';
import { nextDelayMs } from './watch.js';

export type PlatformGate = { need: 'login' } | { need: 'workspace'; memberships: PlatformMembership[] };

interface FieldSessionValue {
  store: FieldStore;
  health: HealthDto | null;
  snapshot: FieldSnapshot | null;
  online: boolean;
  link: FieldLink;
  platform: PlatformGate | null;
  phase: 'booting' | 'connect' | 'mode' | 'app';
  error: string | null;
  pending: boolean;
  connect(rawUrl: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  chooseWorkspace(workspaceId: string): Promise<void>;
  cancelPlatform(): void;
  logoutPlatform(): Promise<void>;
  chooseMode(mode: FieldMode): void;
  setMode(mode: FieldMode): void;
  patchPrefs(patch: FieldPrefsPatch): void;
  reconnect(rawUrl: string): Promise<void>;
}

const FieldSessionContext = createContext<FieldSessionValue | null>(null);

export function FieldSessionProvider({ children }: { children: ReactNode }) {
  const storage = window.localStorage;
  const [store, setStore] = useState<FieldStore>(() => loadFieldStore(storage));
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [snapshot, setSnapshot] = useState<FieldSnapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [entered, setEntered] = useState(false);
  const [booting, setBooting] = useState(() => loadFieldStore(storage).connection !== null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<FieldLink>('lan');
  const [platform, setPlatform] = useState<PlatformGate | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const addressRef = useRef('');

  const writeStore = useCallback((next: FieldStore) => {
    saveFieldStore(storage, next);
    storeRef.current = next;
    setStore(next);
  }, [storage]);

  const applyProbe = useCallback(async (rawUrl: string) => {
    const result = await probeServer(rawUrl);
    const connection: FieldConnection = {
      baseUrl: result.baseUrl,
      workspaceId: result.health.workspaceId,
      lastOkAt: new Date().toISOString(),
    };
    setHealth(result.health);
    setSnapshot(result.snapshot);
    setOnline(true);
    setLink(fieldLink());
    setError(null);
    return connection;
  }, []);

  const finish = useCallback(
    (connection: FieldConnection) => {
      setPlatform(null);
      writeStore({ ...loadFieldStore(storage), connection, prefs: storeRef.current.prefs, modeChosen: storeRef.current.modeChosen });
      setEntered(true);
    },
    [storage, writeStore],
  );

  const connect = useCallback(
    async (rawUrl: string) => {
      addressRef.current = rawUrl;
      setPending(true);
      try {
        const connection = await applyProbe(rawUrl);
        finish(connection);
      } catch (err) {
        setOnline(false);
        setLink(fieldLink());
        if (err instanceof FieldApiError && err.code === 'FIELD_PLATFORM_AUTH') {
          setPlatform({ need: 'login' });
          setError(err.message);
        } else {
          setPlatform(null);
          setError(errorMessage(err, '没连上，看地址再试'));
        }
      } finally {
        setPending(false);
        setBooting(false);
      }
    },
    [applyProbe, finish],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const raw = addressRef.current || storeRef.current.connection?.baseUrl || '';
      if (!email.trim() || !password) {
        setError('请填写邮箱和密码');
        return;
      }
      setPending(true);
      setError(null);
      try {
        const result = await platformLogin(raw, email.trim(), password);
        if (!result.workspaceId) {
          if (result.memberships.length > 1) {
            setPlatform({ need: 'workspace', memberships: result.memberships });
            setLink('platform');
            return;
          }
          if (result.memberships.length === 1) {
            await selectPlatformWorkspace(result.baseUrl, result.memberships[0].workspaceId);
          } else {
            setError('这个账号还没有工作区');
            setPlatform({ need: 'login' });
            return;
          }
        }
        finish(await applyProbe(raw));
      } catch (err) {
        setOnline(false);
        setLink(fieldLink());
        if (err instanceof FieldApiError && err.code === 'FIELD_PLATFORM_AUTH') setPlatform({ need: 'login' });
        setError(errorMessage(err, '没登录上'));
      } finally {
        setPending(false);
      }
    },
    [applyProbe, finish],
  );

  const chooseWorkspace = useCallback(
    async (workspaceId: string) => {
      const raw = addressRef.current || storeRef.current.connection?.baseUrl || '';
      setPending(true);
      setError(null);
      try {
        await selectPlatformWorkspace(raw, workspaceId);
        finish(await applyProbe(raw));
      } catch (err) {
        setError(errorMessage(err, '没选中工作区'));
      } finally {
        setPending(false);
      }
    },
    [applyProbe, finish],
  );

  const cancelPlatform = useCallback(() => {
    setPlatform(null);
    setError(null);
  }, []);

  const logoutPlatform = useCallback(async () => {
    const raw = addressRef.current || storeRef.current.connection?.baseUrl || '';
    if (raw) await platformLogout(raw);
    setEntered(false);
    setOnline(false);
    setLink('platform');
    setPlatform({ need: 'login' });
    setError('这是平台，先登录账号');
  }, []);

  const reconnect = useCallback(
    async (rawUrl: string) => {
      addressRef.current = rawUrl;
      setPending(true);
      try {
        const connection = await applyProbe(rawUrl);
        setPlatform(null);
        writeStore({ ...storeRef.current, connection });
        setEntered(true);
      } catch (err) {
        setOnline(false);
        setLink(fieldLink());
        if (err instanceof FieldApiError && err.code === 'FIELD_PLATFORM_AUTH') {
          setEntered(false);
          setPlatform({ need: 'login' });
          setError(err.message);
        } else {
          setError(errorMessage(err, '没连上，看地址再试'));
        }
      } finally {
        setPending(false);
      }
    },
    [applyProbe, writeStore],
  );

  const chooseMode = useCallback(
    (mode: FieldMode) => {
      const current = storeRef.current;
      writeStore({ ...current, modeChosen: true, prefs: { ...current.prefs, mode } });
    },
    [writeStore],
  );

  const setMode = useCallback(
    (mode: FieldMode) => {
      const current = storeRef.current;
      writeStore({ ...current, prefs: { ...current.prefs, mode } });
    },
    [writeStore],
  );

  const patchPrefs = useCallback(
    (patch: FieldPrefsPatch) => {
      const current = storeRef.current;
      writeStore({
        ...current,
        prefs: {
          ...current.prefs,
          ...patch,
          scan: { ...current.prefs.scan, ...(patch.scan ?? {}) },
        },
      });
    },
    [writeStore],
  );

  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    const saved = storeRef.current.connection;
    if (!saved) {
      setBooting(false);
      return;
    }
    void connect(saved.baseUrl);
  }, [connect]);

  const baseUrl = store.connection?.baseUrl ?? null;
  useEffect(() => {
    if (!entered || !baseUrl) return;
    let timer = 0;
    let failures = 0;
    let cancelled = false;
    const schedule = () => {
      timer = window.setTimeout(tick, nextDelayMs(failures));
    };
    const tick = () => {
      void (async () => {
        try {
          const result = await probeServer(baseUrl);
          if (cancelled) return;
          failures = 0;
          setHealth(result.health);
          setSnapshot(result.snapshot);
          setOnline(true);
          setError(null);
          const saved = loadFieldStore(storage);
          writeStore({
            ...saved,
            connection: {
              baseUrl: result.baseUrl,
              workspaceId: result.health.workspaceId,
              lastOkAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          if (cancelled) return;
          failures += 1;
          setOnline(false);
          if (err instanceof FieldApiError && err.code === 'FIELD_PLATFORM_AUTH') {
            setEntered(false);
            setLink('platform');
            setPlatform({ need: 'login' });
            setError(err.message);
          }
        } finally {
          if (!cancelled) schedule();
        }
      })();
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [baseUrl, entered, storage, writeStore]);

  const phase: FieldSessionValue['phase'] = booting
    ? 'booting'
    : platform || !entered || !store.connection
      ? 'connect'
      : store.modeChosen
        ? 'app'
        : 'mode';

  const value = useMemo<FieldSessionValue>(
    () => ({
      store,
      health,
      snapshot,
      online,
      link,
      platform,
      phase,
      error,
      pending,
      connect,
      login,
      chooseWorkspace,
      cancelPlatform,
      logoutPlatform,
      chooseMode,
      setMode,
      patchPrefs,
      reconnect,
    }),
    [
      store,
      health,
      snapshot,
      online,
      link,
      platform,
      phase,
      error,
      pending,
      connect,
      login,
      chooseWorkspace,
      cancelPlatform,
      logoutPlatform,
      chooseMode,
      setMode,
      patchPrefs,
      reconnect,
    ],
  );

  return <FieldSessionContext.Provider value={value}>{children}</FieldSessionContext.Provider>;
}

export function useFieldSession(): FieldSessionValue {
  const value = useContext(FieldSessionContext);
  if (!value) throw new Error('FieldSessionProvider 缺失');
  return value;
}

