import { describe, it, expect } from 'vitest';
import { applyPatch, parsePointer, PatchError } from '../src/index.js';

describe('JSON Patch 应用器（RFC 6902 子集）', () => {
  it('add：对象新键、数组追加（-）与指定索引插入', () => {
    const target = {
      workflows: { inbound: { states: [{ id: 'created' }], transitions: [] } },
      modules: { 'module.expiry': { enabled: true } },
    };
    const next = applyPatch(target, [
      { op: 'add', path: '/workflows/outbound', value: { states: [], transitions: [] } },
      { op: 'add', path: '/workflows/inbound/states/-', value: { id: 'received' } },
      { op: 'add', path: '/workflows/inbound/states/0', value: { id: 'draft' } },
      { op: 'add', path: '/modules/module.picking', value: { enabled: false } },
    ]);

    expect(next.workflows.outbound).toEqual({ states: [], transitions: [] });
    expect(next.workflows.inbound.states.map((s: { id: string }) => s.id)).toEqual(['draft', 'created', 'received']);
    expect(next.modules['module.picking']).toEqual({ enabled: false });
    // 源对象不被修改
    expect(target.workflows.inbound.states).toHaveLength(1);
    expect(target.modules['module.picking']).toBeUndefined();
  });

  it('replace：对象值与数组元素', () => {
    const target = { modules: { m: { enabled: true } }, list: [1, 2, 3] };
    const next = applyPatch(target, [
      { op: 'replace', path: '/modules/m/enabled', value: false },
      { op: 'replace', path: '/list/1', value: 99 },
    ]);
    expect(next.modules.m.enabled).toBe(false);
    expect(next.list).toEqual([1, 99, 3]);
    expect(target.modules.m.enabled).toBe(true);
  });

  it('remove：对象键与数组元素（ splice 语义）', () => {
    const target = { a: 1, b: 2, list: [1, 2, 3] };
    const next = applyPatch(target, [
      { op: 'remove', path: '/a' },
      { op: 'remove', path: '/list/0' },
    ]);
    expect(next).toEqual({ b: 2, list: [2, 3] });
    expect(target).toEqual({ a: 1, b: 2, list: [1, 2, 3] });
  });

  it('错误：路径不存在 / 索引越界 / 前导零 / 指向根 / 非法 op 路径', () => {
    const target = { list: [1] };
    expect(() => applyPatch(target, [{ op: 'replace', path: '/missing/x', value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(target, [{ op: 'add', path: '/list/5', value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(target, [{ op: 'remove', path: '/list/01' }])).toThrow(PatchError);
    expect(() => applyPatch(target, [{ op: 'remove', path: '' }])).toThrow(PatchError);
    expect(() => applyPatch(target, [{ op: 'remove', path: 'list' }])).toThrow(PatchError);
    // 源对象保持完好
    expect(target).toEqual({ list: [1] });
  });

  it('parsePointer：空路径与多级路径', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a/b/0')).toEqual(['a', 'b', '0']);
  });
});
