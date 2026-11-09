import { describe, it, expect } from 'vitest';
import {
  EMPTY_MEMORY_PLAN,
  MAX_APPENDS_PER_EXTRACTION,
  MAX_APPEND_TEXT_LENGTH,
  SECTION_KEY_PATTERN,
  extractMemoryPlan,
  parseMemoryPlan,
  stripJsonFence,
  type LlmProvider,
  type LlmTurnRequest,
  type MemorySectionBrief,
} from '../src/index.js';
import { MAX_TITLE_LENGTH } from '../src/memory-extract.js';
import { MEMORY_EXTRACT_SYSTEM } from '../src/prompts.js';

/**
 * 记忆提取（out-of-band）的纯逻辑：模型输出不可信 → 剥围栏、窄化、逐条校验、
 * 同批去重、单轮截断；宁缺勿滥（整体不合法返回 undefined，单条不合法只丢该条）。
 *
 * 断言纪律：
 *  - 计划最终会被执行成 memory.append（写账本 + 进 system prompt），所以
 *    「模型胡说的字段」必须在这里被剥干净，不能指望工具护栏兜底；
 *  - 空 userText/assistantText 一律不发起调用——省 token 也省一次误记的机会。
 */

/** 目录项（提取只看目录，不看正文） */
function brief(
  scope: 'personal' | 'project',
  sectionKey: string,
  over: Partial<MemorySectionBrief> = {},
): MemorySectionBrief {
  return {
    scope,
    sectionKey,
    title: over.title ?? sectionKey,
    summary: over.summary ?? '',
    keywords: over.keywords ?? [],
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

/** 目录里已有的两节（一 personal 一 project）——「新建 vs 追加」判定的基准 */
const DIRECTORY: MemorySectionBrief[] = [
  brief('personal', 'user-prefs', { title: '用户偏好', summary: '称呼与回复风格', keywords: ['称呼'] }),
  brief('project', 'sku-characteristics', { title: 'SKU 特性', keywords: ['SKU'] }),
];

describe('stripJsonFence（剥围栏）', () => {
  it('```json 围栏 / 无语言标记围栏 → 取内层', () => {
    expect(stripJsonFence('```json\n{"append":[]}\n```')).toBe('{"append":[]}');
    expect(stripJsonFence('```\n{"append":[]}\n```')).toBe('{"append":[]}');
    // 语言标记大小写不敏感：```JSON 同样常见。大小写敏感的正则会退化成
    // 「空语言标记 + 捕获 JSON…」，剥完残留 'JSON' 前缀 → 后续 JSON.parse 必然失败，
    // 整份提取计划静默作废
    expect(stripJsonFence('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```Json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('裸 JSON / 前后空白 → 原样返回（内部再 trim）', () => {
    expect(stripJsonFence('{"append":[]}')).toBe('{"append":[]}');
    expect(stripJsonFence('  {"append":[]}  ')).toBe('  {"append":[]}  ');
    expect(stripJsonFence('')).toBe('');
  });

  it('非围栏文本 / 围栏后带尾巴 → 原样返回（正则锚定首尾，不猜测）', () => {
    expect(stripJsonFence('好的，以下是 JSON：{"append":[]}')).toBe('好的，以下是 JSON：{"append":[]}');
    // 尾巴破坏了 `$` 锚定 → 不剥；后续 JSON.parse 失败即 undefined（宁缺勿滥）
    expect(stripJsonFence('```json\n{"append":[]}\n```\n希望有帮助')).toContain('```json');
    // 未闭合围栏 → 不剥
    expect(stripJsonFence('```json\n{"append":[]}')).toBe('```json\n{"append":[]}');
  });
});

describe('parseMemoryPlan：整体形状', () => {
  it('合法输出（多条）逐条落位', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'personal', sectionKey: 'user-prefs', text: '称呼用户为「老板」' },
          { scope: 'project', sectionKey: 'supplier-agreements', title: '供应商约定', text: '每月底对账' },
        ],
      }),
      DIRECTORY,
    );
    expect(out).toEqual({
      append: [
        { scope: 'personal', sectionKey: 'user-prefs', text: '称呼用户为「老板」' },
        { scope: 'project', sectionKey: 'supplier-agreements', title: '供应商约定', text: '每月底对账' },
      ],
    });
    // 追加到既有章节时不凭空塞 title 键（省 token，也让调用方能区分新建/追加）
    expect(Object.keys(out!.append[0])).toEqual(['scope', 'sectionKey', 'text']);
  });

  it('```json 围栏与裸 JSON 都能解析；sectionKey/text 两端空白被 trim', () => {
    const body = JSON.stringify({
      append: [{ scope: 'personal', sectionKey: ' user-prefs ', text: '  偏好简短回复  ' }],
    });
    expect(parseMemoryPlan(`\`\`\`json\n${body}\n\`\`\``, DIRECTORY)).toEqual({
      append: [{ scope: 'personal', sectionKey: 'user-prefs', text: '偏好简短回复' }],
    });
    expect(parseMemoryPlan(`  ${body}  `, DIRECTORY)).toEqual({
      append: [{ scope: 'personal', sectionKey: 'user-prefs', text: '偏好简短回复' }],
    });
  });

  it('非 JSON / 空串 / 数组 / 标量 / null → undefined（调用方静默跳过）', () => {
    expect(parseMemoryPlan('这轮没什么值得记的', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('   ', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('[{"scope":"personal"}]', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('null', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('"一个字符串"', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('42', DIRECTORY)).toBeUndefined();
    expect(parseMemoryPlan('```json\n不是 JSON\n```', DIRECTORY)).toBeUndefined();
  });

  it('大写围栏同样剥得干净（```JSON → 合法空计划，不是解析失败）', () => {
    expect(parseMemoryPlan('```JSON\n{"append":[]}\n```', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
  });

  it('append 非数组 / 缺失 / 空数组 → EMPTY_MEMORY_PLAN（合法但没东西可记）', () => {
    expect(parseMemoryPlan('{}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    expect(parseMemoryPlan('{"append":[]}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    expect(parseMemoryPlan('{"append":"不是数组"}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    expect(parseMemoryPlan('{"append":{}}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    expect(parseMemoryPlan('{"rewrite":[]}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    // 数组里的非对象项被跳过 → 仍是空计划
    expect(parseMemoryPlan('{"append":[null,"x",42]}', DIRECTORY)).toBe(EMPTY_MEMORY_PLAN);
    expect(EMPTY_MEMORY_PLAN).toEqual({ append: [] });
  });

  it('常量与键规则：与 @one/memory 的护栏同值（这里只是复制常量，不产生依赖）', () => {
    expect(MAX_APPENDS_PER_EXTRACTION).toBe(3);
    expect(MAX_APPEND_TEXT_LENGTH).toBe(200);
    expect(MAX_TITLE_LENGTH).toBe(60);
    expect(SECTION_KEY_PATTERN.test('supplier-agreements')).toBe(true);
    expect(SECTION_KEY_PATTERN.test('a2-b')).toBe(true);
    expect(SECTION_KEY_PATTERN.test('Bad Key')).toBe(false);
    expect(SECTION_KEY_PATTERN.test('a')).toBe(false); // 至少 2 字符
    expect(SECTION_KEY_PATTERN.test('-lead')).toBe(false);
    expect(SECTION_KEY_PATTERN.test('under_score')).toBe(false);
    expect(SECTION_KEY_PATTERN.test('x'.repeat(49))).toBe(false); // 上限 48
  });
});

describe('parseMemoryPlan：逐条校验（单条不合法只丢该条）', () => {
  it('scope 非法 / 缺失 / 非字符串 → 丢该条', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'global', sectionKey: 'user-prefs', text: '一' },
          { scope: '', sectionKey: 'user-prefs', text: '二' },
          { sectionKey: 'user-prefs', text: '三' },
          { scope: 1, sectionKey: 'user-prefs', text: '四' },
          { scope: 'project', sectionKey: 'sku-characteristics', text: '五（合法）' },
        ],
      }),
      DIRECTORY,
    );
    expect(out!.append).toEqual([{ scope: 'project', sectionKey: 'sku-characteristics', text: '五（合法）' }]);
  });

  it('sectionKey 不合规 / 缺失 → 丢该条', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'project', sectionKey: 'Bad Key', text: '一' },
          { scope: 'project', sectionKey: 'a', text: '二' },
          { scope: 'project', sectionKey: 'x'.repeat(49), title: 'T', text: '三' },
          { scope: 'project', text: '四' },
          { scope: 'project', sectionKey: 123, text: '五' },
        ],
      }),
      DIRECTORY,
    );
    expect(out).toBe(EMPTY_MEMORY_PLAN);
  });

  it('text 空白 / 缺失 / 非字符串 / 超 200 字 → 丢该条（200 字整通过）', () => {
    const ok = parseMemoryPlan(
      JSON.stringify({ append: [{ scope: 'project', sectionKey: 'sku-characteristics', text: '长'.repeat(MAX_APPEND_TEXT_LENGTH) }] }),
      DIRECTORY,
    );
    expect(ok!.append).toHaveLength(1);

    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'project', sectionKey: 'sku-characteristics', text: '   ' },
          { scope: 'project', sectionKey: 'sku-characteristics' },
          { scope: 'project', sectionKey: 'sku-characteristics', text: 42 },
          { scope: 'project', sectionKey: 'sku-characteristics', text: `长${'长'.repeat(MAX_APPEND_TEXT_LENGTH)}` },
        ],
      }),
      DIRECTORY,
    );
    expect(out).toBe(EMPTY_MEMORY_PLAN);
  });

  it('title 被 trim 并截到 60 字；空白 title 视同未给', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'project', sectionKey: 'new-section', title: `  ${'标'.repeat(MAX_TITLE_LENGTH + 10)}  `, text: '一' },
          { scope: 'project', sectionKey: 'new-section-2', title: '   ', text: '二' },
        ],
      }),
      DIRECTORY,
    );
    expect(out!.append).toHaveLength(1); // 第二条：新章节没有 title → 丢弃
    expect(out!.append[0].title).toBe('标'.repeat(MAX_TITLE_LENGTH));
  });

  it('新建章节必须有 title；目录里已有的 sectionKey 不带 title 也保留', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          // 目录里没有 + 没 title → 丢弃（否则会落一节没有标题的孤儿章节，目录里没法认）
          { scope: 'project', sectionKey: 'brand-new', text: '新章节没标题' },
          // 目录里已有 + 没 title → 保留（追加到既有章节，标题沿用旧值）
          { scope: 'personal', sectionKey: 'user-prefs', text: '追加到既有章节' },
          // 目录里已有 + 带 title → 保留且带上 title（append 会忽略，但计划要忠实反映模型输出）
          { scope: 'project', sectionKey: 'sku-characteristics', title: 'SKU 特性（新）', text: '再补一条' },
        ],
      }),
      DIRECTORY,
    );
    expect(out!.append.map((op) => op.sectionKey)).toEqual(['user-prefs', 'sku-characteristics']);
    expect(out!.append[0].title).toBeUndefined();
    expect(out!.append[1].title).toBe('SKU 特性（新）');
  });

  it('「目录里已有」按 (scope, sectionKey) 判定：跨 scope 同键仍需 title', () => {
    // 目录里 personal/user-prefs 存在，但 project/user-prefs 不存在 → 视为新建，必须给 title
    const out = parseMemoryPlan(
      JSON.stringify({ append: [{ scope: 'project', sectionKey: 'user-prefs', text: '同键不同层' }] }),
      DIRECTORY,
    );
    expect(out).toBe(EMPTY_MEMORY_PLAN);
  });

  it('超过 3 条截断为前 3 条（防模型刷屏式灌记忆）', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      scope: 'project',
      sectionKey: 'sku-characteristics',
      text: `要点 ${i}`,
    }));
    const out = parseMemoryPlan(JSON.stringify({ append: items }), DIRECTORY);
    expect(out!.append).toHaveLength(MAX_APPENDS_PER_EXTRACTION);
    expect(out!.append.map((op) => op.text)).toEqual(['要点 0', '要点 1', '要点 2']);
  });

  it('同批去重：(scope, sectionKey, text) 完全相同只留一条', () => {
    const out = parseMemoryPlan(
      JSON.stringify({
        append: [
          { scope: 'project', sectionKey: 'sku-characteristics', text: '同一条要点' },
          { scope: 'project', sectionKey: 'sku-characteristics', text: '同一条要点' },
          { scope: 'project', sectionKey: 'sku-characteristics', text: ' 同一条要点 ' }, // trim 后等价
          { scope: 'project', sectionKey: 'sku-characteristics', text: '另一条要点' },
          { scope: 'personal', sectionKey: 'sku-characteristics', title: 'T', text: '同一条要点' }, // scope 不同 → 不去重
        ],
      }),
      DIRECTORY,
    );
    expect(out!.append).toEqual([
      { scope: 'project', sectionKey: 'sku-characteristics', text: '同一条要点' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: '另一条要点' },
      { scope: 'personal', sectionKey: 'sku-characteristics', title: 'T', text: '同一条要点' },
    ]);
  });

  it('去重后仍受 3 条上限约束（重复项不占额度）', () => {
    const items = [
      { scope: 'project', sectionKey: 'sku-characteristics', text: '重复' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: '重复' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: 'A' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: 'B' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: 'C' },
      { scope: 'project', sectionKey: 'sku-characteristics', text: 'D' },
    ];
    const out = parseMemoryPlan(JSON.stringify({ append: items }), DIRECTORY);
    // 重复项不占额度（先判重再计数），但硬上限仍是 3 条
    expect(out!.append.map((op) => op.text)).toEqual(['重复', 'A', 'B']);
  });
});

