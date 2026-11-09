import { describe, it, expect, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';

/**
 * 仓储工作区上的实况查询：出入库流程、可开关的功能、SKU 扩展字段。
 * 种子由 WmsDomain.attach 装上，这里只核对助手能读到的形状。
 */

let core: OneCore;

afterEach(() => {
  core?.close();
});

describe('仓储项目实况', () => {
  it('能读出入库流程、到货预报功能和 SKU 字段', async () => {
    core = OneCore.open(':memory:');
    const ws = WmsDomain.attach(core).workspace('ws-profile-query');

    const flows = (await ws.tools.invoke('profile.workflow.query', {})) as {
      workflows: { id: string; states: { id: string; label: string }[]; transitions: { active: boolean }[] }[];
    };
    const inbound = flows.workflows.find((wf) => wf.id === 'inbound');
    const outbound = flows.workflows.find((wf) => wf.id === 'outbound');
    expect(inbound?.states.map((s) => s.label)).toContain('已创建');
    expect(inbound?.states.map((s) => s.id)).toContain('announced');
    expect(outbound?.states.map((s) => s.label)).toContain('已发货');
    expect(inbound?.transitions.some((t) => t.active)).toBe(true);

    const asn = (await ws.tools.invoke('profile.module.query', { moduleId: 'module.asn' })) as {
      modules: { name: string; installed: boolean; enabled: boolean; description: string; settings: unknown[] }[];
    };
    expect(asn.modules[0]).toMatchObject({ name: '到货预报', installed: true, enabled: true });
    expect(asn.modules[0].description).toContain('预报');

    const wms = (await ws.tools.invoke('profile.module.query', { moduleId: 'core.wms' })) as {
      modules: { settings: { key: string; value: unknown }[] }[];
    };
    expect(wms.modules[0].settings.find((s) => s.key === 'defaultAllocation')?.value).toBe('strict');

    const fields = (await ws.tools.invoke('profile.field.query', { entity: '商品' })) as {
      entities: { entity: string; fields: { key: string; label: string }[]; fixed: { key: string }[] }[];
    };
    expect(fields.entities[0].entity).toBe('sku');
    expect(fields.entities[0].fields.map((f) => f.key).sort()).toEqual(['category', 'spec', 'unit']);
    expect(fields.entities[0].fields.find((f) => f.key === 'spec')?.label).toBe('规格');
    expect(fields.entities[0].fixed.map((field) => field.key)).toContain('skuCode');
    expect(fields.entities[0].fixed.map((field) => field.key)).toContain('serialTracked');

    const inventory = (await ws.tools.invoke('profile.field.query', { entity: '库存' })) as {
      entities: { entity: string; label: string; fields: unknown[]; fixed: { key: string; label: string }[] }[];
    };
    expect(inventory.entities[0].entity).toBe('inventory');
    expect(inventory.entities[0].label).toBe('库存');
    expect(inventory.entities[0].fields).toEqual([]);
    expect(inventory.entities[0].fixed.find((field) => field.key === 'available')?.label).toBe('可用量');

    const order = (await ws.tools.invoke('profile.field.query', { entity: '单据' })) as {
      entities: { entity: string; fixed: { key: string }[] }[];
    };
    expect(order.entities[0].entity).toBe('order');
    expect(order.entities[0].fixed.map((field) => field.key)).toEqual(
      expect.arrayContaining(['orderNo', 'state', 'returnOf', 'expectedAt', 'replenishment', 'fulfilledQty']),
    );

    const location = (await ws.tools.invoke('profile.field.query', { entity: '库位' })) as {
      entities: { fixed: { key: string }[] }[];
    };
    expect(location.entities[0].fixed.map((field) => field.key)).toContain('warehouseCode');

    const inboundByName = (await ws.tools.invoke('profile.workflow.query', { workflowId: '入库' })) as {
      workflows: { id: string; label: string }[];
    };
    expect(inboundByName.workflows[0]).toMatchObject({ id: 'inbound', label: '入库' });

    const asnByAlias = (await ws.tools.invoke('profile.module.query', { moduleId: '预报' })) as {
      modules: { id: string; name: string; installed: boolean; enabled: boolean }[];
    };
    expect(asnByAlias.modules[0]).toMatchObject({ id: 'module.asn', name: '到货预报', installed: true, enabled: true });

    const overview = (await ws.tools.invoke('profile.overview', {})) as {
      shape: {
        enabled: { name: string }[];
        canChange: { toggleModule: string; notInstalled: string };
        objects: { entity: string; label: string }[];
      };
    };
    expect(overview.shape.enabled.map((item) => item.name)).toContain('到货预报');
    expect(overview.shape.canChange.toggleModule).toContain('enabled');
    expect(overview.shape.canChange.notInstalled).toContain('不能安装');
    expect(overview.shape.objects.map((item) => item.label)).toEqual(
      expect.arrayContaining(['商品', '库存', '单据', '库位', '仓库', '托盘']),
    );
  });
});
