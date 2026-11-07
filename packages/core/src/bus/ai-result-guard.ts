/**
 * AI 结果守门（DESIGN.md §4 宪法级护栏：AI 上下文预算）。
 *
 * AI 经工具总线拿到的数据必须装进有限的上下文窗口——查询类工具若全量返回
 * （流水账本、审计 oplog 都是 append-only 持续增长表），结果会撑爆上下文。
 * 本护栏在 ToolBus 层按 actor 前缀（'ai:*'）生效：
 *  - REST 路由 / 内部调用不受影响（它们的结果面向 HTTP 响应，不是 LLM）；
 *  - 超预算的结果按「数组截断优先」策略收缩，并附带 _truncated 标记与提示，
 *    让模型知道数据被裁了、该缩小范围或改用分页工具。
 * 只读、不解释业务语义——截断是通道护栏，不是业务校验。
 */

/** AI 工具结果预算：32KB（JSON 序列化后字节数） */
export const AI_RESULT_MAX_BYTES = 32_768;

const TRUNCATION_HINT =
  '结果超出 AI 上下文预算已截断，请缩小查询范围（加过滤条件）或使用分页参数翻页查看';

interface FitOutcome {
  value: unknown;
}

/** 序列化字节数；不可序列化（BigInt/循环引用等）返回 -1 */
function byteSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return -1;
  }
}

/**
 * 把数组截断到能装进预算的前缀（贪心：逐项累加序列化长度）。
 * 返回 null 表示整项都装不下（调用方走兜底）。
 */
function truncateArray(items: unknown[], budget: number): { prefix: unknown[]; cut: boolean } | null {
  const prefix: unknown[] = [];
  let used = 2; // '[]'
  for (const item of items) {
    const size = byteSize(item);
    if (size < 0) return { prefix, cut: true };
    if (used + size + (prefix.length > 0 ? 1 : 0) > budget) {
      return { prefix, cut: true };
    }
    prefix.push(item);
    used += size + 1;
  }
  return { prefix, cut: false };
}

/**
 * 拟合工具结果到 AI 预算：
 *  1. 不可序列化或 ≤ 预算 → 原样返回（零侵入）；
 *  2. 顶层数组 → 保留前缀并包装 { items, totalItems, _truncated, _hint }；
 *  3. 顶层对象 → 截断超预算的数组属性，记录 _truncatedKeys；
 *  4. 兜底（非数组结构装不下）→ { error: 'TOOL_RESULT_TOO_LARGE', _hint }。
 */
export function fitResultForAi<T>(value: T, maxBytes: number = AI_RESULT_MAX_BYTES): T | (Record<string, unknown> & T) {
  const size = byteSize(value);
  if (size >= 0 && size <= maxBytes) return value;
  if (size < 0) {
    return { error: 'TOOL_RESULT_NOT_SERIALIZABLE', _truncated: true, _hint: TRUNCATION_HINT } as never;
  }

  if (Array.isArray(value)) {
    const fit = truncateArray(value, Math.max(0, maxBytes - 256)); // 预留包装元数据的开销
    if (fit && fit.prefix.length > 0) {
      return {
        items: fit.prefix,
        totalItems: value.length,
        _truncated: true,
        _hint: TRUNCATION_HINT,
      } as never;
    }
    return { error: 'TOOL_RESULT_TOO_LARGE', _truncated: true, _hint: TRUNCATION_HINT } as never;
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 预算内逐属性处理：数组属性装不下则截断，其余原样保留
    let used = 2; // '{}'
    const truncatedKeys: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const valSize = byteSize(val);
      if (valSize >= 0 && used + valSize + (Object.keys(out).length > 0 ? 1 : 0) <= maxBytes - 256) {
        out[key] = val;
        used += valSize + 1;
        continue;
      }
      if (Array.isArray(val)) {
        const remaining = Math.max(0, maxBytes - 256 - used - key.length - 6);
        const fit = truncateArray(val, remaining);
        if (fit && fit.prefix.length > 0) {
          out[key] = fit.prefix;
          truncatedKeys.push(key);
          used += byteSize(fit.prefix) + key.length + 6;
          continue;
        }
      }
      truncatedKeys.push(key); // 装不下的属性直接缺失（_truncatedKeys 记名）
    }
    if (truncatedKeys.length === 0) return value; // 逐属性合计其实装得下（原样返回更友好）
    return {
      ...out,
      _truncated: true,
      _truncatedKeys: truncatedKeys,
      _hint: TRUNCATION_HINT,
    } as never;
  }

  // 巨字符串/巨数字等：无法结构化收缩，直接拒绝
  return { error: 'TOOL_RESULT_TOO_LARGE', _truncated: true, _hint: TRUNCATION_HINT } as never;
}
