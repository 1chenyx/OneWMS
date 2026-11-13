import { describe, it, expect, afterEach } from 'vitest';
import type { LlmProvider, LlmTurnRequest, LlmTurnResponse } from '@one/ai';
import {
  createApp,
  createAppContext,
  runMemoryConsolidation,
  runMemoryExtraction,
  type AppContext,
} from '../src/index.js';

/**
 * 记忆功能直测（章节级 markdown 账本；app.request 不起端口、mock provider 不碰真实 LLM）：
 *  - 工具层三件套：append（新建/追加，摘要与关键词沿用）、rewrite（覆盖 / 令牌不符拒 /
 *    正文留空删除）、read（目录 vs 全文）——写只经工具总线，投影是缓存；
 *  - v1 兼容：老条目事件重放进 legacy-* 收容章节，遗忘摘行，replay 幂等；
 *  - 自动提取：runMemoryExtraction 只追加、actor=ai:memory-auto（source='auto'），
 *    autoMemory 关闭零 LLM 调用，单条被护栏拒不拖垮整轮；
 *  - 归并：runMemoryConsolidation 执行计划，created/rewritten/removed/failed 四类统计；
 *  - 路由契约：GET 直查投影（含 T0 常驻段预览）、POST 经工具、history 扫事件账本、
 *    consolidate 同步整理、settings 走慢通道（maxSections 键名）；
 *  - chat 三层注入：T0 常驻段与 T2 关键词预取都进 System Prompt。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body), headers: json });

function setup(provider?: LlmProvider): ReturnType<typeof createApp> {
  ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-memory-test',
    provider,
    aiConfig: provider ? { baseUrl: 'http://127.0.0.1:11434', model: 'test-model' } : undefined,
  });
  return createApp(ctx);
}

/** 人操作界面的 actor（路由与测试共用同一形状） */
const humanActor = () => `user:local@${ctx!.core.nodeId}`;

