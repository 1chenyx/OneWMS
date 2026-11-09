import { extractMemoryPlan, type AgentMessage, type LlmProvider } from '@one/ai';
import { readMemorySettings } from '@one/memory';
import type { AppContext } from './context.js';
import { runMemoryConsolidation } from './memory-consolidate.js';

/**
 * 自动记忆钩子（out-of-band 提取，chat 路由 turn-done 后调用）。
 *
 *  - fire-and-forget：不阻塞 SSE（turn-done 已发出后才启动），失败静默
 *    （console.error）——自动记忆永远不影响聊天主流程；
 *  - 模块级 promise 链串行化：并发轮次（多会话/多助手）排队执行，
 *    防提取交错与重复落账；
 *  - 提取走「对话所用 provider」（尊重 per-agent 模型覆盖）；落账走
 *    工具总线（护栏 + 审计复用），actor=ai:memory-auto@{nodeId}——
 *    source 推导为 'auto'，与对话中显式记录（ai:{id}）审计可辨；
 *  - 自动路径只有 append（低摩擦、天然可交换、无需并发令牌）：整节覆盖/删除
 *    是高风险动作，只发生在有人在场的路径（对话中 AI 自己调 memory.rewrite，
 *    或管理页「整理」）；
 *  - autoMemory 设置关闭时零成本跳过（不发起 LLM 调用）。
 */

/** 一轮提取的可观测结果（单条失败不中断其余条目，rejections 留痕便于排查） */
export interface ExtractionStats {
  appended: number;
  failed: number;
  rejections: string[];
}

/** 串行链尾（并发轮次排队：后到者等先到者完成） */
let extractionQueue: Promise<void> = Promise.resolve();

/** 从完整历史取本轮的用户消息与助手最终回复（turn-done 后末条必为 assistant） */
function lastText(messages: readonly AgentMessage[], role: 'user' | 'assistant'): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === role && 'text' in m) return m.text;
  }
  return '';
}

/**
 * 执行一轮提取（核心逻辑，测试直调）：
 * 设置开关 → 取本轮对话 → 提取追加计划 → 逐条经工具总线落账 →
 * 用户画像超预算则顺手归并压缩一次。
 */
export async function runMemoryExtraction(
  ctx: AppContext,
  provider: LlmProvider,
  messages: readonly AgentMessage[],
): Promise<ExtractionStats> {
  const stats: ExtractionStats = { appended: 0, failed: 0, rejections: [] };
  const settings = readMemorySettings(ctx.memory);
  if (!settings.autoMemory) return stats;

  const userText = lastText(messages, 'user');
  const assistantText = lastText(messages, 'assistant');
  if (!userText.trim() || !assistantText.trim()) return stats;

  const plan = await extractMemoryPlan(provider, {
    userText,
    assistantText,
    sections: ctx.memory.sections.list(),
  });
  if (!plan || plan.append.length === 0) return stats;

  const actor = `ai:memory-auto@${ctx.core.nodeId}`;
  for (const op of plan.append) {
    try {
      await ctx.ws.tools.invoke(
        'memory.append',
        { scope: op.scope, sectionKey: op.sectionKey, title: op.title, text: op.text },
        actor,
      );
      stats.appended += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.failed += 1;
      stats.rejections.push(`${op.sectionKey}: ${message}`);
      console.error(`[memory] 自动追加失败（${op.sectionKey}，忽略继续）: ${message}`);
    }
  }

  // T0 常驻段超预算 → 自动压缩一次。只在「本轮确实追加过」时触发：
  // 溢出状态在归并前不会自己消失，每轮都触发等于每轮白烧一次 LLM。
  if (stats.appended > 0 && ctx.memory.sections.resident().overflow) {
    console.warn('[memory] 用户画像超预算，已自动归并压缩（personal）');
    try {
      await runMemoryConsolidation(ctx, provider, { scope: 'personal', actor });
    } catch (err) {
      console.error(
        '[memory] 自动归并失败（不影响聊天）:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return stats;
}

/** 排队执行一轮提取（chat 路由 fire-and-forget 入口）；返回链尾供测试 await */
export function scheduleMemoryExtraction(
  ctx: AppContext,
  provider: LlmProvider,
  messages: readonly AgentMessage[],
): Promise<void> {
  extractionQueue = extractionQueue.then(async () => {
    try {
      await runMemoryExtraction(ctx, provider, messages);
    } catch (err) {
      console.error('[memory] 自动提取失败（不影响聊天）:', err instanceof Error ? err.message : err);
    }
  });
  return extractionQueue;
}
