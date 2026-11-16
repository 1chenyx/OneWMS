/** 原生插件以后只做这三件事：按 action 注册广播、从 extra 取字符串、回调 JS。 */

export interface ScanBroadcastPlugin {
  start(opts: { action: string; extra: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: 'scan',
    cb: (payload: { raw: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

type ScanHandler = (payload: { raw: string }) => void;

/** 浏览器预览没有原生广播。测试和设置页用它喂一条字符串。 */
export function createFakeBroadcast(): ScanBroadcastPlugin & {
  emit(raw: string): void;
  starts: { action: string; extra: string }[];
} {
  let handlers = new Set<ScanHandler>();
  let started = false;
  const starts: { action: string; extra: string }[] = [];
  return {
    starts,
    async start(opts) {
      started = true;
      starts.push({ action: opts.action, extra: opts.extra });
    },
    async stop() {
      started = false;
      handlers = new Set();
    },
    async addListener(_event, cb) {
      handlers.add(cb);
      return {
        async remove() {
          handlers.delete(cb);
        },
      };
    },
    emit(raw) {
      if (!started) return;
      for (const handler of handlers) handler({ raw });
    },
  };
}
