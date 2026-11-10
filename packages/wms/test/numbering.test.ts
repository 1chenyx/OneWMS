import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type PatchOp } from '@one/core';
import { WmsDomain } from '../src/index.js';
import { describeNumbering } from '../src/numbering/allocate.js';
import {
  compilePattern,
  nextFromExisting,
  readNumbering,
  renderNumber,
  sampleNumber,
  seqInCode,
} from '../src/numbering/pattern.js';

/**
 * 编号：模板编译、按已有号取下一号、缺号时建单建档、预览不写配置。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-numbering');
});

afterEach(() => {
  core.close();
});

function setNumbering(value: Record<string, string>): void {
  const patch: PatchOp[] = [{ op: 'replace', path: '/modules/core.wms/settings/numbering', value }];
  const { proposalId } = ws.profile.propose('user:tester', patch, '编号规则');
  ws.profile.confirm(proposalId, 'user:tester');
}

const today = new Date(2026, 10, 10);

describe('模板', () => {
  it('合法模板能编译，示例序号是 1，日期用本地日历', () => {
    const compiled = compilePattern(' IN-{yyyyMMdd}-{seq:4} ');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.pattern.reset).toBe('day');
    expect(renderNumber(compiled.pattern, 1, today)).toBe('IN-20261110-0001');
    expect(renderNumber(compiled.pattern, 10000, today)).toBe('IN-20261110-10000');
    expect(sampleNumber('M-{yyyy}-{MM}-{seq}', today)).toEqual({
      ok: true,
      sample: 'M-2026-11-0001',
      reset: 'month',
    });
  });

  it('拒绝空模板、空白、多个序号、不认识的记号和超长', () => {
    expect(compilePattern('  ').ok).toBe(false);
    expect(compilePattern('A {seq}').ok).toBe(false);
    expect(compilePattern('A-{seq}-{seq:2}').ok).toBe(false);
    expect(compilePattern('A-{seq:9}').ok).toBe(false);
    expect(compilePattern('A-{foo}').ok).toBe(false);
    expect(compilePattern('A-{seq').ok).toBe(false);
    expect(compilePattern('A-{seq:4}' + 'x'.repeat(80)).ok).toBe(false);
  });

  it('按日重新计数，字面量里的正则符号按字面匹配', () => {
    const daily = compilePattern('IN-{yyyyMMdd}-{seq:4}');
    if (!daily.ok) throw new Error('template');
    const yesterday = renderNumber(daily.pattern, 7, new Date(2026, 10, 9));
    expect(nextFromExisting(daily.pattern, [yesterday], today)).toBe('IN-20261110-0001');
    expect(nextFromExisting(daily.pattern, ['IN-20261110-0007'], today)).toBe('IN-20261110-0008');

    const literal = compilePattern('A+B.{seq:2}');
    if (!literal.ok) throw new Error('template');
    expect(seqInCode(literal.pattern, 'A+B.01', today)).toBe(1);
    expect(seqInCode(literal.pattern, 'AB01', today)).toBeNull();
    expect(nextFromExisting(literal.pattern, ['A+B.01'], today)).toBe('A+B.02');
  });

  it('下一号跟当前最大序号，不回头补洞', () => {
    const compiled = compilePattern('N-{seq:2}');
    if (!compiled.ok) throw new Error('template');
    expect(nextFromExisting(compiled.pattern, ['N-01', 'N-03'], today)).toBe('N-04');
  });

  it('缺键用 add，脏模板回落内置并且标出原因', () => {
    expect(readNumbering(undefined).patchOp).toBe('add');
    expect(readNumbering({}).stored).toBe(false);
    const rules = readNumbering({ numbering: { sku: 'bad', 'order.in': 'IN-{seq:3}' } });
    expect(rules.stored).toBe(true);
    expect(rules.patchOp).toBe('replace');
    expect(rules.byId.sku.invalid).toBeTruthy();
    expect(rules.byId.sku.pattern).toBe('SKU-{seq:5}');
    expect(rules.byId['order.in'].pattern).toBe('IN-{seq:3}');
    expect(readNumbering({ numbering: 'x' }).byId.location.pattern).toBe('LOC-{seq:4}');
  });
});

describe('发号', () => {
  it('不传编号就按规则递增，传了就用传入的', async () => {
    const first = (await ws.tools.invoke('wms.sku.create', { name: '轴承' })) as { skuCode: string };
    const second = (await ws.tools.invoke('wms.sku.create', { skuCode: '  ', name: '螺母' })) as { skuCode: string };
    const given = (await ws.tools.invoke('wms.sku.create', { skuCode: '  A-9  ', name: '垫圈' })) as { skuCode: string };
    expect(first.skuCode).toBe('SKU-00001');
    expect(second.skuCode).toBe('SKU-00002');
    expect(given.skuCode).toBe('A-9');

    const supplier = (await ws.tools.invoke('wms.partner.create', { kind: 'supplier', name: '供应商' })) as {
      partnerCode: string;
    };
    const customer = (await ws.tools.invoke('wms.partner.create', { kind: 'customer', name: '客户' })) as {
      partnerCode: string;
    };
    expect(supplier.partnerCode).toBe('SUP-0001');
    expect(customer.partnerCode).toBe('CUS-0001');

    const location = (await ws.tools.invoke('wms.location.create', {})) as { locationCode: string };
    expect(location.locationCode).toBe('LOC-0001');
  });

  it('同一张单上的号一起看，自定义规则确认后才生效', async () => {
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    await ws.tools.invoke('wms.order.create', { direction: 'out', orderNo: 'X-01', lines: [{ skuCode: 'A-1', quantity: 1 }] });
    setNumbering({ 'order.in': 'X-{seq:2}', 'order.out': 'X-{seq:2}' });
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    expect(created.orderNo).toBe('X-02');
  });

  it('非法存档回落内置模板，预览不改配置', async () => {
    setNumbering({ 'order.in': 'nope' });
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
    const created = (await ws.tools.invoke('wms.order.create', {
      direction: 'in',
      lines: [{ skuCode: 'A-1', quantity: 1 }],
    })) as { orderNo: string };
    expect(created.orderNo).toMatch(/^IN-\d{8}-0001$/);

    const before = JSON.stringify(ws.profile.getSnapshot().modules['core.wms']?.settings?.numbering);
    const view = (await ws.tools.invoke('wms.numbering.preview', {
      place: 'sku',
      pattern: 'ITEM-{seq:3}',
    })) as { places: { next: string }[]; numbering: Record<string, string>; patchOp: string };
    expect(view.places[0]?.next).toBe('ITEM-001');
    expect(view.numbering['order.in']).toBe('IN-{yyyyMMdd}-{seq:4}');
    expect(view.patchOp).toBe('replace');
    expect(JSON.stringify(ws.profile.getSnapshot().modules['core.wms']?.settings?.numbering)).toBe(before);

    await expect(ws.tools.invoke('wms.numbering.preview', { place: 'nope' })).rejects.toThrow(/没有这个编号位置/);
    await expect(ws.tools.invoke('wms.numbering.preview', { pattern: 'A-{seq}' })).rejects.toThrow(/要带上 place/);
    await expect(ws.tools.invoke('wms.numbering.preview', { place: 'sku', pattern: 'bad' })).rejects.toThrow(/必须有且只有一个/);

    const listed = describeNumbering(ws);
    expect(listed.places).toHaveLength(13);
    expect(listed.places.find((row) => row.place === 'order.in')?.invalid).toBeTruthy();
  });
});
