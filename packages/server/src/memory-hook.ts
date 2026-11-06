import { extractMemoryPlan, type AgentMessage, type LlmProvider } from '@one/ai';
import { readMemorySettings } from '@one/memory';
import type { AppContext } from './context.js';

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
 *  - autoMemory 设置关闭时零成本跳过（不发起 LLM 调用）。
 */

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
 * 设置开关 → 取本轮对话 → 提取计划 → 逐条经工具总线落账。
 */
export async function runMemoryExtraction(
  ctx: AppContext,
  provider: LlmProvider,
  messages: readonly AgentMessage[],
): Promise<void> {
  const settings = readMemorySettings(ctx.memory);
  if (!settings.autoMemory) return;

  const userText = lastText(messages, 'user');
  const assistantText = lastText(messages, 'assistant');
  if (!userText.trim() || !assistantText.trim()) return;

  const plan = await extractMemoryPlan(provider, {
    userText,
    assistantText,
    memories: ctx.memory.memory.list(),
  });
  if (!plan || (plan.save.length === 0 && plan.forget.length === 0)) return;

  const actor = `ai:memory-auto@${ctx.core.nodeId}`;
  for (const f of plan.forget) {
    try {
      await ctx.ws.tools.invoke('memory.forget', { memoryId: f.memoryId }, actor);
    } catch (err) {
      console.error(`[memory] 自动遗忘失败（${f.memoryId}，忽略继续）:`, err instanceof Error ? err.message : err);
    }
  }
  for (const s of plan.save) {
    try {
      await ctx.ws.tools.invoke('memory.save', { scope: s.scope, content: s.content }, actor);
    } catch (err) {
      console.error(`[memory] 自动保存失败（忽略继续）:`, err instanceof Error ? err.message : err);
    }
  }
}

/** 排队执行一轮提取（chat 路由 fire-and-forget 入口）；返回链尾供测试 await */
export function scheduleMemoryExtraction(
  ctx: AppContext,
  provider: LlmProvider,
  messages: readonly AgentMessage[],
): Promise<void> {
  extractionQueue = extractionQueue.then(() =>
    runMemoryExtraction(ctx, provider, messages).catch((err) => {
      console.error('[memory] 自动提取失败（不影响聊天）:', err instanceof Error ? err.message : err);
    }),
  );
  return extractionQueue;
}
