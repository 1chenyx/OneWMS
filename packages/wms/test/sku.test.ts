import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, ToolValidationError } from '@one/core';
import { WmsDomain, SkuAlreadyExistsError, SkuNotFoundError } from '../src/index.js';

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-test');
});

afterEach(() => {
  core.close();
});

describe('SKU：创建与更新', () => {
  it('工具创建 SKU → 事件落账 → 投影可见', async () => {
    const result = await ws.tools.invoke(
      'wms.sku.create',
      { skuCode: 'A-1001', name: 'M6 螺丝', extData: { spec: '不锈钢' } },
      'ai:test',
    );

    expect(result).toMatchObject({ skuCode: 'A-1001', name: 'M6 螺丝' });
    const sku = ws.skus.byCode('A-1001');
    expect(sku).toBeDefined();
    expect(sku!.name).toBe('M6 螺丝');
    expect(sku!.extData).toEqual({ spec: '不锈钢' });
    expect(sku!.id).toBe((result as { skuId: string }).skuId);

    // wms. 命名空间里有且仅有一条创建事件（构造期另有种子事件：字段 provide + config.change）
    const types: string[] = [];
    ws.events.forEach((e) => {
      if (e.type.startsWith('wms.')) types.push(e.type);
    });
    expect(types).toEqual(['wms.sku.created']);
  });

  it('重复编码 → 拒绝且不产生第二个事件（命令失败 ≠ 事实）', async () => {
    const baseline = ws.events.count(); // 构造期种子事件之后
    await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'x' });
    await expect(
      ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: 'y' }),
    ).rejects.toThrow(SkuAlreadyExistsError);

    expect(ws.skus.list()).toHaveLength(1);
    expect(ws.events.count()).toBe(baseline + 1);
  });

  it('更新名称与扩展字段（未传字段保持不变）', async () => {
    await ws.tools.invoke('wms.sku.create', {
      skuCode: 'A-1',
      name: '旧名',
      extData: { spec: '塑料' },
    });
    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', name: '新名' });

    const sku = ws.skus.byCode('A-1')!;
    expect(sku.name).toBe('新名');
    expect(sku.extData).toEqual({ spec: '塑料' }); // extData 未传 → 保持

    await ws.tools.invoke('wms.sku.update', { skuCode: 'A-1', extData: { spec: '金属' } });
    expect(ws.skus.byCode('A-1')!.extData).toEqual({ spec: '金属' });
  });

  it('更新不存在的 SKU → SkuNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.sku.update', { skuCode: 'ghost', name: 'x' }),
    ).rejects.toThrow(SkuNotFoundError);
  });

  it('参数校验：缺必填 → ToolValidationError（schema 层拦截，未进 handler）', async () => {
    await expect(ws.tools.invoke('wms.sku.create', { skuCode: 'A-1' })).rejects.toThrow(
      ToolValidationError,
    );
  });

  it('list() 暴露工具元数据（handler 不可见——AI 上下文安全）', () => {
    const metas = ws.tools.list().filter((t) => t.id.startsWith('wms.'));
    expect(metas.length).toBeGreaterThanOrEqual(6);
    for (const m of metas) {
      expect(m).not.toHaveProperty('handler');
      expect(m.description).toBeTruthy();
    }
  });
});
