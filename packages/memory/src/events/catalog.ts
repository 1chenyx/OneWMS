/**
 * 记忆领域事件目录（DESIGN.md §8.2 事件目录的 memory 子集）。
 *
 * 纪律（与 wms 领域一致）：
 *  - 类型全部**过去时**——事件是已发生的事实，不是命令；
 *  - 命名空间 `memory.实体.动作`；
 *  - payload 结构在此集中声明——投影与工具共用同一份类型，避免漂移；
 *  - payload 不装全量快照之外的东西：一个章节 = 一次写入的完整正文
 *    （章节是记忆的原子单位，正文即事实本身，不是「大对象」）。
 *
 * v2 形态（章节级 markdown 账本）：记忆不再是一条条散句，而是一篇篇
 * 有标题、有摘要、有关键词的 markdown 章节——AI 常驻只读目录，按需取全文。
 * 事件仍是唯一真相，投影（memory_section）是可丢的缓存。
 */
export const MEMORY_EVENT_TYPES = {
  /** 章节写入（新建或整节覆盖；投影按 scope+sectionKey upsert） */
  sectionUpdated: 'memory.section.updated',
  /** 章节移除（正文清空的语义；历史留在事件流） */
  sectionRemoved: 'memory.section.removed',
  /**
   * v1 遗留事件类型：**只被投影识别、不再产生**。
   * 老库里已有的条目事件在重放时被投影进 `legacy-*` 章节（人审后归并/删除）——
   * 事件不可改写，兼容只能发生在投影侧。
   */
  itemSaved: 'memory.item.saved',
  itemForgotten: 'memory.item.forgotten',
} as const;

export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[keyof typeof MEMORY_EVENT_TYPES];

/** 判断事件类型是否属于本领域（投影分发的第一道过滤，含 v1 遗留类型） */
export function isMemoryEventType(type: string): type is MemoryEventType {
  return Object.values(MEMORY_EVENT_TYPES).includes(type as MemoryEventType);
}

/** 记忆分层：personal = 用户个人偏好/习惯；project = 本仓库业务事实/约定 */
export type MemoryScope = 'personal' | 'project';

/**
 * 章节键（AI 与人共用的稳定标识，如 `sku-characteristics`）：
 * 小写字母/数字/连字符，2–48 位——工具参数校验与投影唯一键共用同一规则。
 */
export const SECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** v1 条目事件的收容章节（每 scope 一个；人审归并后删除） */
export const LEGACY_SECTION_KEY: Record<MemoryScope, string> = {
  personal: 'legacy-personal',
  project: 'legacy-project',
};

/** memory.section.updated 的 payload（同 scope+sectionKey 再写 = 整节覆盖） */
export interface MemorySectionUpdatedPayload {
  /** 章节主键（uuid；同键重写时由写入方沿用原 id，多节点冲突以最后事件为准） */
  readonly sectionId: string;
  readonly scope: MemoryScope;
  readonly sectionKey: string;
  /** 章节标题（≤60 字，常驻目录与正文小标题都用它） */
  readonly title: string;
  /** 章节正文（markdown，完整覆盖语义） */
  readonly bodyMd: string;
  /** 一句话摘要（常驻目录的那一行；≤120 字） */
  readonly summary: string;
  /** 检索关键词（含简称与别名；按需预取的判据，≤8 个） */
  readonly keywords: readonly string[];
}

/** memory.section.removed 的 payload（自然键定位——章节没有跨节点稳定 id 语义） */
export interface MemorySectionRemovedPayload {
  readonly scope: MemoryScope;
  readonly sectionKey: string;
}

/** v1 遗留：memory.item.saved 的 payload（仅重放兼容） */
export interface MemoryItemSavedPayload {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly source: 'auto' | 'ai' | 'manual';
}

/** v1 遗留：memory.item.forgotten 的 payload（仅重放兼容） */
export interface MemoryItemForgottenPayload {
  readonly memoryId: string;
}
