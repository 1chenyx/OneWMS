import { describe, it, expect } from 'vitest';
import {
  EMPTY_CONSOLIDATION_PLAN,
  MAX_BODY_LENGTH,
  MAX_CONSOLIDATE_INPUT_SECTIONS,
  parseConsolidationPlan,
  planConsolidation,
  type LlmProvider,
  type LlmTurnRequest,
  type MemorySectionSnapshot,
} from '../src/index.js';
import { MAX_NEW_SECTIONS_PER_RUN } from '../src/memory-consolidate.js';
import { MAX_TITLE_LENGTH } from '../src/memory-extract.js';
import { MEMORY_CONSOLIDATE_SYSTEM } from '../src/prompts.js';

/**
 * 记忆归并（管理页「整理」）的纯逻辑：把一个 scope 下的章节快照交给模型，
 * 拿回「逐节完整覆盖」计划，由调用方逐条走 memory.rewrite 落账。
 *
 * 断言纪律（模型输出不可信）：
 *  - baseLamport 一律取输入快照值——模型回传的令牌若被采信，就会拿旧令牌去覆盖
 *    别人刚写的章节（乐观并发形同虚设），所以每条用例都要盯这个字段；
 *  - 只接受输入里存在的章节，新章节必须是 title+bodyMd 齐全且总数受限（防章节爆炸）；
 *  - 与输入无差异的条目不产出（无变化 = 无事件，账本不灌水）。
 */

/** 一节章节快照（归并的输入 = 全文 + 并发令牌） */
function snap(
  scope: 'personal' | 'project',
  sectionKey: string,
  over: Partial<MemorySectionSnapshot> = {},
): MemorySectionSnapshot {
  return {
    scope,
    sectionKey,
    title: over.title ?? sectionKey,
    summary: over.summary ?? '旧摘要',
    keywords: over.keywords ?? ['旧词'],
    bodyMd: over.bodyMd ?? '- 旧要点',
    baseLamport: over.baseLamport ?? 11,
  };
}

/** 脚本化 Provider：固定回一段文本，并记下入参供断言 */
function scriptedProvider(text: string): { provider: LlmProvider; calls: LlmTurnRequest[] } {
  const calls: LlmTurnRequest[] = [];
  return {
    calls,
    provider: {
      completeTurn: async (req) => {
        calls.push(req);
        return { text, toolCalls: [] };
      },
    },
  };
}

/** 把模型输出包成 {"sections":[...]} 的 JSON 文本 */
function modelOut(sections: unknown[]): string {
  return JSON.stringify({ sections });
}

describe('parseConsolidationPlan：整体形状', () => {
  const sections = [
    snap('project', 'sku-characteristics', {
      title: 'SKU 特性',
      bodyMd: '- A001 易碎\n- A001 易碎（重复行）',
      summary: '有重复的摘要',
      keywords: ['SKU', 'SKU'],
      baseLamport: 42,
    }),
  ];

  it('合法输出：逐字段落位，baseLamport 取快照值（模型回传的假令牌被忽略）', () => {
    const out = parseConsolidationPlan(
      modelOut([
        {
          scope: 'project',
          sectionKey: 'sku-characteristics',
          title: 'SKU 特性',
          bodyMd: '- A001 易碎',
          summary: '一条商品特性',
          keywords: ['SKU', '易碎'],
          baseLamport: 999, // 模型编的令牌：必须被丢弃
        },
      ]),
      sections,
    );
    expect(out).toEqual({
      rewrite: [
        {
          scope: 'project',
          sectionKey: 'sku-characteristics',
          title: 'SKU 特性',
          bodyMd: '- A001 易碎',
          summary: '一条商品特性',
          keywords: ['SKU', '易碎'],
          baseLamport: 42, // ← 快照里的真实令牌
        },
      ],
    });
  });

  it('```json 围栏 / 裸 JSON / 前后空白 都能解析', () => {
    const body = modelOut([
      { scope: 'project', sectionKey: 'sku-characteristics', title: 'T', bodyMd: '- 新', summary: 's', keywords: ['SKU 特性'] },
    ]);
    const expected = {
      rewrite: [
        {
          scope: 'project',
          sectionKey: 'sku-characteristics',
          title: 'T',
          bodyMd: '- 新',
          summary: 's',
          keywords: ['SKU 特性'],
          baseLamport: 42,
        },
      ],
    };
    expect(parseConsolidationPlan(`\`\`\`json\n${body}\n\`\`\``, sections)).toEqual(expected);
    expect(parseConsolidationPlan(`\`\`\`\n${body}\n\`\`\``, sections)).toEqual(expected);
    expect(parseConsolidationPlan(`  ${body}  `, sections)).toEqual(expected);
  });

  it('非 JSON / 数组 / 标量 / null / 缺 sections 键 / sections 非数组 → undefined', () => {
    expect(parseConsolidationPlan('整理完了', sections)).toBeUndefined();
    expect(parseConsolidationPlan('', sections)).toBeUndefined();
    expect(parseConsolidationPlan('[]', sections)).toBeUndefined();
    expect(parseConsolidationPlan('null', sections)).toBeUndefined();
    expect(parseConsolidationPlan('42', sections)).toBeUndefined();
    expect(parseConsolidationPlan('{"rewrite":[]}', sections)).toBeUndefined(); // 键名认错 → 整体拒绝
    expect(parseConsolidationPlan('{"sections":"不是数组"}', sections)).toBeUndefined();
    expect(parseConsolidationPlan('{}', sections)).toBeUndefined();
  });

  it('sections 为空数组 / 条目全不合法 → EMPTY_CONSOLIDATION_PLAN', () => {
    expect(parseConsolidationPlan('{"sections":[]}', sections)).toBe(EMPTY_CONSOLIDATION_PLAN);
    expect(parseConsolidationPlan('{"sections":[null,"x",42]}', sections)).toBe(EMPTY_CONSOLIDATION_PLAN);
    expect(EMPTY_CONSOLIDATION_PLAN).toEqual({ rewrite: [] });
  });
});

