import { planConsolidation, type LlmProvider } from '@one/ai';
import type { AppContext } from './context.js';

/**
 * 记忆归并执行器（管理页「整理」与 T0 超预算自动压缩的共用落地面）。
 *
 * 计划由 @one/ai 的 planConsolidation 产出（纯逻辑，一次无工具 LLM 调用），
 * 本文件只负责**执行**：逐条经工具总线的 memory.rewrite 落账——护栏、审计、
 * 乐观并发令牌全部复用，绝不直写投影。
 *
 * 为什么必须串行（模块级 promise 链）：rewrite 带 baseLamport 令牌，两次归并
 * 并发时后者的计划基于旧令牌，一执行就被 TOOL_REJECTED 拒（白烧一轮 LLM）；
 * 与 memory-hook 的提取队列分开两条链——提取内触发的归并排进本队列即可，
 * 两条链不构成环（归并永不回调提取），无死锁。
 */

export interface ConsolidationStats {
  scope: 'personal' | 'project';
  /** 既有章节被整节覆盖的条数 */
  rewritten: number;
  /** 新建章节数（op.baseLamport === 0） */
  created: number;
  /** 删除章节数（工具返回 removed:true） */
  removed: number;
  /** 单条失败不中断其余条目，这里留痕（sectionKey + 错误消息） */
  failed: { sectionKey: string; message: string }[];
}

/** 串行链尾（并发整理排队：后到者等先到者完成） */
let consolidationQueue: Promise<unknown> = Promise.resolve();

/**
 * 执行一次归并（同步等待结果——管理页要立刻看到统计；自动压缩走同一入口）。
 * opts.scope 省略 = personal 与 project 都整理；actor 由调用方决定（人操作
 * user:local@nodeId / 自动 ai:memory-auto@nodeId），审计据此分辨来源。
 */
export function runMemoryConsolidation(
  ctx: AppContext,
  provider: LlmProvider,
  opts: { scope?: 'personal' | 'project'; actor: string },
): Promise<ConsolidationStats[]> {
  const task = consolidationQueue.then(() => consolidate(ctx, provider, opts));
  // 链尾吞掉错误：一次失败不该把后续整理全部堵在 rejected 链上
  consolidationQueue = task.catch(() => undefined);
  return task;
}

async function consolidate(
  ctx: AppContext,
  provider: LlmProvider,
  opts: { scope?: 'personal' | 'project'; actor: string },
): Promise<ConsolidationStats[]> {
  // 先追账：令牌与正文都必须是最新事实，否则计划一执行就被并发令牌拒
  ctx.memory.sync();
  const scopes: ('personal' | 'project')[] = opts.scope ? [opts.scope] : ['personal', 'project'];
  const out: ConsolidationStats[] = [];
  for (const scope of scopes) {
    const sections = ctx.memory.sections.list(scope);
    if (sections.length === 0) continue; // 空 scope 没有可整理的内容，不烧 token
    const stats: ConsolidationStats = { scope, rewritten: 0, created: 0, removed: 0, failed: [] };
    const plan = await planConsolidation(provider, sections);
    for (const op of plan?.rewrite ?? []) {
      try {
        const result = (await ctx.ws.tools.invoke('memory.rewrite', op, opts.actor)) as
          | { removed?: boolean }
          | undefined;
        if (op.baseLamport === 0) stats.created += 1;
        else if (result?.removed === true) stats.removed += 1;
        else stats.rewritten += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.failed.push({ sectionKey: op.sectionKey, message });
        console.error(`[memory] 归并 ${scope}/${op.sectionKey} 失败（忽略继续）: ${message}`);
      }
    }
    out.push(stats);
  }
  return out;
}