interface SectionOut {
  id: string;
  scope: 'personal' | 'project';
  sectionKey: string;
  title: string;
  bodyMd: string;
  summary: string;
  keywords: string[];
  baseLamport: number;
  lastActor: string;
  lines: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryListResponse {
  sections: SectionOut[];
  settings: { autoMemory: boolean; maxSections: number };
  resident: { text: string; overflow: boolean };
}

async function listSections(app: ReturnType<typeof createApp>): Promise<MemoryListResponse> {
  const res = await app.request('/api/memory');
  expect(res.status).toBe(200);
  return (await res.json()) as MemoryListResponse;
}

/** 经工具总线落一节（测试夹具也守纪律：绝不直写投影） */
async function appendSection(
  scope: 'personal' | 'project',
  sectionKey: string,
  title: string,
  text: string,
): Promise<void> {
  await ctx!.ws.tools.invoke('memory.append', { scope, sectionKey, title, text }, humanActor());
}

/**
 * 剧本 provider：按 system 首句分流（聊天 / 记忆提取器 / 记忆文档编辑），
 * 未配置的通道返回空计划——测试只关心自己那条通道有没有被调用。
 */
function scriptedProvider(script: {
  chat?: LlmTurnResponse[];
  extract?: () => LlmTurnResponse;
  consolidate?: () => LlmTurnResponse;
}): { provider: LlmProvider; requests: LlmTurnRequest[] } {
  const requests: LlmTurnRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async completeTurn(req) {
      requests.push(req);
      if (req.system.includes('记忆提取器')) {
        return script.extract?.() ?? { text: '{"append":[]}', toolCalls: [] };
      }
      if (req.system.includes('记忆文档的编辑')) {
        return script.consolidate?.() ?? { text: '{"sections":[]}', toolCalls: [] };
      }
      return script.chat?.[i++] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests };
}

describe('memory.append / memory.rewrite / memory.read（工具层契约）', () => {
  it('append 新建章节 → 再追加：正文按行累积，summary 与 keywords 沿用首次写入', async () => {
    setup();
    const created = (await ctx!.ws.tools.invoke(
      'memory.append',
      { scope: 'project', sectionKey: 'sku-characteristics', title: '商品特性', text: 'A001 是易碎品' },
      humanActor(),
    )) as SectionOut;
    expect(created.title).toBe('商品特性');
    expect(created.bodyMd).toBe('- A001 是易碎品'); // 散句自动补列表前缀
    expect(created.summary).toBe('A001 是易碎品');
    expect(created.keywords).toEqual([]);
    expect(created.baseLamport).toBeGreaterThan(0);

    const appended = (await ctx!.ws.tools.invoke(
      'memory.append',
      { scope: 'project', sectionKey: 'sku-characteristics', text: '保质期 12 个月' },
      humanActor(),
    )) as SectionOut;
    expect(appended.bodyMd).toBe('- A001 是易碎品\n- 保质期 12 个月');
    expect(appended.summary).toBe('A001 是易碎品'); // 追加不动摘要（重算摘要是 rewrite 的活）
    expect(appended.baseLamport).toBeGreaterThan(created.baseLamport);
    expect(ctx!.memory.sections.count()).toBe(1); // 同键再写 = 同一节
  });

  it('rewrite 整节覆盖（含摘要与关键词）；令牌不符被拒；正文留空 = 删除', async () => {
    setup();
    await appendSection('project', 'sku-characteristics', '商品特性', 'A001 是易碎品');
    const before = ctx!.memory.sections.byKey('project', 'sku-characteristics')!;

    const rewritten = (await ctx!.ws.tools.invoke(
      'memory.rewrite',
      {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: '商品特性（归并后）',
        bodyMd: '- A001 易碎且有保质期',
        summary: '合并后的商品特性',
        keywords: ['SKU', '易碎'],
        baseLamport: before.baseLamport,
      },
      humanActor(),
    )) as SectionOut;
    expect(rewritten.title).toBe('商品特性（归并后）');
    expect(rewritten.summary).toBe('合并后的商品特性');
    expect(rewritten.keywords).toEqual(['SKU', '易碎']);

    // 令牌是「最后一次写入本章节的事件 lamport」：拿旧令牌改写必须被拒（并发保护）
    await expect(
      ctx!.ws.tools.invoke(
        'memory.rewrite',
        {
          scope: 'project',
          sectionKey: 'sku-characteristics',
          title: 'x',
          bodyMd: '- y',
          baseLamport: before.baseLamport,
        },
        humanActor(),
      ),
    ).rejects.toThrow(/TOOL_REJECTED/);

    const removed = (await ctx!.ws.tools.invoke(
      'memory.rewrite',
      {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: rewritten.title,
        bodyMd: '',
        baseLamport: rewritten.baseLamport,
      },
      humanActor(),
    )) as { removed: boolean; scope: string; sectionKey: string };
    expect(removed).toEqual({ removed: true, scope: 'project', sectionKey: 'sku-characteristics' });
    expect(ctx!.memory.sections.byKey('project', 'sku-characteristics')).toBeUndefined();
  });

  it('read：不带 sectionKey 返回目录（无正文），带 sectionKey 返回全文', async () => {
    setup();
    await appendSection('personal', 'user-preferences', '用户偏好', '习惯周日盘点');
    await appendSection('project', 'sku-characteristics', '商品特性', 'A001 是易碎品');

    const directory = (await ctx!.ws.tools.invoke('memory.read', {}, humanActor())) as {
      sections: { sectionKey: string; bodyMd?: string }[];
      hint: string;
    };
    expect(directory.sections.map((s) => s.sectionKey)).toEqual([
      'user-preferences',
      'sku-characteristics',
    ]); // 稳定序：personal 先
    expect(directory.sections.every((s) => s.bodyMd === undefined)).toBe(true);

    const full = (await ctx!.ws.tools.invoke(
      'memory.read',
      { sectionKey: 'sku-characteristics' },
      humanActor(),
    )) as SectionOut;
    expect(full.bodyMd).toBe('- A001 是易碎品');
    expect(full.scope).toBe('project'); // scope 省略 = 两层里找
  });
});

describe('v1 条目事件兼容（投影侧收容，事件不可改写）', () => {
  it('item.saved 进 legacy-* 章节（行内含 memoryId）；item.forgotten 摘掉该行；replay 幂等', async () => {
    setup();
    const actor = humanActor();
    ctx!.ws.events.append(
      'memory.item.saved',
      { memoryId: 'm-1', scope: 'personal', content: '用户习惯周日盘点', source: 'manual' },
      actor,
    );
    ctx!.ws.events.append(
      'memory.item.saved',
      { memoryId: 'm-2', scope: 'personal', content: '喜欢简短回复', source: 'auto' },
      actor,
    );
    ctx!.memory.sync();

    const legacy = ctx!.memory.sections.byKey('personal', 'legacy-personal');
    expect(legacy?.title).toBe('历史条目（未归并）');
    expect(legacy?.bodyMd).toContain('[m-1] 用户习惯周日盘点');
    expect(legacy?.bodyMd).toContain('[m-2] 喜欢简短回复');
    expect(legacy?.keywords).toEqual(['历史条目', '待归并']);

    ctx!.ws.events.append('memory.item.forgotten', { memoryId: 'm-1' }, actor);
    ctx!.memory.sync();
    const afterForget = ctx!.memory.sections.byKey('personal', 'legacy-personal')!;
    expect(afterForget.bodyMd).not.toContain('[m-1]');
    expect(afterForget.bodyMd).toContain('[m-2]');

    // 事件是唯一真相：清投影全量重放，结果必须与增量追账一致（幂等自检）
    ctx!.memory.replay();
    const replayed = ctx!.memory.sections.byKey('personal', 'legacy-personal')!;
    expect(replayed.bodyMd).toBe(afterForget.bodyMd);
    expect(replayed.title).toBe(afterForget.title);
    expect(ctx!.memory.sections.count()).toBe(1);
  });
});

describe('runMemoryExtraction（自动提取只做追加）', () => {
  it('提取计划逐条经 memory.append 落账，actor=ai:memory-auto（审计可辨）', async () => {
    const { provider, requests } = scriptedProvider({
      extract: () => ({
        text: JSON.stringify({
          append: [
            { scope: 'project', sectionKey: 'sku-characteristics', title: '商品特性', text: 'A001 是易碎品' },
            { scope: 'personal', sectionKey: 'user-preferences', title: '用户偏好', text: '喜欢简短回复' },
          ],
        }),
        toolCalls: [],
      }),
    });
    setup(provider);

    const stats = await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: 'A001 要轻拿轻放，另外回复简短点' },
      { role: 'assistant', text: '好的，已记下。' },
    ]);
    expect(stats).toEqual({ appended: 2, failed: 0, rejections: [] });
    expect(requests).toHaveLength(1); // 只一次 LLM 调用（落账走工具，不再问模型）
    expect(ctx!.memory.sections.byKey('project', 'sku-characteristics')?.lastActor).toBe(
      `ai:memory-auto@${ctx!.core.nodeId}`,
    );

    let updated = 0;
    ctx!.ws.events.forEach((env) => {
      if (env.type === 'memory.section.updated') {
        updated++;
        expect(env.actor).toBe(`ai:memory-auto@${ctx!.core.nodeId}`);
      }
    });
    expect(updated).toBe(2);
  });

  it('autoMemory 关闭 → 零 LLM 调用、零落账', async () => {
    const { provider, requests } = scriptedProvider({
      extract: () => ({
        text: JSON.stringify({ append: [{ scope: 'personal', sectionKey: 'x-y', title: 'x', text: 'y' }] }),
        toolCalls: [],
      }),
    });
    const app = setup(provider);
    const propose = await post(app, '/api/memory/settings/propose', { autoMemory: false });
    const { proposalId } = (await propose.json()) as { proposalId: string };
    await post(app, `/api/proposals/${proposalId}/confirm`, {});

    const stats = await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: '记住我喜欢蓝色' },
      { role: 'assistant', text: '好的' },
    ]);
    expect(stats).toEqual({ appended: 0, failed: 0, rejections: [] });
    expect(requests).toHaveLength(0);
    expect(ctx!.memory.sections.count()).toBe(0);
  });

  it('空 assistant 轮（纯工具轮）直接跳过，不发起调用', async () => {
    const { provider, requests } = scriptedProvider({});
    setup(provider);
    const stats = await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: '查库存' },
      { role: 'tool-calls', calls: [] },
      { role: 'tool-results', results: [] },
    ]);
    expect(stats.appended).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('单条被护栏拒 → 计入 failed/rejections，其余条目照常落账', async () => {
    const { provider } = scriptedProvider({
      extract: () => ({
        text: JSON.stringify({
          append: [
            { scope: 'project', sectionKey: 'sku-characteristics', text: '追加一条要点' },
            { scope: 'project', sectionKey: 'supplier-agreements', title: '供应商约定', text: '月结 30 天' },
          ],
        }),
        toolCalls: [],
      }),
    });
    const app = setup(provider);
    // 章节上限压到 1：既有章节的追加放行，新建章节被工具护栏拒
    const propose = await post(app, '/api/memory/settings/propose', { maxSections: 1 });
    const { proposalId } = (await propose.json()) as { proposalId: string };
    await post(app, `/api/proposals/${proposalId}/confirm`, {});
    await appendSection('project', 'sku-characteristics', '商品特性', 'A001 是易碎品');

    const stats = await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: '还有供应商月结 30 天' },
      { role: 'assistant', text: '好的' },
    ]);
    expect(stats.appended).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.rejections[0]).toContain('supplier-agreements');
    expect(stats.rejections[0]).toContain('TOOL_REJECTED');
    expect(ctx!.memory.sections.byKey('project', 'supplier-agreements')).toBeUndefined();
  });

  it('项目目录超预算时归并 project，不归并还没超的 personal', async () => {
    const { provider, requests } = scriptedProvider({
      extract: () => ({
        text: JSON.stringify({
          append: [{ scope: 'project', sectionKey: 'proj-00', text: '再记一条' }],
        }),
        toolCalls: [],
      }),
      consolidate: () => ({ text: '{"sections":[]}', toolCalls: [] }),
    });
    setup(provider);
    const text = '约'.repeat(120);
    for (let i = 0; i < 12; i++) {
      await appendSection('project', `proj-${String(i).padStart(2, '0')}`, `约定${i}`, text);
    }
    const before = ctx!.memory.sections.resident();
    expect(before.personalOverflow).toBe(false);
    expect(before.projectOverflow).toBe(true);

    await runMemoryExtraction(ctx!, provider, [
      { role: 'user', text: '再记一条关于这批约定的事' },
      { role: 'assistant', text: '好的，记下了。' },
    ]);

    const consolidateReqs = requests.filter((req) => req.system.includes('记忆文档的编辑'));
    expect(consolidateReqs).toHaveLength(1);
    const prompt = consolidateReqs[0].messages[0].role === 'user' ? consolidateReqs[0].messages[0].text : '';
    expect(prompt).toContain('scope=project');
    expect(prompt).not.toContain('scope=personal');
  });
});

