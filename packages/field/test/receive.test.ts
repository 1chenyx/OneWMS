import { describe, expect, it, vi } from 'vitest';
import { probeServer } from '../src/api.js';
import { clearReceiveDraft, loadReceiveDraft, RECEIVE_DRAFT_KEY, saveReceiveDraft } from '../src/receive/draft.js';
import {
  buildRevise,
  buildTransition,
  checkLocation,
  checkSku,
  commitQty,
  doneHint,
  draftsFromOrder,
  lineChanged,
  mergeDrafts,
  orderUnassigned,
  pushSerial,
  receiveListPath,
  receiveSteps,
  reviseLanded,
  showPutawayButton,
  stepToken,
  transitionLanded,
  type ReceiveOrder,
  type ReceiveOrderLine,
} from '../src/receive/model.js';
import type { KeyValueStore } from '../src/prefs.js';

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
    quantity: 4,
    unit: '个',
    locationCode: 'DEFAULT',
    warehouseCode: null,
    batchNo: 'DEFAULT',
    batchExpiryDate: null,
    serialTracked: false,
    ...patch,
  };
}

function order(lines: ReceiveOrderLine[], patch: Partial<ReceiveOrder> = {}): ReceiveOrder {
  return {
    orderNo: 'IN-1',
    state: 'created',
    partnerCode: null,
    partnerName: null,
    expectedAt: null,
    returnOfOrderNo: null,
    lines,
    ...patch,
  };
}

describe('待收列表', () => {
  it('始终要 created 和 announced，升序，仓库空着就不传', () => {
    expect(decodeURIComponent(receiveListPath(null, 0))).toBe(
      '/api/orders?direction=in&state=created,announced&sort=updatedAtAsc&limit=50&offset=0',
    );
    expect(decodeURIComponent(receiveListPath('WH-1', 50))).toContain('warehouseCode=WH-1');
    expect(decodeURIComponent(receiveListPath('WH-1', 50))).toContain('offset=50');
  });

  it('整单未分仓才标未分仓', () => {
    expect(orderUnassigned(order([line()]))).toBe(true);
    expect(orderUnassigned(order([line({ warehouseCode: 'WH-1' })]))).toBe(false);
    expect(orderUnassigned(order([line(), line({ warehouseCode: 'WH-1', locationCode: 'A-01' })]))).toBe(false);
  });
});

