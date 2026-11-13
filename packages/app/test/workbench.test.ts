import { describe, expect, it } from 'vitest';
import { isTerminalState, stagePage } from '../src/lib/workbench';

/** 作业台排布规则的纯逻辑测试：落点推导 + 模块关闭时的链路降级 */

const ALL_ON: Record<string, { enabled: boolean }> = {
  'module.qc': { enabled: true },
  'module.putaway': { enabled: true },
  'module.wave': { enabled: true },
  'module.picking': { enabled: true },
  'module.review': { enabled: true },
  'module.pack': { enabled: true },
  'module.load': { enabled: true },
};

const off = (modules: Record<string, { enabled: boolean }>, id: string) => ({
  ...modules,
  [id]: { enabled: false },
});

describe('isTerminalState', () => {
  it('done / canceled 是终态', () => {
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('canceled')).toBe(true);
    expect(isTerminalState('picking')).toBe(false);
  });
});

describe('stagePage 入库链路', () => {
  it('全开时：created/announced → 入库单，received → 质检，inspected → 上架', () => {
    expect(stagePage('in', 'created', ALL_ON)).toBe('inbound');
    expect(stagePage('in', 'announced', ALL_ON)).toBe('inbound');
    expect(stagePage('in', 'received', ALL_ON)).toBe('qc');
    expect(stagePage('in', 'inspected', ALL_ON)).toBe('putaway');
    expect(stagePage('in', 'putaway', ALL_ON)).toBe('inbound');
  });

  it('质检关闭时 received 跨到上架；上架也关时回落入库单', () => {
    expect(stagePage('in', 'received', off(ALL_ON, 'module.qc'))).toBe('putaway');
    const both = off(off(ALL_ON, 'module.qc'), 'module.putaway');
    expect(stagePage('in', 'received', both)).toBe('inbound');
  });

  it('陌生状态没有落点（节点只读数，不跳转）', () => {
    expect(stagePage('in', 'mystery', ALL_ON)).toBeUndefined();
  });
});

describe('stagePage 出库链路', () => {
  it('全开时：created → 组波，picked → 复核，reviewed → 打包，packed → 装车', () => {
    expect(stagePage('out', 'created', ALL_ON)).toBe('wave');
    expect(stagePage('out', 'picking', ALL_ON)).toBe('pickings');
    expect(stagePage('out', 'picked', ALL_ON)).toBe('review');
    expect(stagePage('out', 'reviewed', ALL_ON)).toBe('pack');
    expect(stagePage('out', 'packed', ALL_ON)).toBe('load');
    expect(stagePage('out', 'loaded', ALL_ON)).toBe('outbound');
  });

  it('组波关闭时 created 直接开拣货单', () => {
    expect(stagePage('out', 'created', off(ALL_ON, 'module.wave'))).toBe('pickings');
  });

  it('复核和打包都关时 picked 跨到装车', () => {
    const none = off(off(ALL_ON, 'module.review'), 'module.pack');
    expect(stagePage('out', 'picked', none)).toBe('load');
  });
});
