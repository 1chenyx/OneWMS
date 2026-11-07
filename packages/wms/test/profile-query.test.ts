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

    const fields = (await ws.tools.invoke('profile.field.query', { entity: 'sku' })) as {
      entities: { fields: { key: string; label: string }[] }[];
    };
    expect(fields.entities[0].fields.map((f) => f.key).sort()).toEqual(['category', 'spec', 'unit']);
    expect(fields.entities[0].fields.find((f) => f.key === 'spec')?.label).toBe('规格');
  });
});