describe('runMemoryConsolidation（执行归并计划）', () => {
  it('覆盖 / 删除 / 新建三类统计；超长字段在解析层裁掉，不会白废一节', async () => {
    const { provider } = scriptedProvider({
      consolidate: () => ({
        text: JSON.stringify({
          sections: [
            {
              scope: 'project',
              sectionKey: 'sku-characteristics',
              title: '商品特性',
              bodyMd: '- A001 易碎且有保质期',
              summary: '合并后的商品特性',
              keywords: ['SKU', '易碎'],
            },
            { scope: 'project', sectionKey: 'old-notes', title: '旧笔记', bodyMd: '', summary: '', keywords: [] },
            {
              scope: 'project',
              sectionKey: 'supplier-agreements',
              title: '供应商约定',
              bodyMd: '- 供应商 A 月结 30 天',
              summary: '供应商结算约定',
              keywords: ['供应商'],
            },
            {
              scope: 'project',
              sectionKey: 'bad-keywords',
              title: '坏关键词',
              bodyMd: '- 内容',
              summary: '',
              keywords: ['一二三四五六七八九十一二三四五六七八九十'], // 超关键词长度上限 → 解析层截到 16 字
            },
          ],
        }),
        toolCalls: [],
      }),
    });
    setup(provider);
    await appendSection('project', 'sku-characteristics', '商品特性', 'A001 是易碎品');
    await appendSection('project', 'old-notes', '旧笔记', '过时的临时约定');

    const [stats] = await runMemoryConsolidation(ctx!, provider, {
      scope: 'project',
      actor: humanActor(),
    });
    expect(stats.scope).toBe('project');
    expect(stats.rewritten).toBe(1); // sku-characteristics 覆盖
    expect(stats.removed).toBe(1); // old-notes 正文留空 = 删除
    expect(stats.created).toBe(2); // supplier-agreements + bad-keywords 都是新建
    // 解析层（parseConsolidationPlan）已把关键词截到 16 字，工具不再整条 TOOL_REJECTED——
    // 一个越界字段废掉整节整理结果，是「整理」最难受的失败形态。
    // 真正还会走到 failed 分支的只剩乐观并发冲突（整理途中有人改了同一节），
    // 令牌校验本身由 @one/memory 的 memory.rewrite 用例覆盖。
    expect(stats.failed).toHaveLength(0);

    expect(ctx!.memory.sections.byKey('project', 'sku-characteristics')?.bodyMd).toBe(
      '- A001 易碎且有保质期',
    );
    expect(ctx!.memory.sections.byKey('project', 'old-notes')).toBeUndefined();
    expect(ctx!.memory.sections.byKey('project', 'supplier-agreements')?.keywords).toEqual(['供应商']);
    expect(ctx!.memory.sections.byKey('project', 'bad-keywords')?.keywords).toEqual([
      '一二三四五六七八九十一二三四五六', // 20 字截到 MAX_KEYWORD_LENGTH=16
    ]);
  });

  it('scope 未指定 → personal 与 project 都整理；空 scope 不烧 token', async () => {
    let consolidateCalls = 0;
    const { provider } = scriptedProvider({
      consolidate: () => {
        consolidateCalls++;
        return { text: '{"sections":[]}', toolCalls: [] };
      },
    });
    setup(provider);
    await appendSection('personal', 'user-preferences', '用户偏好', '习惯周日盘点');

    const stats = await runMemoryConsolidation(ctx!, provider, { actor: humanActor() });
    expect(stats.map((s) => s.scope)).toEqual(['personal']); // project 无章节 → 跳过
    expect(consolidateCalls).toBe(1);
  });

  it('超过 16 节时，下一次整理从上次停下的位置继续', async () => {
    const { provider, requests } = scriptedProvider({
      consolidate: () => ({ text: '{"sections":[]}', toolCalls: [] }),
    });
    setup(provider);
    const keys = Array.from({ length: 17 }, (_, i) => `sec-${String(i).padStart(2, '0')}`);
    for (const key of keys) {
      await appendSection('project', key, key, `正文 ${key}`);
    }

    const first = await runMemoryConsolidation(ctx!, provider, { scope: 'project', actor: humanActor() });
    const second = await runMemoryConsolidation(ctx!, provider, { scope: 'project', actor: humanActor() });
    expect(first[0].deferred).toBe(1);
    expect(second[0].deferred).toBe(1);

    const keysIn = (index: number) => {
      const message = requests[index].messages[0];
      const text = message.role === 'user' ? message.text : '';
      return keys.filter((key) => text.includes(`sectionKey=${key}`));
    };
    const firstKeys = keysIn(0);
    const secondKeys = keysIn(1);
    expect(firstKeys).toHaveLength(16);
    expect(secondKeys).toHaveLength(16);
    const missed = keys.filter((key) => !firstKeys.includes(key));
    expect(missed).toHaveLength(1);
    expect(secondKeys).toContain(missed[0]);
    expect(keys.filter((key) => !secondKeys.includes(key))).not.toEqual(missed);
  });
});

