import type { ToolDefinition } from '@one/core';
import { createInventoryTools } from './inventory-tools.js';
import { createLocationTools } from './location-tools.js';
import { createNumberingTools } from './numbering-tools.js';
import { createOrderConflictTools } from './order-conflict-tools.js';
import { createOrderTools } from './order-tools.js';
import { createPartnerTools } from './partner-tools.js';
import { createPickingTools } from './picking-tools.js';
import { createSkuTools } from './sku-tools.js';
import { createStocktakeTools } from './stocktake-tools.js';
import type { WorkspaceResolver } from './tool-def.js';

/**
 * 领域工具（DESIGN.md §4 宪法：AI 触碰业务数据的唯一通道）。
 *
 * 护栏模式（每个 write 工具三步，缺一不可）：
 *  1. ws.sync()——校验前先追账，投影读到的是最新事实；
 *  2. 业务校验——编码唯一 / SKU 存在 / 状态机合法 / 库存不为负；
 *  3. ctx.appendEvent——事件落账后再 sync()，返回值可携带新状态。
 * 校验失败绝不落事件（命令失败 ≠ 事实，§4.3）。
 *
 * 本文件只负责按既有顺序组合各领域工具。
 */
export function createWmsTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  return [
    ...createSkuTools(resolveWorkspace),
    ...createLocationTools(resolveWorkspace),
    ...createPartnerTools(resolveWorkspace),
    ...createOrderTools(resolveWorkspace),
    ...createOrderConflictTools(resolveWorkspace),
    ...createPickingTools(resolveWorkspace),
    ...createInventoryTools(resolveWorkspace),
    ...createStocktakeTools(resolveWorkspace),
    ...createNumberingTools(resolveWorkspace),
  ];
}