describe('parseConsolidationPlan：逐条校验', () => {
  it('与输入完全相同 → 丢弃（无变化不产生事件）；正文两端空白不算变化', () => {
    const sections = [
      snap('project', 'sec-a', { title: '甲', bodyMd: '- 一条', summary: '摘要', keywords: ['k1', 'k2'] }),
    ];
    const same = parseConsolidationPlan(
      modelOut([
        {
          scope: 'project',
          sectionKey: 'sec-a',
          title: '甲',
          bodyMd: '  - 一条  ', // trim 后与快照一致
          summary: '摘要',
          keywords: ['k1', 'k2'],
          baseLamport: 11,
        },
      ]),
      sections,
    );
    expect(same).toBe(EMPTY_CONSOLIDATION_PLAN);

    // title 省略时回退快照标题 → 仍然无变化（summary/keywords 必须原样回传，见后面的「可疑之处」）
    const titleOmitted = parseConsolidationPlan(
      modelOut([
        {
          scope: 'project',
          sectionKey: 'sec-a',
          bodyMd: '- 一条',
          summary: '摘要',
          keywords: ['k1', 'k2'],
        },
      ]),
      sections,
    );
    expect(titleOmitted).toBe(EMPTY_CONSOLIDATION_PLAN);

    // 关键词顺序变了 = 有变化（isNoOp 按下标逐项比对）→ 会产出一次覆盖
    const reordered = parseConsolidationPlan(
      modelOut([
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 一条', summary: '摘要', keywords: ['k2', 'k1'] },
      ]),
      sections,
    );
    expect(reordered!.rewrite).toHaveLength(1);
    expect(reordered!.rewrite[0].keywords).toEqual(['k2', 'k1']);
  });

  it('bodyMd 空串 = 删除该节：即使其余字段与快照相同也要产出', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 一条', summary: '摘要', keywords: ['k1'] })];
    const out = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '   ', summary: '摘要', keywords: ['k1'] }]),
      sections,
    );
    expect(out!.rewrite).toEqual([
      { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '', summary: '摘要', keywords: ['k1'], baseLamport: 11 },
    ]);
  });

  it('不认识的 sectionKey：无 title/bodyMd 则丢弃；两者齐全才算新建（baseLamport=0）', () => {
    const sections = [snap('project', 'legacy-project', { title: '历史条目（未归并）' })];
    const out = parseConsolidationPlan(
      modelOut([
        // 凭空改写一个不存在的章节，且没给新建所需字段 → 丢弃（否则 memory.rewrite 会拿 baseLamport=0 去建一节无标题孤儿）
        { scope: 'project', sectionKey: 'ghost', bodyMd: '- 幻觉正文' },
        { scope: 'project', sectionKey: 'ghost-2', title: '只有标题' },
        { scope: 'project', sectionKey: 'ghost-3' },
        // 合规新建：把收容章节拆进正式主题
        {
          scope: 'project',
          sectionKey: 'sku-characteristics',
          title: 'SKU 特性',
          bodyMd: '- A001 易碎',
          summary: '一条商品特性',
          keywords: ['SKU'],
          baseLamport: 77, // 新建也必须传 0（模型回传值一律忽略）
        },
      ]),
      sections,
    );
    expect(out!.rewrite).toEqual([
      {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: 'SKU 特性',
        bodyMd: '- A001 易碎',
        summary: '一条商品特性',
        keywords: ['SKU'],
        baseLamport: 0,
      },
    ]);
  });

  it('新建章节数受 MAX_NEW_SECTIONS_PER_RUN 限制；既有章节的改写不占额度', () => {
    expect(MAX_NEW_SECTIONS_PER_RUN).toBe(4);
    const sections = [snap('project', 'legacy-project', { title: '历史条目（未归并）' })];
    const news = Array.from({ length: 6 }, (_, i) => ({
      scope: 'project',
      sectionKey: `new-section-${i}`,
      title: `新章节 ${i}`,
      bodyMd: `- 正文 ${i}`,
      summary: `摘要 ${i}`,
      keywords: [`k${i}`],
    }));
    const out = parseConsolidationPlan(
      modelOut([
        ...news,
        // 排在 6 个新建之后：既有章节的删除仍要被采纳（额度只限新建）
        { scope: 'project', sectionKey: 'legacy-project', title: '历史条目（未归并）', bodyMd: '', summary: '', keywords: [] },
      ]),
      sections,
    );
    expect(out!.rewrite).toHaveLength(MAX_NEW_SECTIONS_PER_RUN + 1);
    expect(out!.rewrite.slice(0, 4).map((op) => op.sectionKey)).toEqual([
      'new-section-0',
      'new-section-1',
      'new-section-2',
      'new-section-3',
    ]);
    expect(out!.rewrite[4]).toMatchObject({ sectionKey: 'legacy-project', bodyMd: '', baseLamport: 11 });
  });

  it('bodyMd 超单节上限 → 丢该条（既有章节与新建章节同规则）', () => {
    const sections = [snap('project', 'sec-a', { title: '甲' })];
    const out = parseConsolidationPlan(
      modelOut([
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '长'.repeat(MAX_BODY_LENGTH + 1) },
        { scope: 'project', sectionKey: 'brand-new', title: '乙', bodyMd: '长'.repeat(MAX_BODY_LENGTH + 1) },
      ]),
      sections,
    );
    expect(out).toBe(EMPTY_CONSOLIDATION_PLAN);

    // 恰好 6000 字：通过（上限是「不超过」）
    const edge = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '长'.repeat(MAX_BODY_LENGTH) }]),
      sections,
    );
    expect(edge!.rewrite).toHaveLength(1);
    expect(edge!.rewrite[0].bodyMd).toHaveLength(MAX_BODY_LENGTH);
  });

  it('同一章节出现两次 → 只取第一次（每节最多改一次，防模型自相矛盾）', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧' })];
    const out = parseConsolidationPlan(
      modelOut([
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 第一版', summary: 's1', keywords: [] },
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 第二版', summary: 's2', keywords: [] },
      ]),
      sections,
    );
    expect(out!.rewrite).toHaveLength(1);
    expect(out!.rewrite[0].bodyMd).toBe('- 第一版');
    expect(out!.rewrite[0].summary).toBe('s1');
  });

  it('可疑之处：第一次是「无变化」时不登记 seen，第二次的改动仍会被采纳', () => {
    // 源码注释写的是「每节最多改一次」，但 seen 只在真正产出条目时登记，
    // 于是 no-op + 后续改动 的组合会绕开该约束（见交付报告）。
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧', summary: 's', keywords: ['k'] })];
    const out = parseConsolidationPlan(
      modelOut([
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 旧', summary: 's', keywords: ['k'] }, // no-op
        { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 第二次改动', summary: 's2', keywords: [] },
      ]),
      sections,
    );
    expect(out!.rewrite).toHaveLength(1);
    expect(out!.rewrite[0].bodyMd).toBe('- 第二次改动');
  });

  it('summary / keywords 省略 → 回退快照值（title 同理）：漏回不等于「要清空」', () => {
    // summary/keywords 是 T0 目录与 T2 预取的检索面：模型漏回就清空，等于该节从
    // 常驻目录里「失声」，还会让 isNoOp 判否、白写一次事件。
    const sections = [
      snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧', summary: '旧摘要', keywords: ['旧词'] }),
    ];
    const out = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', bodyMd: '- 新正文' }]),
      sections,
    );
    expect(out!.rewrite).toEqual([
      { scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 新正文', summary: '旧摘要', keywords: ['旧词'], baseLamport: 11 },
    ]);
  });

  it('summary / keywords 显式清空 → 只在正文也变化时落账（显式空值不当作漏回）', () => {
    const sections = [
      snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧', summary: '旧摘要', keywords: ['旧词'] }),
    ];
    const out = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', bodyMd: '- 新', summary: '', keywords: [] }]),
      sections,
    );
    // 显式空值与漏回在 JSON 层不可区分（都窄化成 ''/[]）→ 一律回退，宁可留住旧检索面
    expect(out!.rewrite[0].summary).toBe('旧摘要');
    expect(out!.rewrite[0].keywords).toEqual(['旧词']);
  });

  it('keywords 窄化：非字符串/空白项被过滤并 trim、去重、截长、限个数', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧', keywords: ['旧词'] })];
    const dirty = parseConsolidationPlan(
      modelOut([
        {
          scope: 'project',
          sectionKey: 'sec-a',
          title: '甲',
          bodyMd: '- 新',
          keywords: ['  SKU  ', '', '  ', 42, null, ['x'], '易碎', 'SKU', '0123456789abcdefgh'],
        },
      ]),
      sections,
    );
    // 去重 + 单个关键词截到 16 字（越界在工具侧是整条 TOOL_REJECTED，必须在解析阶段裁掉）
    expect(dirty!.rewrite[0].keywords).toEqual(['SKU', '易碎', '0123456789abcdef']);
  });

  it('keywords 非数组 → 视为漏回，保留快照值（不是清空）', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧', keywords: ['旧词'] })];
    const notArray = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 新', keywords: 'SKU' }]),
      sections,
    );
    expect(notArray!.rewrite[0].keywords).toEqual(['旧词']);
  });

  it('summary 超 120 字被截断（越界字段会废掉整节的整理结果）', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧' })];
    const out = parseConsolidationPlan(
      modelOut([{ scope: 'project', sectionKey: 'sec-a', title: '甲', bodyMd: '- 新', summary: 'x'.repeat(200) }]),
      sections,
    );
    expect(out!.rewrite[0].summary).toBe('x'.repeat(120));
  });

  it('title 超 60 字被截断；scope / sectionKey 非法 → 丢该条', () => {
    const sections = [snap('project', 'sec-a', { title: '甲', bodyMd: '- 旧' })];
    const longTitle = parseConsolidationPlan(
      modelOut([
        {
          scope: 'project',
          sectionKey: 'sec-a',
          title: `  ${'标'.repeat(MAX_TITLE_LENGTH + 20)}  `,
          bodyMd: '- 新',
        },
      ]),
      sections,
    );
    expect(longTitle!.rewrite[0].title).toBe('标'.repeat(MAX_TITLE_LENGTH));

    const bad = parseConsolidationPlan(
      modelOut([
        { scope: 'global', sectionKey: 'sec-a', title: '甲', bodyMd: '- 新' },
        { scope: 'project', sectionKey: 'Bad Key', title: '甲', bodyMd: '- 新' },
        { scope: 'project', sectionKey: '', title: '甲', bodyMd: '- 新' },
        { scope: 'project', title: '甲', bodyMd: '- 新' },
      ]),
      sections,
    );
    expect(bad).toBe(EMPTY_CONSOLIDATION_PLAN);
  });

  it('跨 scope 同键互不相干：personal/sec-a 的改动不会落到 project/sec-a 上', () => {
    const sections = [
      snap('project', 'sec-a', { title: '项目甲', bodyMd: '- 项目正文', baseLamport: 7 }),
      snap('personal', 'sec-a', { title: '个人甲', bodyMd: '- 个人正文', baseLamport: 9 }),
    ];
    const out = parseConsolidationPlan(
      modelOut([{ scope: 'personal', sectionKey: 'sec-a', title: '个人甲（改）', bodyMd: '- 个人新正文' }]),
      sections,
    );
    expect(out!.rewrite).toHaveLength(1);
    expect(out!.rewrite[0].scope).toBe('personal');
    expect(out!.rewrite[0].baseLamport).toBe(9); // 令牌也必须是该 scope 那一节的
    expect(out!.rewrite[0].summary).toBe('旧摘要'); // 模型没回摘要 → 保留该 scope 那一节的原摘要
    expect(out!.rewrite[0].keywords).toEqual(['旧词']); // 同上，检索面不被清空
  });
});

