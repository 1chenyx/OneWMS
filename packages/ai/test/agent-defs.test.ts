import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
import { WmsDomain } from '@one/wms';
import {
  AI_MODULE_ID,
  aiModuleManifest,
  builtinAgentDefs,
  readAgentDefs,
} from '../src/index.js';

/**
 * Agent 定义契约（M16）：内置三件套的工具矩阵、readAgentDefs 的
 * 配置面读取 / 脏面窄化 / 内置兜底，以及「定义走慢通道」的完整闭环
 * （install 种子 default:[] 使 replace 路径可用——本套件顺带验证）。
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = WmsDomain.attach(core).workspace('ws-agent-defs-test');
});

afterEach(() => {
  core.close();
});

describe('builtinAgentDefs：内置三件套工具矩阵', () => {
  it('general = 全量 − profile.propose；readonly = 仅 read；config = read + propose', () => {
    const all = ws.tools.list();
    const readIds = all.filter((t) => t.permission === 'read').map((t) => t.id);
    const defOf = (id: string) => builtinAgentDefs(all).find((d) => d.id === id)!;

    expect(defOf('general').tools).toEqual(all.map((t) => t.id).filter((id) => id !== 'profile.propose'));
    expect(defOf('readonly').tools).toEqual(readIds);
    expect(defOf('config').tools).toEqual([...readIds, 'profile.propose']);
    // 全部带人设与非空标识（装配的前提）
    for (const d of builtinAgentDefs(all)) {
      expect(d.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(d.name.length).toBeGreaterThan(0);
    }
  });
});

describe('readAgentDefs：配置面 / 兜底', () => {
  it('未装 core.ai（未配置）→ 内置三件套', () => {
    expect(readAgentDefs(ws).map((d) => d.id)).toEqual(['general', 'readonly', 'config']);
  });

  it('装 core.ai 后 settings.agents=[]（install 种子 default:[]）→ 仍内置，且 replace 路径可用', async () => {
    ws.modules.install(aiModuleManifest(), { actor: `module:${AI_MODULE_ID}@local` });
    // 种子写入了 agents 键（空清单 = 内置兜底）
    expect(readAgentDefs(ws).map((d) => d.id)).toEqual(['general', 'readonly', 'config']);

    // 慢通道整体 replace（键在场——manifest default:[] 的意义所在）
    const custom = [{ id: 'inspector', name: '质检助手', description: '', systemPrompt: '你是质检助手。', tools: ['wms.inventory.expiring'] }];
    const r = (await ws.tools.invoke(
      'profile.propose',
      { patch: [{ op: 'replace', path: `/modules/${AI_MODULE_ID}/settings/agents`, value: custom }], note: '自定义助手' },
      'user:test',
    )) as { proposalId: string };
    ws.profile.confirm(r.proposalId, 'user:test');

    const defs = readAgentDefs(ws);
    expect(defs.map((d) => d.id)).toEqual(['inspector']);
    expect(defs[0].systemPrompt).toBe('你是质检助手。');
    expect(defs[0].tools).toEqual(['wms.inventory.expiring']);
  });

  it('脏面窄化：非法项丢弃 / 重复 id 保留先到 / 全非法回退内置', async () => {
    ws.modules.install(aiModuleManifest(), { actor: `module:${AI_MODULE_ID}@local` });
    const write = async (value: unknown) => {
      const r = (await ws.tools.invoke(
        'profile.propose',
        { patch: [{ op: 'replace', path: `/modules/${AI_MODULE_ID}/settings/agents`, value }] },
        'user:test',
      )) as { proposalId: string };
      ws.profile.confirm(r.proposalId, 'user:test');
    };

    // 非法项丢弃（缺 name / tools 非数组 / 非 object），合法项保留
    await write([
      { id: 'ok', name: '合格', description: '', systemPrompt: 'A', tools: [] },
      { id: 'no-name', systemPrompt: 'B', tools: [] },
      { id: 'no-tools', name: 'C', systemPrompt: 'D', tools: 'wms.sku.create' },
      'not-an-object',
    ]);
    expect(readAgentDefs(ws).map((d) => d.id)).toEqual(['ok']);

    // 重复 id：先到者胜
    await write([
      { id: 'dup', name: '第一个', description: '', systemPrompt: 'A', tools: [] },
      { id: 'dup', name: '第二个', description: '', systemPrompt: 'B', tools: [] },
    ]);
    const defs = readAgentDefs(ws);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('第一个');

    // 清空 / 全非法 → 回退内置（「未配置 = 缺省」的延伸）
    await write([]);
    expect(readAgentDefs(ws).map((d) => d.id)).toEqual(['general', 'readonly', 'config']);
    await write([{ bad: true }, 42]);
    expect(readAgentDefs(ws).map((d) => d.id)).toEqual(['general', 'readonly', 'config']);
  });

  it('三件套的旧清单是策略子集时，按当前总线补齐，并换上现在的说明', async () => {
    ws.modules.install(aiModuleManifest(), { actor: `module:${AI_MODULE_ID}@local` });
    const builtins = builtinAgentDefs(ws.tools.list());
    const drop = new Set(['wms.wave.query', 'wms.report.catalog', 'wms.transfer.query', 'wms.numbering.preview']);
    const stale = builtins.map((def) => ({
      id: def.id,
      name: def.name,
      description:
        def.id === 'general'
          ? '查询与出入库操作（默认）'
          : def.id === 'readonly'
            ? '仅查询，不修改任何数据'
            : '查询 + 起草配置变更提议（由用户确认生效）',
      systemPrompt:
        def.id === 'general'
          ? '你是通用仓库助手：可以查询库存、管理 SKU 与单据、执行出入库操作。'
          : def.id === 'readonly'
            ? '你是只读查询助手：只回答关于库存、单据、配置现状的问题，不修改任何数据。'
            : '你是配置助手：帮助用户查看现状并起草配置变更提议。提议必须由用户亲自确认后才生效。',
      tools: def.tools.filter((id) => !drop.has(id)),
    }));
    const proposed = (await ws.tools.invoke(
      'profile.propose',
      { patch: [{ op: 'replace', path: `/modules/${AI_MODULE_ID}/settings/agents`, value: stale }] },
      'user:test',
    )) as { proposalId: string };
    ws.profile.confirm(proposed.proposalId, 'user:test');

    const defs = readAgentDefs(ws);
    expect(defs.map((def) => def.tools)).toEqual(builtins.map((def) => def.tools));
    expect(defs.map((def) => def.description)).toEqual(builtins.map((def) => def.description));
    expect(defs.map((def) => def.systemPrompt)).toEqual(builtins.map((def) => def.systemPrompt));
    expect(defs.every((def) => def.toolGrant === 'default')).toBe(true);
    for (const id of drop) {
      if (!ws.tools.list().some((tool) => tool.id === id)) continue;
      const owner = builtins.find((def) => def.tools.includes(id));
      expect(owner).toBeTruthy();
      expect(defs.find((def) => def.id === owner!.id)!.tools).toContain(id);
    }
  });

  it('改过授权的三件套保持保存的清单，不把后加的工具补回来', async () => {
    ws.modules.install(aiModuleManifest(), { actor: `module:${AI_MODULE_ID}@local` });
    const builtins = builtinAgentDefs(ws.tools.list());
    const general = builtins.find((def) => def.id === 'general')!;
    const readonly = builtins.find((def) => def.id === 'readonly')!;
    const config = builtins.find((def) => def.id === 'config')!;
    const saved = [
      { ...general, tools: ['wms.inventory.query'], toolGrant: 'custom' as const },
      { ...readonly, tools: ['gone.tool', 'wms.inventory.query'], toolGrant: undefined },
      { ...config, tools: [] as string[], toolGrant: undefined },
    ];
    const proposed = (await ws.tools.invoke(
      'profile.propose',
      { patch: [{ op: 'replace', path: `/modules/${AI_MODULE_ID}/settings/agents`, value: saved }] },
      'user:test',
    )) as { proposalId: string };
    ws.profile.confirm(proposed.proposalId, 'user:test');

    const defs = readAgentDefs(ws);
    expect(defs.find((def) => def.id === 'general')!.tools).toEqual(['wms.inventory.query']);
    expect(defs.find((def) => def.id === 'general')!.toolGrant).toBe('custom');
    expect(defs.find((def) => def.id === 'readonly')!.tools).toEqual(['gone.tool', 'wms.inventory.query']);
    expect(defs.find((def) => def.id === 'readonly')!.toolGrant).toBe('custom');
    expect(defs.find((def) => def.id === 'config')!.tools).toEqual([]);
    expect(defs.find((def) => def.id === 'config')!.toolGrant).toBe('custom');
  });
});
