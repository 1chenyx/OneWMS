import type { MemoryWorkspace } from '../memory.js';

/** core.memory 模块 id（settings 的落点） */
export const MEMORY_MODULE_ID = 'core.memory';

/** core.memory 模块设置读取结果：快照 Record<string, unknown> 窄化后的两键 */
export interface MemorySettings {
  /** 对话结束后自动提取记忆（后台静默执行，失败不断流） */
  autoMemory: boolean;
  /** 记忆总量上限：达到后 memory.save 拒绝（先遗忘再记录） */
  maxMemoryItems: number;
}

/**
 * 读 core.memory 模块设置（与 readWmsSettings 同模式：脏面窄化 + 兜底）。
 * 快照是脏面：老库无种子、慢通道可写任意值——非法/缺失回落代码缺省
 * （true / 200），保证「未配置 = 默认开启」。改值走 profile 慢通道
 * （propose → confirm），确认后下一轮对话即生效。
 */
export function readMemorySettings(ws: MemoryWorkspace): MemorySettings {
  const raw = ws.profile.getSnapshot().modules[MEMORY_MODULE_ID]?.settings ?? {};
  const mm = raw.maxMemoryItems;
  return {
    autoMemory: raw.autoMemory !== false,
    maxMemoryItems:
      typeof mm === 'number' && Number.isInteger(mm) && mm >= 1 ? mm : 200,
  };
}