describe('收货提交', () => {
  it('只核对库位和批次时不修订，转移不带 lines', () => {
    const doc = order([line()]);
    const drafts = draftsFromOrder(doc);
    expect(buildRevise(doc, drafts)).toBeNull();
    expect(buildTransition(doc, drafts)).toEqual({ to: 'received' });
  });

  it('序列号改量写进一次修订，并带上没改的效期', () => {
    const doc = order([
      line({ serialTracked: true, quantity: 2, serials: ['S1', 'S2'], batchNo: 'LOT', batchExpiryDate: '2026-12-01' }),
      line({ skuCode: 'B-2', locationCode: 'B-01', quantity: 3, batchNo: 'LOT-B', batchExpiryDate: '2026-11-01' }),
    ]);
    const drafts = draftsFromOrder(doc);
    drafts[0] = { ...drafts[0]!, qty: 1, serials: ['S1'] };
    const revise = buildRevise(doc, drafts);
    expect(revise?.lines[0]).toEqual({
      skuCode: 'A-1',
      locationCode: 'DEFAULT',
      batchNo: 'LOT',
      quantity: 1,
      batchExpiryDate: '2026-12-01',
      serials: ['S1'],
    });
    expect(revise?.lines[1]).toEqual({
      skuCode: 'B-2',
      locationCode: 'B-01',
      batchNo: 'LOT-B',
      quantity: 3,
      batchExpiryDate: '2026-11-01',
    });
    expect(revise?.lines[1]).not.toHaveProperty('serials');
    expect(buildTransition(doc, drafts)).toEqual({ to: 'received' });
  });

  it('非序列号跳过不进修订，转移里该行是 0', () => {
    const doc = order([line({ quantity: 4 }), line({ skuCode: 'B-2', locationCode: 'B-01', quantity: 2 })]);
    const drafts = draftsFromOrder(doc);
    drafts[1] = { ...drafts[1]!, qty: 0 };
    expect(lineChanged(doc.lines[1]!, drafts[1]!)).toBe(false);
    expect(buildRevise(doc, drafts)).toBeNull();
    expect(buildTransition(doc, drafts)).toEqual({
      to: 'received',
      lines: [
        { skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', quantity: 4 },
        { skuCode: 'B-2', locationCode: 'B-01', batchNo: 'DEFAULT', quantity: 0 },
      ],
    });
  });

  it('又短收又改序列号时，转移用改后的数量', () => {
    const doc = order([
      line({ quantity: 4 }),
      line({ skuCode: 'B-2', locationCode: 'B-01', serialTracked: true, quantity: 2 }),
    ]);
    const drafts = draftsFromOrder(doc);
    drafts[0] = { ...drafts[0]!, qty: 1 };
    drafts[1] = { ...drafts[1]!, qty: 1, serials: ['S9'] };
    expect(buildTransition(doc, drafts).lines?.map((row) => row.quantity)).toEqual([1, 1]);
  });

  it('修订对上了才算落地，省掉的效期必须仍是空', () => {
    const doc = order([line({ batchNo: 'LOT', batchExpiryDate: '2026-12-01', quantity: 1 })]);
    const payload = {
      lines: [{ skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'LOT', quantity: 1, batchExpiryDate: '2026-12-01' }],
    };
    expect(reviseLanded(doc, payload)).toBe(true);
    expect(reviseLanded(doc, { lines: [{ skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'LOT', quantity: 1 }] })).toBe(false);
    const copied = order([line({ serials: ['S1'], serialTracked: true, quantity: 1 })]);
    expect(
      reviseLanded(copied, { lines: [{ skuCode: 'A-1', locationCode: 'DEFAULT', batchNo: 'DEFAULT', quantity: 1 }] }),
    ).toBe(true);
  });

  it('离开待收才算转移已经落地', () => {
    expect(transitionLanded({ state: 'created' })).toBe(false);
    expect(transitionLanded({ state: 'announced' })).toBe(false);
    expect(transitionLanded({ state: 'received' })).toBe(true);
  });
});

describe('收货步骤', () => {
  it('库位相同只核对一次，跳过的行不再问序列号和批次', () => {
    const doc = order([
      line({ serialTracked: true, quantity: 2 }),
      line({ skuCode: 'B-2', quantity: 1 }),
    ]);
    const drafts = draftsFromOrder(doc);
    drafts[0] = { ...drafts[0]!, qty: 0 };
    const steps = receiveSteps(doc, drafts, { serialModule: true });
    expect(steps.map(stepToken)).toEqual(['location', 'sku:0', 'qty:0', 'sku:1', 'qty:1', 'batch:1', 'confirm']);
  });

  it('库位不同就逐行核对', () => {
    const doc = order([line({ locationCode: 'A-01' }), line({ skuCode: 'B-2', locationCode: 'B-01' })]);
    expect(receiveSteps(doc, draftsFromOrder(doc), { serialModule: false }).map(stepToken)).toEqual([
      'location:0',
      'sku:0',
      'qty:0',
      'batch:0',
      'location:1',
      'sku:1',
      'qty:1',
      'batch:1',
      'confirm',
    ]);
  });

  it('序列号模块关掉就不出现扫号', () => {
    const doc = order([line({ serialTracked: true })]);
    expect(receiveSteps(doc, draftsFromOrder(doc), { serialModule: false }).some((step) => step.kind === 'serial')).toBe(false);
  });

  it('数量不能超过本行，序列号不能改成 0', () => {
    expect(commitQty(line({ quantity: 4 }), '5', true)).toEqual({ ok: false, message: '超过本行数量' });
    expect(commitQty(line({ quantity: 4 }), '1.5', true)).toEqual({ ok: true, qty: 1.5 });
    expect(commitQty(line({ serialTracked: true, quantity: 4 }), '0', true)).toEqual({ ok: false, message: '数量不对' });
    expect(commitQty(line({ serialTracked: true, quantity: 4.5 }), '4', true)).toEqual({ ok: false, message: 'WMS_SERIAL_COUNT' });
    expect(commitQty(line({ quantity: 4 }), '1', false)).toEqual({ ok: true, qty: 4 });
  });

  it('已有序列号且数量没改，扫到清单外的号不收', () => {
    const item = line({ serialTracked: true, quantity: 1, serials: ['S1'] });
    const draft = draftsFromOrder(order([item]))[0]!;
    expect(pushSerial(item, draft, [], 'S2')).toEqual({ ok: false, message: '不是这张单上的' });
    expect(pushSerial(item, draft, [], 'S1')).toEqual({ ok: true, progress: ['S1'] });
    expect(pushSerial(item, draft, ['S1'], 'S1')).toEqual({ ok: false, message: '刚扫过' });
  });

  it('库位和货品的短句', () => {
    expect(checkLocation(null, 'A-01', 'WH-1')).toBe('没有这个库位');
    expect(checkLocation({ locationCode: 'B-01', warehouseCode: 'WH-2' }, 'A-01', 'WH-1')).toBe('库位不在当前仓库');
    expect(checkLocation({ locationCode: 'B-01', warehouseCode: 'WH-1' }, 'A-01', 'WH-1')).toBe('库位不是这行的');
    expect(checkLocation({ locationCode: 'A-01', warehouseCode: null }, 'A-01', 'WH-1')).toBeNull();
    expect(checkSku(null, 'A-1')).toBe('没有这个货');
    expect(checkSku({ skuCode: 'A-1', status: 'archived' }, 'A-1')).toBe('已停用');
    expect(checkSku({ skuCode: 'B-2', status: 'active' }, 'A-1')).toBe('不是这张单上的');
  });

  it('下一跳：质检屏没开就去电脑，上架按钮要屏也开着', () => {
    expect(doneHint({ qcModule: true, qcScreen: false, putawayModule: true })).toBe('先在电脑上质检');
    expect(doneHint({ qcModule: false, qcScreen: false, putawayModule: true })).toBe('下一跳是上架');
    expect(doneHint({ qcModule: false, qcScreen: false, putawayModule: false })).toBe('到电脑上点完成');
    expect(showPutawayButton({ putawayModule: true, qcModule: false, putawayScreen: false })).toBe(false);
    expect(showPutawayButton({ putawayModule: true, qcModule: false, putawayScreen: true })).toBe(true);
  });

  it('草稿按原行键合并，和连接记录不是同一把钥匙', () => {
    const doc = order([line({ batchNo: 'LOT', batchExpiryDate: '2026-12-01' })]);
    const saved = draftsFromOrder(doc);
    saved[0] = { ...saved[0]!, qty: 2, batchNo: 'LOT-2' };
    expect(mergeDrafts(doc, saved)[0]).toMatchObject({ qty: 2, batchNo: 'LOT-2', batchExpiryDate: '2026-12-01' });
    const storage = memory();
    saveReceiveDraft(storage, {
      kind: 'receive',
      docNo: 'IN-1',
      step: 'qty:0',
      lines: saved,
      updatedAt: '2026-11-16T00:00:00.000Z',
    });
    expect(loadReceiveDraft(storage)?.docNo).toBe('IN-1');
    expect(Object.keys(storage.raw)).toEqual([RECEIVE_DRAFT_KEY]);
    expect(JSON.stringify(storage.raw)).not.toMatch(/password/i);
    clearReceiveDraft(storage);
    expect(loadReceiveDraft(storage)).toBeNull();
  });
});

describe('配置快照', () => {
  it('没有流程状态也能连上，有的话抄下来', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, nodeId: 'n', workspaceId: 'wh' }), { status: 200 });
      }
      if (url.endsWith('/api/profile/snapshot')) {
        return new Response(JSON.stringify({ workspaceId: 'wh', modules: { 'core.wms': { enabled: true } } }), { status: 200 });
      }
      throw new Error(url);
    });
    const plain = await probeServer('http://10.0.0.8:3000', fetchImpl);
    expect(plain.snapshot.workflows).toBeUndefined();

    fetchImpl.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, nodeId: 'n', workspaceId: 'wh' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          workspaceId: 'wh',
          modules: {},
          workflows: { inbound: { states: [{ id: 'announced', label: '已预报' }] } },
        }),
        { status: 200 },
      );
    });
    const withFlow = await probeServer('http://10.0.0.8:3000', fetchImpl);
    expect(withFlow.snapshot.workflows?.inbound?.states).toEqual([{ id: 'announced', label: '已预报' }]);
  });
});
