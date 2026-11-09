import type { LlmProvider, MemorySectionSnapshot } from './types.js';
import { MEMORY_CONSOLIDATE_SYSTEM } from './prompts.js';
import { MAX_TITLE_LENGTH, SECTION_KEY_PATTERN, stripJsonFence } from './memory-extract.js';

/**
 * 记忆归并（out-of-band，「整理」动作的纯逻辑核心）。
 *
 * 输入一个 scope 下的全部章节快照（完整正文 + baseLamport），驱动一次无工具的
 * LLM 调用，输出**逐节完整覆盖**计划：合并重复要点、删过时内容、纠正矛盾、
 * 重写标题/摘要/关键词（同一次调用产出，零额外 LLM 成本）；bodyMd 空串 = 删除该节。
 *
 * 调用方（server 的 memory-consolidate 钩子 / 管理页「整理」）负责执行计划：
 * 逐条走工具总线的 memory.rewrite 落账——护栏、审计、乐观并发全部复用。
 *
 * 纪律：
 *  - 模型输出不可信：只接受**输入里已存在的章节**（scope+sectionKey 必须命中），
 *    杜绝归并时凭空造新章节；baseLamport 一律取输入快照的值（不信模型回传），
 *    执行时被别人抢先改过就会被 memory.rewrite 的并发令牌拒绝；
 *  - 与输入完全相同的章节不产出（无变化 = 无事件，账本不灌水）；
 *  - 归并是有人在场的动作（管理页按钮 / 用户对话里明确要求），失败只是「这次没整理」。
 */

/** 单节正文长度上限（与 @one/memory 工具护栏 MAX_SECTION_BODY_LENGTH 同值；
 *  @one/ai 不依赖 @one/memory，超限的条目直接丢弃，由工具护栏兜底） */
export const MAX_BODY_LENGTH = 6000;

/** 单次归并最多处理的章节数（超出截断——输入太长模型质量会崩，分批整理更稳） */
export const MAX_CONSOLIDATE_INPUT_SECTIONS = 16;

/** 单次归并最多新建的章节数（新建只用于把 legacy 收容章节拆进正式主题；防章节爆炸） */
export const MAX_NEW_SECTIONS_PER_RUN = 4;

/**
 * 摘要 / 关键词的上限（与 @one/memory 工具护栏 MAX_SUMMARY_LENGTH /
 * MAX_KEYWORDS / MAX_KEYWORD_LENGTH 同值；@one/ai 不依赖 @one/memory，
 * 这里复制一份常量）。超限必须在解析阶段裁掉：memory.rewrite 对超长字段是
 * 整条 TOOL_REJECTED，一个字段越界会白白废掉整节的整理结果。
 */
export const MAX_SUMMARY_LENGTH = 120;
export const MAX_KEYWORDS = 8;
export const MAX_KEYWORD_LENGTH = 16;

/** 一次整节覆盖（memory.rewrite 的参数形状；bodyMd 空串 = 删除该节） */
export interface MemoryRewriteOp {
  scope: 'personal' | 'project';
  sectionKey: string;
  title: string;
  bodyMd: string;
  summary: string;
  keywords: string[];
  /** 取自输入快照（不是模型回传） */
  baseLamport: number;
}

export interface ConsolidationPlan {
  rewrite: MemoryRewriteOp[];
}

export const EMPTY_CONSOLIDATION_PLAN: ConsolidationPlan = { rewrite: [] };

/**
 * 规划一次归并；无可整理内容返回 undefined。
 * 失败（模型异常/输出非法）由调用方 catch——归并永不影响聊天主流程。
 */
