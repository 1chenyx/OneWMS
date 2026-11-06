import type { AgentMemoryRef, LlmProvider } from './types.js';
import { MEMORY_EXTRACT_SYSTEM } from './prompts.js';

/**
 * 记忆提取（out-of-band，自动记忆的纯逻辑核心）。
 *
 * 输入一轮对话（用户消息 + 助手最终回复）与现有记忆清单，驱动一次
 * 无工具的 LLM 调用，输出增删计划（MemoryPlan）。调用方（server 的
 * chat 钩子）负责执行计划：逐条走工具总线落账（护栏 + 审计复用）。
 *
 * 纪律：
 *  - 本文件零 SDK 依赖（Provider 注入）、不碰 db/oplog——@one/ai 是纯编排层；
 *  - 模型输出不可信：剥 ```json 围栏、窄化、forget 的 id 必须在现有清单中、
 *    save 逐条 trim 且单轮上限 5 条——任何不合法整体丢弃（宁可漏记不可脏账）；
 *  - assistantText 为空（纯工具轮/中断）直接返回 undefined，不发起调用。
 */

/** 单轮提取最多保存的条数（防模型刷屏式灌记忆） */
export const MAX_SAVES_PER_EXTRACTION = 5;

/** 提取计划：save 全新增，forget 按 id 删除（语义 = 修正/过时清理） */
export interface MemoryPlan {
  save: { scope: 'personal' | 'project'; content: string }[];
  forget: { memoryId: string }[];
}

/** 空计划（模型判断无值得记的内容时的规范返回） */
export const EMPTY_MEMORY_PLAN: MemoryPlan = { save: [], forget: [] };

export interface MemoryExtractionInput {
  userText: string;
  assistantText: string;
  /** 现有记忆全清单（去重与 forget 合法性的判据） */
  memories: readonly AgentMemoryRef[];
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

  const lines: string[] = ['【现有记忆】'];
  if (input.memories.length === 0) {
    lines.push('（暂无）');
  } else {
    for (const m of input.memories) {
      lines.push(`- ${m.id} [${m.scope}] ${m.content}`);
    }
  }
  lines.push('', '【本轮对话】', `用户：${user}`, `助手：${assistant}`, '', '请输出 JSON：');

  const res = await provider.completeTurn({
    system: MEMORY_EXTRACT_SYSTEM,
    messages: [{ role: 'user', text: lines.join('\n') }],
    tools: [],
  });
  return parseMemoryPlan(res.text, input.memories);
}

/**
 * 解析模型输出为计划：剥围栏 → JSON.parse → 窄化。
 * forget 的 id 必须存在于现有清单（防幻觉删库）；save 去空、去超限；
 * 两个数组都空 = EMPTY_MEMORY_PLAN。任何解析异常返回 undefined（整体丢弃）。
 */
export function parseMemoryPlan(
  text: string,
  memories: readonly AgentMemoryRef[],
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

  // forget：id 必须在现有清单中（幻觉 id 静默丢弃该条）
  const knownIds = new Set(memories.map((m) => m.id));
  const forget: { memoryId: string }[] = [];
  if (Array.isArray(r.forget)) {
    for (const f of r.forget) {
      if (typeof f !== 'object' || f === null) continue;
      const id = (f as Record<string, unknown>).memoryId;
      if (typeof id === 'string' && knownIds.has(id) && !forget.some((x) => x.memoryId === id)) {
        forget.push({ memoryId: id });
      }
    }
  }

  // save：scope 枚举 + content 非空，单轮上限
  const save: { scope: 'personal' | 'project'; content: string }[] = [];
  if (Array.isArray(r.save)) {
    for (const s of r.save) {
      if (save.length >= MAX_SAVES_PER_EXTRACTION) break;
      if (typeof s !== 'object' || s === null) continue;
      const rec = s as Record<string, unknown>;
      const scope = rec.scope;
      const content = typeof rec.content === 'string' ? rec.content.trim() : '';
      if ((scope === 'personal' || scope === 'project') && content) {
        save.push({ scope, content });
      }
    }
  }

  if (save.length === 0 && forget.length === 0) return EMPTY_MEMORY_PLAN;
  return { save, forget };
}

/** 剥 ```json 围栏（本地小模型常见的输出习惯） */
function stripJsonFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = text.match(fence);
  return m ? m[1] : text;
}
