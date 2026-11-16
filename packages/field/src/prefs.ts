/** 设备本地。不是 Profile，不同步。 */

export interface FieldConnection {
  /** 无尾部斜杠，例如 http://192.168.1.20:3000 */
  baseUrl: string;
  /** 上次 GET /api/health 成功时服务器返回的工作区。只展示，不让手机切换。 */
  workspaceId: string | null;
  lastOkAt: string | null;
}

export type FieldMode = 'floor' | 'manage';

export interface ScanSourcePrefs {
  wedge: boolean;
  broadcast: boolean;
  camera: boolean;
  /** Android 广播 action。空字符串要在设置里填写，例如斑马的 DataWedge。 */
  broadcastAction: string;
  broadcastExtra: string;
}

export interface FieldPrefs {
  mode: FieldMode;
  sound: boolean;
  vibrate: boolean;
  /** 当前仓库。module.warehouse 关闭时忽略。选仓不在这一步。 */
  warehouseCode: string | null;
  scan: ScanSourcePrefs;
}

/** 扫码三项可以只改其中一项，其余保持原值。 */
export type FieldPrefsPatch = Partial<Omit<FieldPrefs, 'scan'>> & {
  scan?: Partial<ScanSourcePrefs>;
};

export interface FieldStore {
  connection: FieldConnection | null;
  prefs: FieldPrefs;
  /** 连上之后问过一次「这台机器给谁用」。 */
  modeChosen: boolean;
}

const KEY = 'onewms.field.v1';

export function defaultPrefs(): FieldPrefs {
  return {
    mode: 'floor',
    sound: true,
    vibrate: true,
    warehouseCode: null,
    scan: {
      wedge: true,
      broadcast: true,
      camera: false,
      broadcastAction: '',
      broadcastExtra: '',
    },
  };
}

export function emptyStore(): FieldStore {
  return { connection: null, prefs: defaultPrefs(), modeChosen: false };
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadFieldStore(storage: KeyValueStore): FieldStore {
  const raw = storage.getItem(KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<FieldStore>;
    const prefs = { ...defaultPrefs(), ...(parsed.prefs ?? {}) };
    prefs.scan = { ...defaultPrefs().scan, ...(parsed.prefs?.scan ?? {}) };
    const connection = parsed.connection?.baseUrl
      ? {
          baseUrl: parsed.connection.baseUrl,
          workspaceId: parsed.connection.workspaceId ?? null,
          lastOkAt: parsed.connection.lastOkAt ?? null,
        }
      : null;
    return {
      connection,
      prefs,
      modeChosen: parsed.modeChosen === true,
    };
  } catch {
    return emptyStore();
  }
}

export function saveFieldStore(storage: KeyValueStore, store: FieldStore): void {
  storage.setItem(KEY, JSON.stringify(store));
}
