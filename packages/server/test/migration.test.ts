import { describe, it, expect, afterEach } from 'vitest';
import { createApp, createAppContext, type AppContext } from '../src/index.js';
import type { MigrationBundle } from '@one/core';

/**
 * 密钥与迁移端点测试（DESIGN §8.5 传输安全 / §6.4 迁移闭环，里程碑 7）：
 *  - /api/keys：生成 / 查询 / 导出 / 导入（幂等拒绝、格式校验）；
 *  - /api/migration：export → 新节点 import → replay → 数据一致；
 *    幂等、跨工作区拒绝、manifest 在场性报告。
 */

const ctxs: AppContext[] = [];
afterEach(() => {
  for (const c of ctxs.splice(0)) c.close();
});

function setup(workspaceId: string) {
  const ctx = createAppContext({ dbPath: ':memory:', workspaceId });
  ctxs.push(ctx);
  return { ctx, app: createApp(ctx) };
}

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

describe('密钥端点（/api/keys）', () => {
  it('生成 → 查询（不含本体）→ 导出（含本体）；重复生成 → 409 KEY_EXISTS', async () => {
    const { app } = setup('ws-keys');
    const gen = await post(app, '/api/keys', {});
    expect(gen.status).toBe(201);
    const genBody = (await gen.json()) as { key: string; fingerprint: string };
    expect(genBody.key).toMatch(/^[0-9a-f]{64}$/);

    const info = (await (await app.request('/api/keys')).json()) as {
      exists: boolean;
      fingerprint: string;
      createdAt?: string;
    };
    expect(info.exists).toBe(true);
    expect(info.fingerprint).toBe(genBody.fingerprint);
    expect(info.createdAt).toBeTypeOf('string');

    const exported = (await (await app.request('/api/keys/export')).json()) as { key: string };
    expect(exported.key).toBe(genBody.key);

    const again = await post(app, '/api/keys', {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('KEY_EXISTS');
  });

  it('未生成时：查询 exists=false；导出 404；导入非法格式 → 400 CRYPTO_ERROR', async () => {
    const { app } = setup('ws-keys-2');
    expect(((await (await app.request('/api/keys')).json()) as { exists: boolean }).exists).toBe(false);
    expect((await app.request('/api/keys/export')).status).toBe(404);
    const bad = await post(app, '/api/keys/import', { key: 'not-a-key' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('CRYPTO_ERROR');
  });

  it('导入（人工交换的落点）→ 成功后重复导入 → 409', async () => {
    const { app } = setup('ws-keys-3');
    const ok = await post(app, '/api/keys/import', { key: 'c'.repeat(64) });
    expect(ok.status).toBe(200);
    const again = await post(app, '/api/keys/import', { key: 'd'.repeat(64) });
    expect(again.status).toBe(409);
  });
});

describe('迁移端点（/api/migration）', () => {
  it('export → 新节点 import → replay：SKU/库存/配置与源一致；重复导入幂等', async () => {
    const src = setup('ws-mig');
    const dst = setup('ws-mig');

    await post(src.app, '/api/skus', { skuCode: 'M-1', name: '迁移物资' });
    await post(src.app, '/api/skus', { skuCode: 'M-2', name: '第二批', extData: { spec: '6204' } });
    await post(src.app, '/api/inventory/adjust', { skuCode: 'M-1', delta: 7, reason: '期初' });

    const bundle = (await (await src.app.request('/api/migration/export')).json()) as MigrationBundle;
    expect(bundle.kind).toBe('onewms-migration-bundle');
    expect(bundle.workspaceId).toBe('ws-mig');
    expect(bundle.eventCount).toBe(bundle.events.length);
    expect(bundle.eventCount).toBeGreaterThan(0);

    const imp = (await (await post(dst.app, '/api/migration/import', { bundle })).json()) as {
      accepted: number;
      skipped: number;
      replayed: boolean;
      missingManifests: { id: string }[];
    };
    expect(imp.accepted).toBe(bundle.eventCount);
    expect(imp.replayed).toBe(true);
    expect(imp.missingManifests).toEqual([]); // core.wms 在 manifest 目录里

    const skus = (await (await dst.app.request('/api/skus')).json()) as {
      skuCode: string;
      name: string;
      extData?: Record<string, unknown>;
    }[];
    expect(skus.find((s) => s.skuCode === 'M-2')!.extData).toEqual({ spec: '6204' });
    const inv = (await (await dst.app.request('/api/inventory')).json()) as {
      skuCode: string;
      quantity: number;
    }[];
    expect(inv.find((i) => i.skuCode === 'M-1')!.quantity).toBe(7);
    // 配置（Profile 快照）同步恢复
    const snapSrc = await (await src.app.request('/api/profile/snapshot')).json();
    const snapDst = await (await dst.app.request('/api/profile/snapshot')).json();
    expect(snapDst).toEqual(snapSrc);

    // 幂等：重复导入零新事件
    const again = (await (await post(dst.app, '/api/migration/import', { bundle })).json()) as {
      accepted: number;
      replayed: boolean;
    };
    expect(again.accepted).toBe(0);
    expect(again.replayed).toBe(false);
  });

  it('manifest 在场性报告：账本引用了本节点没有的模块 → 报告缺失、不阻塞', async () => {
    const src = setup('ws-mig-manifest');
    const dst = setup('ws-mig-manifest');
    // 注入一条引用不存在模块的安装事件（模拟「别的节点装过 v2 插件市场模块」）
    src.ctx.ws.events.append('module.installed', { id: 'module.ghost', version: '9.9.9' }, 'module:ghost@node-x');

    const bundle = (await (await src.app.request('/api/migration/export')).json()) as MigrationBundle;
    const imp = (await (await post(dst.app, '/api/migration/import', { bundle })).json()) as {
      accepted: number;
      missingManifests: { id: string; version: string }[];
    };
    expect(imp.accepted).toBe(bundle.eventCount); // 不阻塞：账本是事实全收
    expect(imp.missingManifests).toEqual([{ id: 'module.ghost', version: '9.9.9' }]);
  });

  it('坏包与跨工作区：无 bundle → 400；kind 错 / workspaceId 不一致 → 400 MIGRATION_ERROR', async () => {
    const { app } = setup('ws-mig-bad');
    const noBundle = await post(app, '/api/migration/import', {});
    expect(noBundle.status).toBe(400);

    const badKind = await post(app, '/api/migration/import', { bundle: { kind: 'x' } });
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { code: string }).code).toBe('MIGRATION_ERROR');

    const cross = await post(app, '/api/migration/import', {
      bundle: { kind: 'onewms-migration-bundle', bundleVersion: 1, workspaceId: 'ws-other', events: [] },
    });
    expect(cross.status).toBe(400);
    expect(((await cross.json()) as { code: string }).code).toBe('MIGRATION_ERROR');
  });
});