describe('GET/POST /api/memory（路由契约）', () => {
  it('空库：章节空 + 默认设置（autoMemory=true, maxSections=24）+ 空常驻段', async () => {
    const app = setup();
    const data = await listSections(app);
    expect(data.sections).toEqual([]);
    expect(data.settings).toEqual({ autoMemory: true, maxSections: 24 });
    expect(data.resident).toEqual({
      text: '',
      overflow: false,
      personalOverflow: false,
      projectOverflow: false,
    });
  });

  it('POST 追加 → 清单可见（含 lines/baseLamport）→ scope 过滤 → resident 恒为全量', async () => {
    const app = setup();
    const res = await post(app, '/api/memory', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性',
      text: 'A001 是易碎品',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as SectionOut;
    expect(created.lastActor).toBe(humanActor()); // 人操作 → source='manual'
    expect(created.lines).toBe(1);

    await post(app, '/api/memory', {
      scope: 'personal',
      sectionKey: 'user-preferences',
      title: '用户偏好',
      text: '习惯周日盘点',
    });

    const all = await listSections(app);
    expect(all.sections.map((s) => s.sectionKey)).toEqual(['user-preferences', 'sku-characteristics']);
    // 常驻段忽略 scope 过滤：管理页预览的是「AI 实际常驻看到什么」
    expect(all.resident.text).toContain('## 关于用户');
    expect(all.resident.text).toContain('## 业务约定');
    expect(all.resident.overflow).toBe(false);

    const onlyProject = (await (await app.request('/api/memory?scope=project')).json()) as MemoryListResponse;
    expect(onlyProject.sections.map((s) => s.sectionKey)).toEqual(['sku-characteristics']);
    expect(onlyProject.resident.text).toContain('## 关于用户');
  });

  it('POST /rewrite 覆盖、POST /remove 删除（不存在 → 400 NOT_FOUND）', async () => {
    const app = setup();
    await post(app, '/api/memory', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性',
      text: 'A001 是易碎品',
    });
    const before = (await listSections(app)).sections[0];

    const rewrite = await post(app, '/api/memory/rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性（归并后）',
      bodyMd: '- A001 易碎',
      summary: '归并后',
      keywords: ['SKU'],
      baseLamport: before.baseLamport,
    });
    expect(rewrite.status).toBe(200);
    expect(((await rewrite.json()) as SectionOut).keywords).toEqual(['SKU']);

    // 令牌过期（拿 before 的旧值）→ 工具拒 → apiErrorHandler 转 400 + code
    const stale = await post(app, '/api/memory/rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'x',
      bodyMd: '- y',
      baseLamport: before.baseLamport,
    });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { code: string }).code).toBe('TOOL_REJECTED');

    const missing = await post(app, '/api/memory/remove', {
      scope: 'project',
      sectionKey: 'not-exist',
      baseLamport: 0,
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('NOT_FOUND');

    const current = (await listSections(app)).sections[0];
    const remove = await post(app, '/api/memory/remove', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      baseLamport: current.baseLamport,
    });
    expect(remove.status).toBe(200);
    expect(await ((await remove.json()) as { removed: boolean }).removed).toBe(true);
    expect((await listSections(app)).sections).toEqual([]);
  });

  it('GET /history：倒序返回该节全部版本（最多 50 条）；参数缺失 → 400', async () => {
    const app = setup();
    await post(app, '/api/memory', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性',
      text: 'A001 是易碎品',
    });
    await post(app, '/api/memory', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      text: '保质期 12 个月',
    });

    const res = await app.request('/api/memory/history?scope=project&sectionKey=sku-characteristics');
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: { lamport: number; actor: string; title: string; bodyMd: string; keywords: string[] }[];
    };
    expect(entries).toHaveLength(2);
    expect(entries[0].lamport).toBeGreaterThan(entries[1].lamport); // 最新在前
    expect(entries[0].bodyMd).toContain('保质期 12 个月');
    expect(entries[1].bodyMd).toBe('- A001 是易碎品');
    expect(entries.every((e) => e.actor === humanActor())).toBe(true);

    expect((await app.request('/api/memory/history?scope=project')).status).toBe(400);
    expect((await app.request('/api/memory/history?sectionKey=sku-characteristics')).status).toBe(400);
    expect((await app.request('/api/memory/history?scope=Bad&sectionKey=sku-characteristics')).status).toBe(400);
  });

  it('POST /consolidate：无 provider → 400 AI_NOT_CONFIGURED；有 provider → 同步返回统计', async () => {
    const off = setup();
    const noAi = await post(off, '/api/memory/consolidate', {});
    expect(noAi.status).toBe(400);
    expect(((await noAi.json()) as { code: string }).code).toBe('AI_NOT_CONFIGURED');

    const { provider } = scriptedProvider({
      consolidate: () => ({
        text: JSON.stringify({
          sections: [
            {
              scope: 'personal',
              sectionKey: 'user-preferences',
              title: '用户偏好',
              bodyMd: '- 习惯周日盘点，喜欢简短回复',
              summary: '合并后的用户偏好',
              keywords: ['偏好'],
            },
          ],
        }),
        toolCalls: [],
      }),
    });
    const app = setup(provider);
    await post(app, '/api/memory', {
      scope: 'personal',
      sectionKey: 'user-preferences',
      title: '用户偏好',
      text: '习惯周日盘点',
    });

    const res = await post(app, '/api/memory/consolidate', { scope: 'personal' });
    expect(res.status).toBe(200);
    const { scopes } = (await res.json()) as {
      scopes: { scope: string; rewritten: number; created: number; removed: number; failed: unknown[] }[];
    };
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ scope: 'personal', rewritten: 1, created: 0, removed: 0 });
    expect((await listSections(app)).sections[0].summary).toBe('合并后的用户偏好');

    const bad = await post(app, '/api/memory/consolidate', { scope: 'nope' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/memory/settings/propose（慢通道）', () => {
  it('非法值 400；只 patch 显式给出的键；confirm 后 GET 才反映新值', async () => {
    const app = setup();
    expect((await post(app, '/api/memory/settings/propose', { maxSections: 0 })).status).toBe(400);
    expect((await post(app, '/api/memory/settings/propose', { autoMemory: 'no' })).status).toBe(400);
    expect((await post(app, '/api/memory/settings/propose', {})).status).toBe(400);

    const propose = await post(app, '/api/memory/settings/propose', { maxSections: 8 });
    expect(propose.status).toBe(201);
    const { proposalId } = (await propose.json()) as { proposalId: string };

    // 提议未确认前生效面不变（确认权在人类）
    expect((await listSections(app)).settings).toEqual({ autoMemory: true, maxSections: 24 });

    expect((await post(app, `/api/proposals/${proposalId}/confirm`, {})).status).toBe(200);
    expect((await listSections(app)).settings).toEqual({ autoMemory: true, maxSections: 8 });
  });
});

