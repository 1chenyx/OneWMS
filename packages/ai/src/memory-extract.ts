import type { LlmProvider, MemorySectionBrief } from './types.js';
import { MEMORY_EXTRACT_SYSTEM } from './prompts.js';

/**
 * 记忆提取（out-of-band，自动记忆的纯逻辑核心）。
 *
 * 输入一轮对话（用户消息 + 助手最终回复）与**现有章节目录**（不含正文——
 * 提取只做增量追加，不需要读全文），驱动一次无工具的 LLM 调用，输出追加计划
 * （MemoryPlan）。调用方（server 的 chat 钩子）负责执行计划：逐条走工具总线
 * 的 memory.append 落账（护栏 + 审计复用）。
 *
 * 为什么自动路径只有 append：
 *  - append 是低摩擦、天然可交换的增量写（两条并发追加互不覆盖），失败无害，
 *    不需要并发令牌；
 *  - rewrite/删除是整节覆盖的高风险动作，必须在有人在场的路径上做（对话中 AI
 *    用 memory.rewrite 带 baseLamport，或管理页「整理」走 memory-consolidate）。
 *
 * 纪律：
 *  - 本文件零 SDK 依赖（Provider 注入）、不碰 db/oplog——@one/ai 是纯编排层；
 *  - 模型输出不可信：剥 ```json 围栏、窄化、逐条校验（scope 枚举 / 键名规则 /
 *    文本非空且不超长）、同批去重、单轮上限——不合法的条目直接丢弃
 *    （宁可漏记不可脏账）；
 *  - assistantText 为空（纯工具轮/中断）直接返回 undefined，不发起调用。
 */

/** 单轮提取最多追加的条数（防模型刷屏式灌记忆） */
export const MAX_APPENDS_PER_EXTRACTION = 3;

/** 单条要点长度上限（字符）：一条要点 = 一条事实，长了就该拆或该归并 */
export const MAX_APPEND_TEXT_LENGTH = 200;

/** 章节标题长度上限（新建章节时用） */
export const MAX_TITLE_LENGTH = 60;

/**
 * 章节键规则（与 @one/memory 的 SECTION_KEY_PATTERN 同规则）。
 * @one/ai 不依赖 @one/memory（保持纯编排层），因此这里复制一份常量：
 * 两边不一致时以工具护栏为准——非法键会在 memory.append 处被 TOOL_REJECTED 拦下。
 */
export const SECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** 一次追加操作（memory.append 的参数形状） */
export interface MemoryAppendOp {
  scope: 'personal' | 'project';
  sectionKey: string;
  /** 新建章节时的标题；追加到既有章节可省略 */
  title?: string;
  text: string;
}

/** 提取计划：只有追加（改写/删除走有人在场的路径） */
export interface MemoryPlan {
  append: MemoryAppendOp[];
}

/** 空计划（模型判断无值得记的内容时的规范返回） */
export const EMPTY_MEMORY_PLAN: MemoryPlan = { append: [] };

export interface MemoryExtractionInput {
  userText: string;
  assistantText: string;
  /** 现有章节目录（去重与落点选择的判据；不含正文） */
  sections: readonly MemorySectionBrief[];
}

/**
 * 从一轮对话提取记忆计划；无可提取内容返回 undefined。
 * 提取失败（模型异常/输出非法）由调用方 catch 静默——自动记忆
 * 永不影响聊天主流程。
 */
export async function extractMemoryPlan(
  provider: LlmProvider,
  input: MemoryExtractionInput,
): Promise<MemoryPlan | undefined> {
  const user = input.userText.trim();
  const assistant = input.assistantText.trim();
  if (!user || !assistant) return undefined;

  const lines: string[] = ['【现有章节目录】'];
  if (input.sections.length === 0) {
    lines.push('（暂无章节：需要新起章节，sectionKey 用小写连字符命名并给中文 title）');
  } else {
    for (const s of input.sections) {
      const kw = s.keywords.length > 0 ? ` · 关键词 ${s.keywords.join('/')}` : '';
      lines.push(
        `- [${s.scope}] sectionKey=${s.sectionKey} 标题「${s.title}」${kw}${s.summary ? ` · 摘要：${s.summary}` : ''}`,
      );
    }
  }
  lines.push('', '【本轮对话】', `用户：${user}`, `助手：${assistant}`, '', '请输出 JSON：');

  const res = await provider.completeTurn({
    system: MEMORY_EXTRACT_SYSTEM,
    messages: [{ role: 'user', text: lines.join('\n') }],
    tools: [],
  });
  return parseMemoryPlan(res.text, input.sections);
}

/**
 * 解析模型输出为计划：剥围栏 → JSON.parse → 窄化。
 * 逐条校验：scope 枚举、sectionKey 合规则、text 非空且不超长、title 可选；
 * 同批 (scope, sectionKey, text) 去重；超出 MAX_APPENDS_PER_EXTRACTION 截断。
 * 整体解析失败返回 undefined（宁缺勿滥）；条目不合法只丢该条。
 */
export function parseMemoryPlan(
  text: string,
  sections: readonly MemorySectionBrief[],
): MemoryPlan | undefined {
  const stripped = stripJsonFence(text.trim());
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;

  const appendRaw = r.append;
  const append: MemoryAppendOp[] = [];
  if (Array.isArray(appendRaw)) {
    const known = new Set(sections.map((s) => `${s.scope}\u0000${s.sectionKey}`));
    const seen = new Set<string>();
    for (const item of appendRaw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const scope = o.scope;
      if (scope !== 'personal' && scope !== 'project') continue;
      const sectionKey = typeof o.sectionKey === 'string' ? o.sectionKey.trim() : '';
      if (!SECTION_KEY_PATTERN.test(sectionKey)) continue;
      const body = typeof o.text === 'string' ? o.text.trim() : '';
      if (!body || body.length > MAX_APPEND_TEXT_LENGTH) continue;
      const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
      // 新建章节必须有标题：模型没给就丢弃（追加到既有章节不需要）
      if (!known.has(`${scope}\u0000${sectionKey}`) && !title) continue;
      const dedupeKey = `${scope}\u0000${sectionKey}\u0000${body}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      append.push(title ? { scope, sectionKey, title, text: body } : { scope, sectionKey, text: body });
      if (append.length >= MAX_APPENDS_PER_EXTRACTION) break;
    }
  }
  if (append.length === 0) return EMPTY_MEMORY_PLAN;
  return { append };
}

/**
 * 剥 ```json … ``` 围栏（模型常见的「不听话」输出形态；也容忍裸 JSON）。
 * 语言标记大小写不敏感（```JSON 同样常见）——漏剥会把 "JSON\n{…}" 喂给
 * JSON.parse，整份计划静默作废。
 */
export function stripJsonFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return m ? m[1].trim() : text;
}
