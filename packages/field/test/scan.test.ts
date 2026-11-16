import { describe, expect, it, vi } from 'vitest';
import { createFakeBroadcast, type ScanBroadcastPlugin } from '../src/scan/broadcast.js';
import { ScanBus } from '../src/scan/bus.js';
import { isRepeatScan, SCAN_DEDUPE_MS } from '../src/scan/dedupe.js';
import { playScanCue } from '../src/scan/feedback.js';
import { lookupLocation, lookupSku, readExactRow } from '../src/scan/lookup.js';
import { SCAN_PRESETS, ZEBRA_ACTION_HINT } from '../src/scan/presets.js';
import { emptyWedge, reduceWedge } from '../src/scan/wedge.js';
import { defaultPrefs, type ScanSourcePrefs } from '../src/prefs.js';
import type { ScanEvent } from '../src/scan/types.js';

function harness(focus = false, plugin?: ScanBroadcastPlugin) {
  let now = 0;
  const prefs: ScanSourcePrefs = { ...defaultPrefs().scan };
  const used = plugin ?? createFakeBroadcast();
  const target = new EventTarget();
  const events: ScanEvent[] = [];
  const bus = new ScanBus({
    getPrefs: () => prefs,
    plugin: used,
    now: () => now,
    target: () => target,
    focusInScanStep: () => focus,
  });
  bus.subscribe((event) => events.push(event));
  const key = (keyName: string, at: number) => {
    now = at;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
  };
  return { bus, prefs, plugin: used, events, key, setNow: (at: number) => { now = at; } };
}

describe('楔入', () => {
  it('间隔小于 30ms 的一串，回车即使不在输入框也提交', () => {
    let state = emptyWedge();
    for (const [key, at] of [['A', 0], ['0', 10], ['1', 20]] as const) {
      state = reduceWedge(state, key, at, false).state;
    }
    const done = reduceWedge(state, 'Enter', 25, false);
    expect(done.emit).toBe('A01');
    expect(done.state.buffer).toBe('');
  });

  it('间隔大于 80ms 的人工输入，只有扫码步里才提交', () => {
    let state = emptyWedge();
    state = reduceWedge(state, 'A', 0, false).state;
    state = reduceWedge(state, 'B', 50, false).state;
    expect(reduceWedge(state, 'Enter', 90, false).emit).toBeNull();
    expect(reduceWedge(state, 'Enter', 90, true).emit).toBe('AB');
  });

  it('空回车不产生事件', () => {
    expect(reduceWedge(emptyWedge(), 'Enter', 0, true).emit).toBeNull();
  });
});

describe('去重', () => {
  it('400ms 内同一字符串丢掉第二次，不管来源', () => {
    expect(isRepeatScan({ raw: 'A01', at: 0 }, { raw: 'A01', at: SCAN_DEDUPE_MS })).toBe(true);
    expect(isRepeatScan({ raw: 'A01', at: 0 }, { raw: 'A01', at: SCAN_DEDUPE_MS + 1 })).toBe(false);
    expect(isRepeatScan({ raw: 'A01', at: 0 }, { raw: 'B02', at: 10 })).toBe(false);
  });

  it('楔入和广播各来一次，只留下先到的', async () => {
    const box = harness();
    const plugin = box.plugin as ReturnType<typeof createFakeBroadcast>;
    await box.bus.start();
    box.key('A', 0);
    box.key('0', 10);
    box.key('Enter', 20);
    box.setNow(100);
    plugin.emit('A0');
    expect(box.events.map((event) => event.source)).toEqual(['wedge']);
    box.setNow(500);
    plugin.emit('A0');
    expect(box.events).toHaveLength(2);
    expect(box.events[1]).toMatchObject({ source: 'broadcast', raw: 'A0' });
  });

  it('空广播不提示', async () => {
    const box = harness();
    const plugin = box.plugin as ReturnType<typeof createFakeBroadcast>;
    await box.bus.start();
    plugin.emit('   ');
    expect(box.events).toHaveLength(0);
  });
});

describe('广播插件', () => {
  it('预置写错不抛，楔入仍然能扫', async () => {
    const broken: ScanBroadcastPlugin = {
      async start() {
        throw new Error('bad action');
      },
      async stop() {
        throw new Error('bad stop');
      },
      async addListener() {
        throw new Error('bad listen');
      },
    };
    const box = harness(false, broken);
    await expect(box.bus.start()).resolves.toBeUndefined();
    box.key('Z', 0);
    box.key('1', 5);
    box.key('Enter', 10);
    expect(box.events).toEqual([expect.objectContaining({ raw: 'Z1', source: 'wedge' })]);
  });

  it('四个预置里斑马的 action 留空，并带填写说明', () => {
    expect(SCAN_PRESETS.map((preset) => preset.name)).toEqual(['通用', '斑马', '优博讯', '东集 / 新大陆']);
    expect(SCAN_PRESETS.find((preset) => preset.id === 'zebra')).toMatchObject({
      action: '',
      extra: 'com.symbol.datawedge.data_string',
    });
    expect(ZEBRA_ACTION_HINT).toBe('填 DataWedge 的 Intent action');
  });
});

describe('声音和震动', () => {
  it('关掉声音仍震动；重复不震动', () => {
    const beeps: number[] = [];
    const vibrations: number[] = [];
    const out = {
      beep: (hz: number) => beeps.push(hz),
      vibrate: (ms: number) => vibrations.push(ms),
    };
    playScanCue('accept', { sound: false, vibrate: true }, out);
    playScanCue('repeat', { sound: true, vibrate: true }, out);
    playScanCue('fail', { sound: true, vibrate: true }, out);
    expect(beeps).toEqual([220, 220, 220]);
    expect(vibrations).toEqual([40, 200]);
  });
});

describe('精确查询解析', () => {
  it('条码命中就不再查编码', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify([{ skuCode: 'A-1', name: '螺丝', barcode: '6901', status: 'active' }]), { status: 200 });
    });
    const hit = await lookupSku('http://10.0.0.8:3000', '6901', fetchMock);
    expect(hit).toMatchObject({ skuCode: 'A-1', barcode: '6901' });
    expect(urls).toEqual(['http://10.0.0.8:3000/api/skus?barcode=6901']);
  });

  it('条码没有再查编码；分页对象不算命中；停用档原样返回', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.includes('barcode=')) return new Response(JSON.stringify({ rows: [{ skuCode: 'NO' }], total: 1 }), { status: 200 });
      return new Response(JSON.stringify([{ skuCode: 'A-1', name: '螺丝', barcode: null, status: 'archived' }]), { status: 200 });
    });
    const hit = await lookupSku('http://10.0.0.8:3000', 'A-1', fetchMock);
    expect(hit).toMatchObject({ skuCode: 'A-1', status: 'archived' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('DEFAULT 读成虚拟库位，没有容量键', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      expect(String(input)).toBe('http://10.0.0.8:3000/api/locations?code=DEFAULT');
      expect(String(input)).not.toContain('limit');
      return new Response(
        JSON.stringify([{ locationCode: 'DEFAULT', name: '默认库位', warehouseCode: null, zoneCode: null }]),
        { status: 200 },
      );
    });
    const hit = await lookupLocation('http://10.0.0.8:3000', 'DEFAULT', fetchMock);
    expect(hit).toMatchObject({ locationCode: 'DEFAULT', warehouseCode: null, zoneCode: null });
    expect(hit).not.toHaveProperty('capacity');
  });

  it('带 rows 的分页不是一条库位', () => {
    expect(readExactRow({ rows: [{ locationCode: 'A-01' }], total: 1 })).toBeNull();
  });
});
