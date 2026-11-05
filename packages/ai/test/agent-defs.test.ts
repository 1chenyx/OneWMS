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
});
