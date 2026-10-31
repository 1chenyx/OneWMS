import { describe, it, expect } from 'vitest';
import { OneCore, MigrationError, type MigrationBundle } from '../src/index.js';

/**
 * 迁移导出/导入测试（DESIGN §1.1「配置包 + 事件重放」/ §6.4，里程碑 7）：
 *  - exportBundle：元信息 + 全量事件按 (lamport, actor) 全序；
 *  - importBundle：全量恢复（重放后投影一致）、幂等、跨工作区拒绝、坏包拒绝。
 * 「迁移和同步是同一个动作的两种节奏」——导入 = 幂等摄入，重建走 replay。
 */

const WS = 'ws-mig';

/** 造一个有内容的源库：字段注册 + 一条业务事件 */
function mkSource(): OneCore {
  const core = OneCore.open(':memory:');
  const ws = core.workspace(WS);
  ws.fields.provide('core', { entity: 'sku', key: 'spec', label: '规格', dataType: 'string', sharing: 'shared' });
  ws.events.append('wms.sku.created', { skuCode: 'A-1', name: '轴承' }, 'user:local@node-a');
  return core;
}

describe('exportBundle', () => {
  it('元信息完整：kind/bundleVersion/nodeId/workspaceId/profileVersion/eventCount；events 全序', () => {
    const core = mkSource();
    try {
      const bundle = core.migration.exportBundle(WS);
      expect(bundle.kind).toBe('onewms-migration-bundle');
      expect(bundle.bundleVersion).toBe(1);
      expect(bundle.nodeId).toBe(core.nodeId);
      expect(bundle.workspaceId).toBe(WS);
      expect(bundle.eventCount).toBe(bundle.events.length);
      expect(bundle.eventCount).toBeGreaterThan(0);
      // 全序 (lamport, actor) 单调不降
      for (let i = 1; i < bundle.events.length; i++) {
        const prev = bundle.events[i - 1]!;
        const cur = bundle.events[i]!;
        const ordered =
          cur.lamport > prev.lamport || (cur.lamport === prev.lamport && cur.actor >= prev.actor);
        expect(ordered).toBe(true);
      }
    } finally {
      core.close();
    }
  });

  it('空账本：元信息照常、零事件', () => {
    const core = OneCore.open(':memory:');
    try {
      const bundle = core.migration.exportBundle('ws-empty');
      expect(bundle.eventCount).toBe(0);
      expect(bundle.events).toEqual([]);
    } finally {
      core.close();
    }
  });
});

describe('importBundle', () => {
  it('全量恢复：新库导入 → replay → 注册表与事件流与源一致', () => {
    const src = mkSource();
    const dst = OneCore.open(':memory:');
    try {
      const bundle = src.migration.exportBundle(WS);
      const { accepted } = dst.migration.importBundle(WS, bundle);
      expect(accepted).toBe(bundle.eventCount);

      dst.workspace(WS).replay();
      const srcFields = src.workspace(WS).fields.list('sku');
      const dstFields = dst.workspace(WS).fields.list('sku');
      expect(dstFields).toEqual(srcFields);

      const srcHello = src.sync.handshake(WS);
      const dstHello = dst.sync.handshake(WS);
      expect(dstHello.eventCount).toBe(srcHello.eventCount);
      expect(Object.keys(dstHello.watermarks)).toEqual(Object.keys(srcHello.watermarks));
    } finally {
      src.close();
      dst.close();
    }
  });

  it('幂等：重复导入 accepted=0（eventId 查重）', () => {
    const src = mkSource();
    const dst = OneCore.open(':memory:');
    try {
      const bundle = src.migration.exportBundle(WS);
      expect(dst.migration.importBundle(WS, bundle).accepted).toBeGreaterThan(0);
      const again = dst.migration.importBundle(WS, bundle);
      expect(again.accepted).toBe(0);
      expect(again.skipped).toBe(bundle.eventCount);
    } finally {
      src.close();
      dst.close();
    }
  });

  it('workspaceId 不一致 → MigrationError（跨工作区 = 跨密钥边界）', () => {
    const src = mkSource();
    try {
      const bundle = src.migration.exportBundle(WS);
      expect(() => src.migration.importBundle('ws-other', bundle)).toThrow(MigrationError);
    } finally {
      src.close();
    }
  });

  it('坏包逐项拒绝：kind / bundleVersion / events 非数组 / 非法信封 / 跨工作区事件', () => {
    const core = OneCore.open(':memory:');
    try {
      expect(() => core.migration.importBundle(WS, {})).toThrow(MigrationError);
      expect(() =>
        core.migration.importBundle(WS, { kind: 'onewms-migration-bundle', bundleVersion: 99, events: [] }),
      ).toThrow(MigrationError);
      expect(() =>
        core.migration.importBundle(WS, { kind: 'onewms-migration-bundle', bundleVersion: 1, events: 'nope' }),
      ).toThrow(MigrationError);
      expect(() =>
        core.migration.importBundle(WS, {
          kind: 'onewms-migration-bundle',
          bundleVersion: 1,
          workspaceId: WS,
          events: [{ eventId: 'x' }],
        }),
      ).toThrow(MigrationError);
      expect(() =>
        core.migration.importBundle(WS, {
          kind: 'onewms-migration-bundle',
          bundleVersion: 1,
          workspaceId: WS,
          events: [
            {
              eventId: 'e1',
              workspaceId: 'ws-other',
              actor: 'a',
              lamport: 1,
              seq: 1,
              type: 'x.y',
              payload: {},
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ).toThrow(/跨工作区事件/);
    } finally {
      core.close();
    }
  });
});