describe('chat 三层注入（T0 常驻 + T2 预取）', () => {
  it('System Prompt 含常驻段；本轮消息命中关键词 → 附带该节全文', async () => {
    const { provider, requests } = scriptedProvider({
      chat: [{ text: '好的，会注意易碎品。', toolCalls: [] }],
    });
    const app = setup(provider);
    await post(app, '/api/memory', {
      scope: 'personal',
      sectionKey: 'user-preferences',
      title: '用户偏好',
      text: '习惯周日盘点',
    });
    // 预取判据是关键词/标题子串：先 append 建节，再 rewrite 补上关键词
    //（append 新建的章节关键词为空，命不中）
    await post(app, '/api/memory', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性',
      text: 'A001 是易碎品，轻拿轻放',
    });
    const created = (await listSections(app)).sections.find((s) => s.sectionKey === 'sku-characteristics')!;
    await post(app, '/api/memory/rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性',
      bodyMd: created.bodyMd,
      summary: '易碎品的搬运要求',
      keywords: ['易碎品', 'A001'],
      baseLamport: created.baseLamport,
    });

    const chat = await post(app, '/api/chat/sessions/s-memory/message', {
      message: '这批易碎品怎么放',
    });
    expect(chat.status).toBe(200);
    await chat.text(); // 消费 SSE 流（streamSSE 惰性执行）

    const system = requests[0].system;
    expect(system).toContain('<memory-context>');
    expect(system).toContain('## 关于用户'); // T0：personal 全文
    expect(system).toContain('习惯周日盘点');
    expect(system).toContain('key=sku-characteristics'); // T0：project 只有目录行
    expect(system).toContain('## 本轮相关章节（关键词命中）'); // T2 预取
    expect(system).toContain('sectionKey=sku-characteristics');
    expect(system).toContain('A001 是易碎品，轻拿轻放');
  });
});
