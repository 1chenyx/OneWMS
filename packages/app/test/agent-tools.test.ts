import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../src/api/client';
import type { AgentToolInfo, ToolBucket } from '../src/pages/agent-tools';
import {
  MISSING_TOOLS,
  agentChangeLines,
  agentSnapshot,
  applyGroupLevel,
  applyToolIds,
  assistantSummary,
  buildBuckets,
  groupChoices,
  groupLevel,
  levelDetail,
  levelTitle,
  matchesTool,
  oneLine,
  readOnlyIds,
  sameIds,
  toolGroupId,
  visibleBuckets,
} from '../src/pages/agent-tools';

const catalog: AgentToolInfo[] = [
  { id: 'wms.inventory.adjust', label: '调整库存', description: '增减库存。', permission: 'write' },
  { id: 'wms.inventory.query', label: '查询库存', description: '查询库存余量。', permission: 'read' },
  { id: 'wms.ledger.query', label: '查询流水', description: '查库存流水。', permission: 'read' },
  { id: 'wms.order.query', label: '查询单据', description: '按单号查出入库单。', permission: 'read' },
  { id: 'wms.sku.create', label: '创建商品', description: '新建一个 SKU。', permission: 'write' },
  { id: 'memory.read', label: '读取记忆', description: '读取记忆章节。', permission: 'read' },
  { id: 'custom.echo', label: '回声', description: '测试工具。', permission: 'read' },
];

describe('工具分组', () => {
  it('wms 取第二段，其余取第一段，流水并进库存', () => {
    expect(toolGroupId('wms.order.conflict.list')).toBe('order');
    expect(toolGroupId('wms.inventory.query')).toBe('inventory');
    expect(toolGroupId('wms.ledger.query')).toBe('inventory');
    expect(toolGroupId('memory.read')).toBe('memory');
    expect(toolGroupId('profile.propose')).toBe('profile');
    expect(toolGroupId('solo')).toBe('solo');
  });

  it('按业务顺序分组，只读排在写入前面，未知组在最后', () => {
    const buckets = buildBuckets(catalog, []);
    expect(buckets.map((bucket) => bucket.id)).toEqual(['inventory', 'order', 'sku', 'memory', 'custom']);
    const inventory = buckets[0]!.tools.map((tool) => tool.id);
    expect(inventory.indexOf('wms.inventory.adjust')).toBeGreaterThan(inventory.indexOf('wms.inventory.query'));
    expect(inventory.indexOf('wms.inventory.adjust')).toBeGreaterThan(inventory.indexOf('wms.ledger.query'));
    expect(buckets[0]!.label).toBe('库存');
    expect(buckets.find((bucket) => bucket.id === 'custom')!.label).toBe('custom');
  });

  it('已授权但不在目录里的工具单独成组，放在最前', () => {
    const buckets = buildBuckets(catalog, ['gone.tool', 'wms.sku.create', 'gone.tool']);
    expect(buckets[0]!.id).toBe(MISSING_TOOLS);
    expect(buckets[0]!.label).toBe('不在目录');
    expect(buckets[0]!.tools.map((tool) => tool.id)).toEqual(['gone.tool']);
  });

  it('筛选只留下匹配的组，未知权限不进只读或写入', () => {
    const buckets = buildBuckets(
      [{ id: 'wms.inventory.query', label: '查询库存', description: '查询。', permission: 'read' }],
      ['gone.tool'],
    );
    const missing = buckets[0]!.tools[0]!;
    expect(matchesTool(missing, '', 'read')).toBe(false);
    expect(matchesTool(missing, 'gone', 'all')).toBe(true);
    const shown = visibleBuckets(buildBuckets(catalog, []), '记忆', 'all');
    expect(shown.map((bucket) => bucket.id)).toEqual(['memory']);
    expect(visibleBuckets(buildBuckets(catalog, []), '', 'write').map((bucket) => bucket.id)).toEqual([
      'inventory',
      'sku',
    ]);
  });

  it('说明只取第一句', () => {
    expect(oneLine('查询库存余量。后面还有很多。')).toBe('查询库存余量。');
    expect(oneLine('没有句号')).toBe('没有句号');
    expect(oneLine(`${'很'.repeat(80)}。结尾`)).toBe(`${'很'.repeat(72)}…`);
  });
});

