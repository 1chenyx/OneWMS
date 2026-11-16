import type { ScanBroadcastPlugin } from './broadcast.js';
import { isRepeatScan } from './dedupe.js';
import { FieldLog } from './log.js';
import type { ScanEvent } from './types.js';
import { emptyWedge, reduceWedge, type WedgeState } from './wedge.js';
import type { ScanSourcePrefs } from '../prefs.js';

export interface ScanBusDeps {
  getPrefs(): ScanSourcePrefs;
  plugin: ScanBroadcastPlugin;
  now(): number;
  target(): EventTarget;
  focusInScanStep(): boolean;
  log?: FieldLog;
}

/**
 * 三路扫码进同一条总线。解释权在当前步骤，不在这里。
 * 相机这一步不产出事件。
 */
export class ScanBus {
  #listeners = new Set<(event: ScanEvent) => void>();
  #last: ScanEvent | null = null;
  #wedge: WedgeState = emptyWedge();
  #onKey: ((event: Event) => void) | null = null;
  #broadcastRemove: (() => Promise<void>) | null = null;
  #seq = 0;
  readonly log: FieldLog;

  constructor(private readonly deps: ScanBusDeps) {
    this.log = deps.log ?? new FieldLog();
  }

  async start(): Promise<void> {
    const token = ++this.#seq;
    this.#detachKey();
    await this.#disarm(token);
    if (token !== this.#seq) return;
    const prefs = this.deps.getPrefs();
    if (prefs.wedge) {
      this.#onKey = (event) => this.#onKeyDown(event);
      this.deps.target().addEventListener('keydown', this.#onKey);
    }
    if (!prefs.broadcast || token !== this.#seq) return;
    await this.armBroadcast();
  }

  async stop(): Promise<void> {
    this.#seq += 1;
    this.#detachKey();
    await this.#disarm(null);
  }

  subscribe(listener: (event: ScanEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 设置页广播测试。预置写错也不抛。过期的 start 不能卸掉后来装上的监听。 */
  async armBroadcast(): Promise<void> {
    if (this.#broadcastRemove) return;
    const token = this.#seq;
    const prefs = this.deps.getPrefs();
    try {
      await this.deps.plugin.start({ action: prefs.broadcastAction, extra: prefs.broadcastExtra });
      if (token !== this.#seq) return;
      const handle = await this.deps.plugin.addListener('scan', (payload) => {
        const raw = payload.raw.trim();
        if (!raw) return;
        this.#push({ raw, source: 'broadcast', at: this.deps.now() });
      });
      if (token !== this.#seq) {
        try {
          await handle.remove();
        } catch {
          /* 插件失败不影响楔入 */
        }
        return;
      }
      this.#broadcastRemove = () => handle.remove();
    } catch {
      if (token === this.#seq) this.#broadcastRemove = null;
    }
  }

  async disarmBroadcast(): Promise<void> {
    await this.#disarm(null);
  }

  #onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!this.deps.getPrefs().wedge) return;
    const at = this.deps.now();
    const outcome = reduceWedge(this.#wedge, event.key, at, this.deps.focusInScanStep());
    this.#wedge = outcome.state;
    if (outcome.swallow) event.preventDefault();
    if (!outcome.emit) return;
    this.#push({ raw: outcome.emit, source: 'wedge', at });
  }

  #push(event: ScanEvent): void {
    if (isRepeatScan(this.#last, event)) return;
    this.#last = event;
    this.log.push(`${event.source} ${event.raw}`);
    for (const listener of this.#listeners) listener(event);
  }

  #detachKey(): void {
    if (!this.#onKey) return;
    this.deps.target().removeEventListener('keydown', this.#onKey);
    this.#onKey = null;
    this.#wedge = emptyWedge();
  }

  /** token 对不上时，不要停掉更新一次 start 已经装上的广播。 */
  async #disarm(token: number | null): Promise<void> {
    const remove = this.#broadcastRemove;
    this.#broadcastRemove = null;
    if (remove) {
      try {
        await remove();
      } catch {
        /* 插件失败不影响楔入 */
      }
    }
    if (token !== null && token !== this.#seq) return;
    try {
      await this.deps.plugin.stop();
    } catch {
      /* 预置写错不应当崩溃 */
    }
  }
}
