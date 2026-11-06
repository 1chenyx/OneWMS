/**
 * @one/memory —— AI 记忆领域包：分层记忆的事件账本、投影与工具。
 *
 *  - MemoryDomain / MemoryWorkspace  领域装配器 + 工作区门面（追账/重放）
 *  - memoryManifest                  core.memory 模块声明（settings 两键）
 *  - MemoryView / MemoryRecord       memory_item 投影与查询
 *  - createMemoryTools               memory.list / save / forget（工具总线）
 *  - events/catalog                  memory.item.* 事件类型与 payload
 *  - readMemorySettings              设置窄化兜底（autoMemory / maxMemoryItems）
 *
 * 分层纪律与每文件职责见 docs/ARCHITECTURE.md。
 */
export { MemoryDomain, MemoryWorkspace, memoryManifest } from './memory.js';
export type { MemoryWorkspaceResolver } from './tools/memory-tools.js';
export { createMemoryTools, MAX_MEMORY_CONTENT_LENGTH } from './tools/memory-tools.js';
export { MemoryView } from './views/memory-view.js';
export type { MemoryRecord } from './views/memory-view.js';
export {
  MEMORY_EVENT_TYPES,
  isMemoryEventType,
} from './events/catalog.js';
export type {
  MemoryEventType,
  MemoryItemSavedPayload,
  MemoryItemForgottenPayload,
  MemoryScope,
  MemorySource,
} from './events/catalog.js';
export { MEMORY_MODULE_ID, readMemorySettings } from './config/memory-settings.js';
export type { MemorySettings } from './config/memory-settings.js';
export { migrateMemory } from './db/migrations.js';