describe('能力分档', () => {
  const inventory = buildBuckets(catalog, [])[0]!;

  it('整组对得齐就是不开放、只能查询或可以修改，对不齐是单独调整', () => {
    expect(groupLevel(inventory.tools, [])).toBe('off');
    expect(groupLevel(inventory.tools, ['wms.inventory.query', 'wms.ledger.query'])).toBe('read');
    expect(groupLevel(inventory.tools, ['wms.inventory.query'])).toBe('custom');
    expect(
      groupLevel(inventory.tools, ['wms.inventory.query', 'wms.ledger.query', 'wms.inventory.adjust']),
    ).toBe('write');
    const sku = buildBuckets(catalog, []).find((bucket) => bucket.id === 'sku')!;
    const order = buildBuckets(catalog, []).find((bucket) => bucket.id === 'order')!;
    expect(groupChoices(sku).map((choice) => choice.label)).toEqual(['不开放', '可以修改']);
    expect(groupChoices(order).map((choice) => choice.label)).toEqual(['不开放', '只能查询']);
    expect(groupLevel(sku.tools, ['wms.sku.create'])).toBe('write');
    expect(levelTitle('write', 'profile')).toBe('可以提议');
    expect(levelTitle('read', 'profile')).toBe('只能查看');
    expect(levelTitle('custom', 'inventory')).toBe('单独调整');
    expect(levelDetail(inventory, 'off')).toBe('这个助手用不到这一块。');
    expect(levelDetail(inventory, 'read')).toBe('只能查询，不能改数据。');
    expect(levelDetail(sku, 'write')).toBe('可以修改这一块的数据。');
  });

  it('拨整组时不动其他组的授权', () => {
    const on = applyGroupLevel(['wms.sku.create', 'wms.inventory.query'], inventory.tools, 'write');
    expect(on[0]).toBe('wms.sku.create');
    expect(new Set(on)).toEqual(new Set(['wms.sku.create', ...inventory.tools.map((tool) => tool.id)]));
    expect(applyGroupLevel(['wms.sku.create', 'wms.inventory.query'], inventory.tools, 'off')).toEqual([
      'wms.sku.create',
    ]);
  });

  it('清单用一句话说明能做什么', () => {
    const buckets = buildBuckets(catalog, []);
    expect(assistantSummary(buckets, [])).toBe('还不能做任何事');
    expect(assistantSummary(buckets, ['wms.inventory.query'])).toBe('单独调整库存');
    expect(assistantSummary(buckets, ['wms.inventory.query', 'wms.ledger.query', 'wms.sku.create'])).toBe(
      '可以修改商品，只能查询库存',
    );
    const profile: ToolBucket = {
      id: 'profile',
      label: '配置',
      tools: [
        { id: 'profile.get', label: '查看配置', description: '', permission: 'read' },
        { id: 'profile.propose', label: '提议修改', description: '', permission: 'write' },
      ],
    };
    expect(assistantSummary([profile], ['profile.get', 'profile.propose'])).toBe('可以提议修改配置');
    expect(assistantSummary([profile], ['profile.get'])).toBe('只能查看配置');
    const many: ToolBucket[] = ['库存', '出入库', '拣货', '盘点'].map((label, index) => ({
      id: ['inventory', 'order', 'picking', 'stocktake'][index]!,
      label,
      tools: [{ id: `t${index}`, label, description: '', permission: 'read' }],
    }));
    expect(assistantSummary(many, ['t0', 't1', 't2', 't3'])).toBe('只能查询库存、出入库、拣货等');
  });
});

describe('助手改动说明', () => {
  const base = (patch: Partial<AgentDef>): AgentDef => ({
    id: 'general',
    name: '通用助手',
    description: '',
    systemPrompt: '',
    tools: ['wms.inventory.query', 'wms.ledger.query'],
    ...patch,
  });

  it('按新增、改权限、改名和去掉来写', () => {
    const before = [base({})];
    const renamed = [base({ name: '仓库助手' })];
    const writable = [
      base({ tools: ['wms.inventory.query', 'wms.ledger.query', 'wms.inventory.adjust'] }),
    ];
    const added = [
      ...before,
      base({ id: 'qa', name: '质检', tools: [] }),
    ];
    expect(agentChangeLines(before, renamed, catalog)[0]).toBe('「通用助手」改名为「仓库助手」，只能查询库存');
    expect(agentChangeLines(before, writable, catalog)).toEqual(['「通用助手」改为可以修改库存']);
    expect(agentChangeLines(before, added, catalog)).toEqual(['新增「质检」：还不能做任何事']);
    expect(agentChangeLines(added, before, catalog)).toEqual(['去掉「质检」']);
    expect(agentChangeLines(before, [base({ description: '只查库存' })], catalog)).toEqual([
      '「通用助手」的说明或人设有改动',
    ]);
  });
});

describe('授权勾选', () => {
  it('保留原有顺序，新勾上的接在后面，重复的只留一次', () => {
    expect(applyToolIds(['a', 'b'], ['c'], true)).toEqual(['a', 'b', 'c']);
    expect(applyToolIds(['a', 'b', 'c'], ['b'], false)).toEqual(['a', 'c']);
    expect(applyToolIds(['a', 'a', 'b'], ['a'], true)).toEqual(['a', 'b']);
  });

  it('只读清单按目录顺序，相同成员不计较顺序', () => {
    expect(readOnlyIds(catalog)).toEqual([
      'wms.inventory.query',
      'wms.ledger.query',
      'wms.order.query',
      'memory.read',
      'custom.echo',
    ]);
    expect(sameIds(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameIds(['a', 'a'], ['a', 'b'])).toBe(false);
  });

  it('快照不因键序变化而变', () => {
    const left = agentSnapshot([
      {
        id: 'general',
        name: '通用',
        description: '',
        systemPrompt: '人设',
        tools: ['wms.inventory.query'],
      },
    ]);
    const right = agentSnapshot([
      {
        tools: ['wms.inventory.query'],
        systemPrompt: '人设',
        description: '',
        name: '通用',
        id: 'general',
      },
    ]);
    expect(left).toBe(right);
  });
});
