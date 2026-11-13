import { describe, it, expect } from 'vitest';
import type { AgentToolMeta } from '../src/index.js';
import {
  LOADED_GROUP_KEEP,
  TOOL_CATALOG_DEFER_AT,
  applyLoad,
  catalogBlock,
  expandedGroupsFromHistory,
  presentCatalog,
  toolGroup,
  toolSummary,
} from '../src/tool-catalog.js';

function tool(id: string, description = `${id} 的完整说明。后半句不进摘要。`): AgentToolMeta {
  return {
    id,
    label: id,
    description,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '名称' },
      },
    },
    permission: 'read',
  };
}

describe('tool-catalog', () => {
  it('组 id 取 wms 的第二段，其它取第一段', () => {
    expect(toolGroup('wms.order.conflict.list')).toBe('order');
    expect(toolGroup('memory.list')).toBe('memory');
    expect(toolGroup('profile.propose')).toBe('profile');
  });

  it('摘要停在第一个句号，超长再截断', () => {
    expect(toolSummary('创建一张入库单或出库单。后面是长规则。')).toBe('创建一张入库单或出库单');
    expect(toolSummary('没有句号的说明')).toBe('没有句号的说明');
    expect(toolSummary('啊'.repeat(100))).toBe(`${'啊'.repeat(80)}…`);
  });

  it('未超过上限：全部可调用，非常驻工具是摘要，常驻工具保持全文', () => {
    const query = tool('wms.inventory.query', '查询库存余量。下钻 byLocation。');
    const order = tool('wms.order.create');
    const presented = presentCatalog([order, query], new Set());
    expect(presented.map((t) => t.id)).toEqual(['wms.order.create', 'wms.inventory.query', 'tools.load']);
    expect(presented[0].description).toBe('wms.order.create 的完整说明');
    expect(presented[0].parameters.properties?.name?.description).toBeUndefined();
    expect(presented[1].description).toContain('byLocation');
    expect(presented[2].description).toContain('order（1）');
    expect(presented[2].description).toContain('inventory（1）');
    expect(presented[2].description).not.toContain(order.label);
    expect(presented[2].description).not.toContain(query.label);
  });

  it('超过上限：未加载的组不进清单，加载后恢复全文', () => {
    const many = Array.from({ length: TOOL_CATALOG_DEFER_AT }, (_, i) => tool(`wms.extra.t${i}`));
    const order = tool('wms.order.create');
    const domain = [...many, order];
    expect(domain.length).toBeGreaterThan(TOOL_CATALOG_DEFER_AT);

    const hidden = presentCatalog(domain, new Set());
    expect(hidden.map((t) => t.id)).toEqual(['tools.load']);
    expect(hidden[0].description).toContain('必须先加载');

    const shown = presentCatalog(domain, new Set(['order']));
    const loaded = shown.find((t) => t.id === 'wms.order.create');
    expect(loaded?.description).toContain('后半句不进摘要');
    expect(shown.some((t) => t.id.startsWith('wms.extra'))).toBe(false);
  });

  it('加载只接受授权内的组；历史能恢复', () => {
    const domain = [tool('wms.order.create')];
    expect(applyLoad(domain, { group: 'sku' }).ok).toBe(false);
    expect(applyLoad(domain, {}).ok).toBe(false);
    const ok = applyLoad(domain, { group: 'order' });
    expect(ok).toMatchObject({ ok: true, group: 'order', payload: { toolIds: ['wms.order.create'] } });

    const groups = expandedGroupsFromHistory([
      { role: 'tool-results', results: [{ callId: 'c', toolId: 'tools.load', ok: true, payload: { group: 'order', toolIds: [] } }] },
      { role: 'tool-results', results: [{ callId: 'd', toolId: 'tools.load', ok: false, payload: { error: 'x', group: 'sku' } }] },
    ]);
    expect([...groups]).toEqual(['order']);
  });

  it('已加载的组只留最近用过的三组', () => {
    const load = (callId: string, group: string) =>
      ({
        role: 'tool-results' as const,
        results: [{ callId, toolId: 'tools.load', ok: true, payload: { group, toolIds: [] } }],
      });
    expect(LOADED_GROUP_KEEP).toBe(3);
    const kept = expandedGroupsFromHistory([
      load('1', 'order'),
      load('2', 'sku'),
      load('3', 'inventory'),
      load('4', 'memory'),
    ]);
    expect([...kept]).toEqual(['sku', 'inventory', 'memory']);

    // 调用还在集合里的组，会把它挪到最近；没加载过的组不会因为调用而加进来
    const refreshed = expandedGroupsFromHistory([
      load('1', 'order'),
      load('2', 'sku'),
      load('3', 'inventory'),
      {
        role: 'tool-results',
        results: [{ callId: 'u', toolId: 'wms.order.create', ok: true, payload: {} }],
      },
      {
        role: 'tool-results',
        results: [{ callId: 'q', toolId: 'wms.partner.list', ok: true, payload: {} }],
      },
      load('4', 'memory'),
    ]);
    expect([...refreshed]).toEqual(['inventory', 'order', 'memory']);
  });

  it('延迟模式下未加载的调用被拦住，会话工具除外', () => {
    const domain = Array.from({ length: TOOL_CATALOG_DEFER_AT + 1 }, (_, i) => tool(`wms.extra.t${i}`));
    expect(catalogBlock('wms.extra.t0', domain, new Set())?.error).toContain('尚未加载');
    expect(catalogBlock('wms.extra.t0', domain, new Set(['extra']))).toBeUndefined();
    expect(catalogBlock('wms.sku.create', domain, new Set())?.error).toContain('授权');
    expect(catalogBlock('chat.attachment.read', domain, new Set(), new Set(['chat.attachment.read']))).toBeUndefined();
    expect(catalogBlock('wms.inventory.query', [tool('wms.inventory.query')], new Set())).toBeUndefined();
  });
});
