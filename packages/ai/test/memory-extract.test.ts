import { describe, it, expect } from 'vitest';
import {
  extractMemoryPlan,
  parseMemoryPlan,
  EMPTY_MEMORY_PLAN,
  MAX_SAVES_PER_EXTRACTION,
} from '../src/memory-extract.js';
import type { AgentMemoryRef, LlmProvider, LlmTurnRequest, LlmTurnResponse } from '../src/index.js';

/**
 * 记忆提取（自动记忆的纯逻辑核心）：
 *  - 模型输出不可信：围栏剥离 / JSON 窄化 / 幻觉 id 丢弃 / 超限截断 / 非法整体丢弃；
 *  - 空 user / 空 assistant 不发起调用（纯工具轮、中断轮无记忆价值）；
 *  - 提取 prompt 携带完整现有清单（去重与 forget 判据）。
 */

function scriptedProvider(
  turns: LlmTurnResponse[],
): { provider: LlmProvider; requests: LlmTurnRequest[] } {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async completeTurn(req) {
      requests.push(req);
      return turns[i++] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests };
}

const MEMORIES: AgentMemoryRef[] = [
  { id: 'm1', scope: 'personal', content: '用户习惯周日盘点' },
  { id: 'm2', scope: 'project', content: 'A001 是易碎品' },
];

describe('extractMemoryPlan', () => {
  it('合法输出：save + forget 均解析；请求含现有清单与对话', async () => {
    const { provider, requests } = scriptedProvider([
      {
        text: '{"save":[{"scope":"project","content":"B002 需防潮存储"}],"forget":[{"memoryId":"m1"}]}',
        toolCalls: [],
      },
    ]);
    const plan = await extractMemoryPlan(provider, {
      userText: '记住 B002 要防潮，另外我改成周六盘点了',
      assistantText: '好的，已记录。',
      memories: MEMORIES,
    });
    expect(plan).toEqual({
      save: [{ scope: 'project', content: 'B002 需防潮存储' }],
      forget: [{ memoryId: 'm1' }],
    });
    // 请求内容：现有清单全量 + 本轮对话文本；无工具
    const req = requests[0];
    expect(req.tools).toEqual([]);
    expect(req.messages[0]).toMatchObject({ role: 'user' });
    const text = (req.messages[0] as { text: string }).text;
    expect(text).toContain('m1 [personal] 用户习惯周日盘点');
    expect(text).toContain('m2 [project] A001 是易碎品');
    expect(text).toContain('用户：记住 B002 要防潮');
    expect(req.system).toContain('记忆提取器');
  });

  it('空 user / 空 assistant：不发起 LLM 调用，返回 undefined', async () => {
    const { provider, requests } = scriptedProvider([]);
    expect(
      await extractMemoryPlan(provider, { userText: '  ', assistantText: 'ok', memories: [] }),
    ).toBeUndefined();
    expect(
      await extractMemoryPlan(provider, { userText: 'hi', assistantText: '', memories: [] }),
    ).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('```json 围栏剥离（本地小模型习惯）', async () => {
    const { provider } = scriptedProvider([
      { text: '```json\n{"save":[{"scope":"personal","content":"称呼用户为老板"}],"forget":[]}\n```', toolCalls: [] },
    ]);
    const plan = await extractMemoryPlan(provider, {
      userText: '以后叫我老板',
      assistantText: '好的老板！',
      memories: [],
    });
    expect(plan?.save).toEqual([{ scope: 'personal', content: '称呼用户为老板' }]);
  });

  it('空计划：save/forget 均空返回 EMPTY_MEMORY_PLAN', async () => {
    const { provider } = scriptedProvider([{ text: '{"save":[],"forget":[]}', toolCalls: [] }]);
    const plan = await extractMemoryPlan(provider, {
      userText: '今天天气不错',
      assistantText: '是呀。',
      memories: MEMORIES,
    });
    expect(plan).toBe(EMPTY_MEMORY_PLAN);
  });
});

describe('parseMemoryPlan 窄化护栏', () => {
  it('非 JSON / 非对象 → undefined（整体丢弃）', () => {
    expect(parseMemoryPlan('抱歉我不明白', MEMORIES)).toBeUndefined();
    expect(parseMemoryPlan('["array"]', MEMORIES)).toBeUndefined();
    expect(parseMemoryPlan('null', MEMORIES)).toBeUndefined();
  });

  it('forget 的幻觉 id 静默丢弃；合法 id 保留', () => {
    const plan = parseMemoryPlan(
      '{"save":[],"forget":[{"memoryId":"m2"},{"memoryId":"ghost-id"}]}',
      MEMORIES,
    );
    expect(plan?.forget).toEqual([{ memoryId: 'm2' }]);
  });

  it('save：非法 scope / 空内容剔除；单轮超上限截断到 MAX_SAVES_PER_EXTRACTION', () => {
    const many = Array.from({ length: MAX_SAVES_PER_EXTRACTION + 3 }, (_, i) => ({
      scope: 'project',
      content: `fact-${i}`,
    }));
    const mixed = [{ scope: 'global', content: 'x' }, { scope: 'personal', content: '   ' }, ...many];
    const plan = parseMemoryPlan(JSON.stringify({ save: mixed, forget: [] }), MEMORIES);
    expect(plan?.save).toHaveLength(MAX_SAVES_PER_EXTRACTION);
    expect(plan?.save[0]).toEqual({ scope: 'project', content: 'fact-0' });
  });

  it('save 与 forget 都为空 → EMPTY_MEMORY_PLAN', () => {
    expect(parseMemoryPlan('{"save":"nope","forget":7}', MEMORIES)).toBe(EMPTY_MEMORY_PLAN);
  });
});