describe('extractMemoryPlan（驱动一次无工具的 LLM 调用）', () => {
  it('userText 或 assistantText 为空 → 返回 undefined 且不调用 Provider', async () => {
    const { provider, calls } = scriptedProvider('{"append":[]}');
    expect(await extractMemoryPlan(provider, { userText: '', assistantText: '好的', sections: DIRECTORY })).toBeUndefined();
    expect(
      await extractMemoryPlan(provider, { userText: '   ', assistantText: '好的', sections: DIRECTORY }),
    ).toBeUndefined();
    expect(
      await extractMemoryPlan(provider, { userText: '在吗', assistantText: '', sections: DIRECTORY }),
    ).toBeUndefined();
    expect(
      await extractMemoryPlan(provider, { userText: '在吗', assistantText: '  \n ', sections: DIRECTORY }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0); // 纯工具轮/中断不花 token，也不给模型编记忆的机会
  });

  it('正常路径：Provider 收到 system prompt、目录信息、本轮对话，且不给工具', async () => {
    const reply = JSON.stringify({
      append: [{ scope: 'project', sectionKey: 'sku-characteristics', text: 'A001 是易碎品' }],
    });
    const { provider, calls } = scriptedProvider(reply);

    const plan = await extractMemoryPlan(provider, {
      userText: '  A001 有什么要注意的？  ',
      assistantText: '  A001 是易碎品，搬运要轻拿轻放。  ',
      sections: DIRECTORY,
    });
    expect(plan).toEqual({ append: [{ scope: 'project', sectionKey: 'sku-characteristics', text: 'A001 是易碎品' }] });

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.system).toBe(MEMORY_EXTRACT_SYSTEM);
    expect(req.tools).toEqual([]); // 提取是纯文本 JSON 任务，不给工具（否则可能被带偏去写库）
    expect(req.messages).toHaveLength(1);
    const prompt = req.messages[0];
    expect(prompt.role).toBe('user');
    const text = prompt.role === 'user' ? prompt.text : '';
    // 目录信息（落点选择的判据）：scope / sectionKey / 标题 / 关键词 / 摘要
    expect(text).toContain('【现有章节目录】');
    expect(text).toContain('sectionKey=user-prefs');
    expect(text).toContain('sectionKey=sku-characteristics');
    expect(text).toContain('[personal]');
    expect(text).toContain('标题「SKU 特性」');
    expect(text).toContain('关键词 称呼');
    expect(text).toContain('摘要：称呼与回复风格');
    // 关键词为空的章节不输出空「关键词」段
    expect(text).toContain('- [project] sectionKey=sku-characteristics 标题「SKU 特性」 · 关键词 SKU');
    // 本轮对话（两端空白已 trim）
    expect(text).toContain('【本轮对话】');
    expect(text).toContain('用户：A001 有什么要注意的？');
    expect(text).toContain('助手：A001 是易碎品，搬运要轻拿轻放。');
    expect(text).toContain('请输出 JSON：');
  });

  it('目录为空：提示模型需要新起章节（并给中文 title）', async () => {
    const { provider, calls } = scriptedProvider('{"append":[]}');
    const plan = await extractMemoryPlan(provider, {
      userText: '叫我老板',
      assistantText: '好的老板',
      sections: [],
    });
    expect(plan).toBe(EMPTY_MEMORY_PLAN);
    const text = calls[0].messages[0].role === 'user' ? calls[0].messages[0].text : '';
    expect(text).toContain('暂无章节');
    expect(text).toContain('title');
  });

  it('模型输出不合法 → 返回 undefined（由调用方静默跳过，自动记忆永不影响聊天）', async () => {
    const { provider } = scriptedProvider('我觉得这轮没什么可记的');
    await expect(
      extractMemoryPlan(provider, { userText: '在吗', assistantText: '在的', sections: DIRECTORY }),
    ).resolves.toBeUndefined();
  });

  it('Provider 抛错 → 错误上抛（由调用方 catch，本层不吞异常）', async () => {
    const provider: LlmProvider = {
      completeTurn: async () => {
        throw new Error('provider boom');
      },
    };
    await expect(
      extractMemoryPlan(provider, { userText: '在吗', assistantText: '在的', sections: DIRECTORY }),
    ).rejects.toThrow('provider boom');
  });
});
