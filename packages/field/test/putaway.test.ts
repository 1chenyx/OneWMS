import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../src/prefs.js';
import { clearPutawayDraft, loadPutawayDraft, PUTAWAY_DRAFT_KEY, savePutawayDraft } from '../src/putaway/draft.js';
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
} from '../src/putaway/model.js';
import type { ReceiveOrder, ReceiveOrderLine } from '../src/receive/model.js';

function memory(): KeyValueStore & { raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  return {
    raw,
    getItem: (key) => raw[key] ?? null,
    setItem: (key, value) => {
      raw[key] = value;
    },
  };
}

function line(patch: Partial<ReceiveOrderLine> = {}): ReceiveOrderLine {
  return {
    skuCode: 'A-1',
    name: '螺丝',
    quantity: 2,
    unit: '个',
    locationCode: 'A-01',
    warehouseCode: null,
    batchNo: 'DEFAULT',
    batchExpiryDate: null,
    serialTracked: false,
    ...patch,
  };
}

function order(lines: ReceiveOrderLine[]): ReceiveOrder {
  return {
    orderNo: 'IN-9',
    state: 'received',
    partnerCode: null,
    partnerName: '乙仓供',
    expectedAt: null,
    returnOfOrderNo: null,
    lines,
  };
}

describe('待上架列表', () => {
  it('质检关时收货和已质检都在，质检开时只留已质检', () => {
    expect(decodeURIComponent(putawayListPath(false, null, 0))).toBe(
      '/api/orders?direction=in&state=received,inspected&sort=updatedAtAsc&limit=50&offset=0',
    );
    expect(decodeURIComponent(putawayListPath(true, 'WH-1', 50))).toBe(
      '/api/orders?direction=in&state=inspected&sort=updatedAtAsc&limit=50&offset=50&warehouseCode=WH-1',
    );
  });

  it('已收货在质检开着时不进列表，已质检始终在', () => {
    expect(orderOnPutawayList({ state: 'received' }, false)).toBe(true);
    expect(orderOnPutawayList({ state: 'received' }, true)).toBe(false);
    expect(orderOnPutawayList({ state: 'inspected' }, true)).toBe(true);
    expect(orderOnPutawayList({ state: 'putaway' }, false)).toBe(false);
  });
});

describe('上架提交', () => {
  it('留在原位和同库位都不进 targets，也不写数量', () => {
    const lines = [line({ batchNo: 'B1' }), line({ skuCode: 'A-2', locationCode: 'A-02' })];
    const moved = buildPutawayBody(lines, ['B-01', null]);
    expect(moved).toEqual({
      targets: [{ skuCode: 'A-1', fromLocationCode: 'A-01', batchNo: 'B1', toLocationCode: 'B-01' }],
    });
    expect(moved.targets?.[0]).not.toHaveProperty('quantity');
    expect(buildPutawayBody(lines, ['A-01', 'A-02'])).toEqual({});
    expect(buildPutawayBody(lines, [null, null])).toEqual({});
  });

  it('离开已收货或已质检就算提交落地', () => {
    expect(putawayLanded({ state: 'received' })).toBe(false);
    expect(putawayLanded({ state: 'inspected' })).toBe(false);
    expect(putawayLanded({ state: 'putaway' })).toBe(true);
    expect(putawayLanded({ state: 'done' })).toBe(true);
  });

  it('目标库位和源库位相同按留在原位', () => {
    expect(readTarget(null, 'A-01', null)).toEqual({ ok: false, message: '没有这个库位' });
    expect(readTarget({ locationCode: 'B-01', warehouseCode: 'WH-2' }, 'A-01', 'WH-1')).toEqual({
      ok: false,
      message: '库位不在当前仓库',
    });
    expect(readTarget({ locationCode: 'A-01', warehouseCode: null }, 'A-01', 'WH-1')).toEqual({
      ok: true,
      toLocationCode: null,
    });
    expect(readTarget({ locationCode: 'B-01', warehouseCode: 'WH-1' }, 'A-01', 'WH-1')).toEqual({
      ok: true,
      toLocationCode: 'B-01',
    });
  });

  it('警告原文只在非空字符串时带上', () => {
    expect(readPutawayWarning({ warning: '库位 A-02 快满了' })).toBe('库位 A-02 快满了');
    expect(readPutawayWarning({ warning: '  ' })).toBeNull();
    expect(readPutawayWarning({})).toBeNull();
    expect(readPutawayWarning(null)).toBeNull();
  });
});

describe('上架步骤和草稿', () => {
  it('每行先核对源库位和货品，再选目标，最后确认', () => {
    const steps = putawayMoveSteps(order([line(), line({ skuCode: 'A-2', locationCode: 'A-02' })]));
    expect(steps.map(putawayStepToken)).toEqual([
      'source:0',
      'sku:0',
      'target:0',
      'source:1',
      'sku:1',
      'target:1',
      'confirm',
    ]);
    expect(putawayStepFromToken('sku:1', steps)).toEqual({ kind: 'sku', lineIndex: 1 });
    expect(putawayStepFromToken('missing', steps)).toEqual(steps[0]);
    expect(nextPutawayStep(steps, { kind: 'target', lineIndex: 0 })).toEqual({ kind: 'source', lineIndex: 1 });
    expect(prevPutawayStep(steps, steps[0]!)).toBeNull();
  });

  it('坏草稿丢掉，清空写成空串', () => {
    const storage = memory();
    expect(loadPutawayDraft(storage)).toBeNull();
    savePutawayDraft(storage, {
      kind: 'putaway',
      docNo: 'IN-9',
      step: 'target:0',
      targets: ['B-01', null],
      updatedAt: '2026-11-16T00:00:00.000Z',
    });
    expect(loadPutawayDraft(storage)?.docNo).toBe('IN-9');
    expect(storage.raw[PUTAWAY_DRAFT_KEY]).not.toContain('password');
    storage.setItem(PUTAWAY_DRAFT_KEY, '{');
    expect(loadPutawayDraft(storage)).toBeNull();
    clearPutawayDraft(storage);
    expect(storage.raw[PUTAWAY_DRAFT_KEY]).toBe('');
    expect(loadPutawayDraft(storage)).toBeNull();
  });
});
