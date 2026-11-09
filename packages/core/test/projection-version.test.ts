import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CORE_PROJECTION_VERSION,
  DataVersionError,
  decideProjectionVersion,
  ensureProjectionVersion,
  OneCore,
  projectionMetaKey,
} from '../src/index.js';

/**
 * 投影版本戳（层 1）的机制层：判定纯函数 + 读写/重建编排。
 *
 * 领域侧的端到端验证在 packages/wms/test/projection-version.test.ts —— 那里
 * 证明的是「bump 版本号之后，用户重开程序，被改坏的投影会自动冲回真值」。
 * 这里只管机制本身对不对，不碰任何领域投影。
 */

/** 数一下 rebuild 被调了几次：判定错了却照样重建，比重建漏了更难发现 */
const harness = (stamped: string | null, codeVersion: number, workspaceId = 'default') => {
  const core = OneCore.open(':memory:');
  const db = core.exposeDb();
  if (stamped !== null) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      projectionMetaKey('unit', workspaceId),
      stamped,
    );
  }
  let rebuilds = 0;
  const run = () =>
    ensureProjectionVersion(db, {
      group: 'unit',
      workspaceId,
      codeVersion,
      rebuild: () => {
        rebuilds++;
      },
    });
  const stamp = () => core.getMeta(projectionMetaKey('unit', workspaceId));
  return { core, run, stamp, rebuilds: () => rebuilds };
};

describe('decideProjectionVersion：四态判定', () => {
  it('没戳 = fresh（全新库，或本机制上线之前的老库）', () => {
    expect(decideProjectionVersion(null, 1)).toEqual({ kind: 'fresh' });
  });

  it('戳 == 代码版本 = current', () => {
    expect(decideProjectionVersion('3', 3)).toEqual({ kind: 'current', version: 3 });
  });

  it('戳 < 代码版本 = rebuild（投影是旧语义算出来的）', () => {
    expect(decideProjectionVersion('3', 4)).toEqual({ kind: 'rebuild', from: 3, to: 4 });
  });

  it('戳 > 代码版本 = ahead（库被更新版本的程序重建过）', () => {
    expect(decideProjectionVersion('4', 3)).toEqual({ kind: 'ahead', from: 4, to: 3 });
  });

  it.each([
    ['手改过的垃圾', '非数字'],
    ['1.5', '小数'],
    ['-1', '负数'],
    ['', '空串'],
  ])('畸形戳 %s 按 fresh 处理（%s）：拦一个读不懂的值只会把用户锁在门外', (stamped) => {
    expect(decideProjectionVersion(stamped, 1)).toEqual({ kind: 'fresh' });
  });

  it('0 是合法版本号，不是畸形值（可用来强制所有人重建一次）', () => {
    expect(decideProjectionVersion('0', 1)).toEqual({ kind: 'rebuild', from: 0, to: 1 });
  });
});

describe('ensureProjectionVersion：读写与重建编排', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.core.close());

  it('fresh：打戳，但不重建（老库的收敛仍由各域 migrate 期的结构探测负责）', () => {
    h = harness(null, 1);
    expect(h.run()).toEqual({ kind: 'fresh' });
    expect(h.rebuilds()).toBe(0);
    expect(h.stamp()).toBe('1');
  });

  it('current：什么都不做，戳保持原样', () => {
    h = harness('2', 2);
    expect(h.run()).toEqual({ kind: 'current', version: 2 });
    expect(h.rebuilds()).toBe(0);
    expect(h.stamp()).toBe('2');
  });

  it('rebuild：先重建再打戳，且只重建一次', () => {
    h = harness('1', 3);
    expect(h.run()).toEqual({ kind: 'rebuild', from: 1, to: 3 });
    expect(h.rebuilds()).toBe(1);
    expect(h.stamp()).toBe('3');
  });

  it('rebuild 失败就不打戳：下次启动会再试，绝不留下「宣称是新的其实是旧的」的戳', () => {
    h = harness('1', 3);
    const db = h.core.exposeDb();
    expect(() =>
      ensureProjectionVersion(db, {
        group: 'unit',
        workspaceId: 'default',
        codeVersion: 3,
        rebuild: () => {
          throw new Error('重放炸了');
        },
      }),
    ).toThrow('重放炸了');
    expect(h.stamp()).toBe('1'); // 戳没动 → 下次启动仍判为 rebuild
  });

  it('ahead：拒绝，抛的是能给用户看的人话，且不重建不改戳', () => {
    h = harness('9', 3);
    let caught: unknown;
    try {
      h.run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataVersionError);
    const msg = (caught as DataVersionError).message;
    expect(msg).toContain('v9');
    expect(msg).toContain('v3');
    expect(msg).toContain('unit'); // 说清是哪一组投影，用户/支持才知道看哪里
    expect(h.rebuilds()).toBe(0);
    expect(h.stamp()).toBe('9'); // 戳没被改回去：装对程序就能开
  });

  it('多工作区各打各的戳：一个落后不牵连另一个', () => {
    h = harness(null, 2, 'ws-a');
    const core = h.core;
    const db = core.exposeDb();
    h.run();
    ensureProjectionVersion(db, {
      group: 'unit',
      workspaceId: 'ws-b',
      codeVersion: 2,
      rebuild: () => {},
    });
    // 只把 ws-a 回拨
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', projectionMetaKey('unit', 'ws-a'));

    let rebuiltFor: string | null = null;
    ensureProjectionVersion(db, {
      group: 'unit',
      workspaceId: 'ws-a',
      codeVersion: 2,
      rebuild: () => {
        rebuiltFor = 'ws-a';
      },
    });
    expect(rebuiltFor).toBe('ws-a');
    expect(core.getMeta(projectionMetaKey('unit', 'ws-a'))).toBe('2');
    expect(core.getMeta(projectionMetaKey('unit', 'ws-b'))).toBe('2');
  });

  it('不同投影组共用一个库互不干扰（键里带组名）', () => {
    expect(projectionMetaKey('wms', 'default')).toBe('projection.wms.default');
    expect(projectionMetaKey('core', 'default')).not.toBe(projectionMetaKey('wms', 'default'));
  });
});

describe('内核投影组自己也挂了版本戳', () => {
  let core: OneCore;
  beforeEach(() => {
    core = OneCore.open(':memory:');
  });
  afterEach(() => core.close());

  it('取工作区门面时自动打戳，版本号 = CORE_PROJECTION_VERSION', () => {
    expect(core.getMeta(projectionMetaKey('core', 'ws-x'))).toBeNull();
    core.workspace('ws-x');
    expect(core.getMeta(projectionMetaKey('core', 'ws-x'))).toBe(String(CORE_PROJECTION_VERSION));
  });

  it('同一个库多个工作区各打各的戳', () => {
    core.workspace('ws-x');
    core.workspace('ws-y');
    expect(core.getMeta(projectionMetaKey('core', 'ws-x'))).toBe(String(CORE_PROJECTION_VERSION));
    expect(core.getMeta(projectionMetaKey('core', 'ws-y'))).toBe(String(CORE_PROJECTION_VERSION));
  });

  // 「戳落后 → 重开时内核投影被整组重建」的端到端验证不在这里：
  // 需要落盘库重开 + 一个能被篡改又被冲回真值的真实内核投影（field_registry），
  // 那套 idiom 已经存在于 packages/wms/test/projection-version.test.ts。
});