export async function planConsolidation(
  provider: LlmProvider,
  sections: readonly MemorySectionSnapshot[],
): Promise<ConsolidationPlan | undefined> {
  if (sections.length === 0) return undefined;
  const input = sections.slice(0, MAX_CONSOLIDATE_INPUT_SECTIONS);

  const lines: string[] = ['【待整理的记忆章节】'];
  for (const s of input) {
    lines.push(
      `--- scope=${s.scope} sectionKey=${s.sectionKey} baseLamport=${s.baseLamport} 标题「${s.title}」`,
      s.bodyMd.trim(),
    );
  }
  lines.push('', '请输出 JSON：');

  const res = await provider.completeTurn({
    system: MEMORY_CONSOLIDATE_SYSTEM,
    messages: [{ role: 'user', text: lines.join('\n') }],
    tools: [],
  });
  return parseConsolidationPlan(res.text, input);
}

/**
 * 解析归并输出：剥围栏 → JSON.parse → 窄化。
 * 只接受输入里存在的章节；baseLamport 用输入值；与输入无差异的条目丢弃。
 */
export function parseConsolidationPlan(
  text: string,
  sections: readonly MemorySectionSnapshot[],
): ConsolidationPlan | undefined {
  const stripped = stripJsonFence(text.trim());
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const list = (raw as Record<string, unknown>).sections;
  if (!Array.isArray(list)) return undefined;

  const byKey = new Map(sections.map((s) => [`${s.scope}\u0000${s.sectionKey}`, s]));
  const rewrite: MemoryRewriteOp[] = [];
  const seen = new Set<string>();
  let created = 0;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const scope = o.scope;
    if (scope !== 'personal' && scope !== 'project') continue;
    const sectionKey = typeof o.sectionKey === 'string' ? o.sectionKey.trim() : '';
    if (!SECTION_KEY_PATTERN.test(sectionKey)) continue;
    const existing = byKey.get(`${scope}\u0000${sectionKey}`);
    if (seen.has(`${scope}\u0000${sectionKey}`)) continue; // 每节最多改一次

    const bodyMd = typeof o.bodyMd === 'string' ? o.bodyMd.trim() : '';
    if (bodyMd.length > MAX_BODY_LENGTH) continue;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
    const summary =
      typeof o.summary === 'string' ? o.summary.trim().slice(0, MAX_SUMMARY_LENGTH) : '';
    const keywords = normalizeKeywords(o.keywords);

    if (!existing) {
      // 新建章节：只用于把 legacy 收容章节拆进正式主题——必须有标题与正文，且总数受限
      if (!title || !bodyMd || created >= MAX_NEW_SECTIONS_PER_RUN) continue;
      created++;
      seen.add(`${scope}\u0000${sectionKey}`);
      rewrite.push({ scope, sectionKey, title, bodyMd, summary, keywords, baseLamport: 0 });
      continue;
    }

    const next: MemoryRewriteOp = {
      scope,
      sectionKey,
      title: title || existing.title,
      bodyMd,
      // 模型漏回 summary/keywords 时保留原值：这两个字段是 T0 目录与 T2 预取的
      // 检索面，被清空等于该节从常驻目录里「失声」——漏回不等于「要清空」
      summary: summary || existing.summary,
      keywords: keywords.length > 0 ? keywords : [...existing.keywords],
      baseLamport: existing.baseLamport, // 不信模型回传
    };
    if (isNoOp(next, existing)) continue;
    seen.add(`${scope}\u0000${sectionKey}`);
    rewrite.push(next);
  }
  if (rewrite.length === 0) return EMPTY_CONSOLIDATION_PLAN;
  return { rewrite };
}

/**
 * 关键词窄化：去空白、去重、截长、限个数——保证产出一定过 memory.rewrite 的
 * checkKeywords 护栏（越界是整条 TOOL_REJECTED，不是裁剪）。
 */
function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'string') continue;
    const k = item.trim().slice(0, MAX_KEYWORD_LENGTH);
    if (!k || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** 与输入完全一致 = 无变化（不产出事件，账本不灌水） */
function isNoOp(next: MemoryRewriteOp, prev: MemorySectionSnapshot): boolean {
  return (
    next.bodyMd === prev.bodyMd.trim() &&
    next.title === prev.title &&
    next.summary === prev.summary &&
    next.keywords.length === prev.keywords.length &&
    next.keywords.every((k, i) => k === prev.keywords[i])
  );
}