describe('planConsolidation（驱动一次无工具的 LLM 调用）', () => {
  it('空输入 → undefined 且不调用 Provider', async () => {
    const { provider, calls } = scriptedProvider('{"sections":[]}');
    await expect(planConsolidation(provider, [])).resolves.toBeUndefined();
    expect(calls).toHaveLength(0); // 没东西可整理就别花 token
  });

  it('正常路径：Provider 收到 system prompt、各节正文与 baseLamport，且不给工具', async () => {
    const sections = [
      snap('project', 'sku-characteristics', {
        title: 'SKU 特性',
        bodyMd: '- A001 易碎\n- A001 易碎',
        baseLamport: 42,
      }),
      snap('project', 'legacy-project', { title: '历史条目（未归并）', bodyMd: '- [uuid] 老条目', baseLamport: 7 }),
    ];
    const { provider, calls } = scriptedProvider(
      modelOut([
        { scope: 'project', sectionKey: 'sku-characteristics', title: 'SKU 特性', bodyMd: '- A001 易碎', summary: 's', keywords: ['SKU'] },
      ]),
    );

    const plan = await planConsolidation(provider, sections);
    expect(plan!.rewrite).toEqual([
      {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: 'SKU 特性',
        bodyMd: '- A001 易碎',
        summary: 's',
        keywords: ['SKU'],
        baseLamport: 42,
      },
    ]);

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.system).toBe(MEMORY_CONSOLIDATE_SYSTEM);
    expect(req.tools).toEqual([]); // 归并只出计划，落账由调用方走工具总线（护栏与审计在那一层）
    expect(req.messages).toHaveLength(1);
    const text = req.messages[0].role === 'user' ? req.messages[0].text : '';
    expect(text).toContain('【待整理的记忆章节】');
    expect(text).toContain('--- scope=project sectionKey=sku-characteristics baseLamport=42 标题「SKU 特性」');
    expect(text).toContain('- A001 易碎\n- A001 易碎'); // 完整正文（归并要看到重复行才能合并）
    expect(text).toContain('--- scope=project sectionKey=legacy-project baseLamport=7 标题「历史条目（未归并）」');
    expect(text).toContain('- [uuid] 老条目');
    expect(text).toContain('请输出 JSON：');
  });

  it('输入超过 16 节 → 只送前 16 节；第 17 节被当成「新建」而不是拿旧令牌覆盖', async () => {
    expect(MAX_CONSOLIDATE_INPUT_SECTIONS).toBe(16);
    const sections = Array.from({ length: 17 }, (_, i) =>
      snap('project', `sec-${String(i).padStart(2, '0')}`, {
        title: `第 ${i} 节`,
        bodyMd: `- 正文 ${i}`,
        baseLamport: 100 + i,
      }),
    );
    const { provider, calls } = scriptedProvider(
      modelOut([{ scope: 'project', sectionKey: 'sec-16', title: '第 16 节', bodyMd: '- 改写正文' }]),
    );

    const plan = await planConsolidation(provider, sections);
    const text = calls[0].messages[0].role === 'user' ? calls[0].messages[0].text : '';
    expect(text).toContain('正文 15'); // 第 16 节（下标 15）在内
    expect(text).not.toContain('正文 16'); // 第 17 节被截掉
    expect(text).toContain('baseLamport=115');
    expect(text).not.toContain('baseLamport=116');

    // 模型仍然回传了第 17 节：它不在输入快照里 → 只能按新建处理（baseLamport=0），
    // 绝不会拿一个不属于它的旧令牌去覆盖真实章节
    expect(plan!.rewrite).toEqual([
      {
        scope: 'project',
        sectionKey: 'sec-16',
        title: '第 16 节',
        bodyMd: '- 改写正文',
        summary: '',
        keywords: [],
        baseLamport: 0,
      },
    ]);
  });

  it('模型输出不合法 → undefined（调用方 catch 后当作「这次没整理」）', async () => {
    const { provider } = scriptedProvider('这几节都挺好的，不用改');
    await expect(planConsolidation(provider, [snap('project', 'sec-a')])).resolves.toBeUndefined();
  });

  it('Provider 抛错 → 错误上抛（本层不吞异常）', async () => {
    const provider: LlmProvider = {
      completeTurn: async () => {
        throw new Error('provider boom');
      },
    };
    await expect(planConsolidation(provider, [snap('project', 'sec-a')])).rejects.toThrow('provider boom');
  });
});
