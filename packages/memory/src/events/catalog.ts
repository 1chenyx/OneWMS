/**
 * 记忆领域事件目录（DESIGN.md §8.2 事件目录的 memory 子集）。
 *
 * 纪律（与 wms 领域一致）：
 *  - 类型全部**过去时**——事件是已发生的事实，不是命令；
 *  - 命名空间 `memory.实体.动作`；
 *  - payload 结构在此集中声明——投影与工具共用同一份类型，避免漂移。
 *
 * 记忆是 AI 的上下文资产（不是业务数据）：写入走工具总线（护栏 + 审计），
 * 事件经 oplog 同步/重放，与业务事件共用同一条账本基础设施。
 */
export const MEMORY_EVENT_TYPES = {
  itemSaved: 'memory.item.saved',
  itemForgotten: 'memory.item.forgotten',
} as const;

export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[keyof typeof MEMORY_EVENT_TYPES];

/** 判断事件类型是否属于本领域（投影分发的第一道过滤） */
export function isMemoryEventType(type: string): type is MemoryEventType {
  return Object.values(MEMORY_EVENT_TYPES).includes(type as MemoryEventType);
}

/** 记忆分层：personal = 用户个人偏好/习惯；project = 本仓库业务事实/约定 */
export type MemoryScope = 'personal' | 'project';

/**
 * 记忆来源（由工具 handler 从审计 actor 推导，不开放为工具参数——防伪标）：
 *  - auto   = 后台自动提取（actor 'ai:memory-auto@...'）
 *  - ai     = 对话中 AI 显式记录（actor 'ai:{助手id}@...'）
 *  - manual = 人工界面维护（其余 actor，如 'user:local@...'）
 */
export type MemorySource = 'auto' | 'ai' | 'manual';

/** memory.item.saved 的 payload（同 memoryId 再存 = 更新，投影 upsert） */
export interface MemoryItemSavedPayload {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly source: MemorySource;
}

/** memory.item.forgotten 的 payload（软删除语义：投影删行，历史留在事件流） */
export interface MemoryItemForgottenPayload {
  readonly memoryId: string;
}
