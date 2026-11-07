# ToolBus AI 守门 + 分页查询工具（流水/单据/oplog）

## Context

AI 聊天功能目前存在数据量风险：所有查询工具均无分页/限制（`InventoryView.list()`、`OrderView.list()` 全量返回），工具结果原样注入 LLM 上下文。`wms_inventory_ledger`（流水）与 oplog（审计账本）都是 append-only 持续增长的表，随数据积累必然撑爆上下文。

本轮目标（报表/批量操作不在本轮范围）：
1. **ToolBus AI 守门**：AI 调用（actor 为 `ai:*`）的工具结果超预算时自动截断——全局兜底，一次改动保护所有现有及未来工具
2. **分页查询工具**：库存流水查询 `wms.ledger.query`、单据查询 `wms.order.query`、操作日志查询 `core.oplog.query`

## 现状关键事实（已核实）

- 工具总线 `ToolBus.invoke`：[packages/core/src/bus/tool-bus.ts:67-74](d:/my_project/demo/OneWMS/packages/core/src/bus/tool-bus.ts) — 只做存在性+参数校验，结果原样返回
- AI 调用路径 actor 固定为 `ai:{助手id}`：[packages/ai/src/wms-agent.ts:97,110,119](d:/my_project/demo/OneWMS/packages/ai/src/wms-agent.ts)；REST 路由用 `actorOf(ctx)`（非 ai 前缀）→ **按 actor 前缀守门不会误伤 REST 响应**
- 工具结果进 LLM 上下文：[packages/ai/src/agent.ts:94,210](d:/my_project/demo/OneWMS/packages/ai/src/agent.ts)（`messages.push({ role: 'tool-results', results })`），SSE `tool-result` 事件同 payload
- 新工具自动进入内置三件套助手（general/readonly/config 按权限展开）：[packages/ai/src/agent-defs.ts:56-84](d:/my_project/demo/OneWMS/packages/ai/src/agent-defs.ts) — **无需手工接线**
- core 自注册工具先例（profile.propose）：[packages/core/src/core.ts:48](d:/my_project/demo/OneWMS/packages/core/src/core.ts)、[packages/core/src/profile/propose-tool.ts](d:/my_project/demo/OneWMS/packages/core/src/profile/propose-tool.ts) — oplog 工具照此模式在 core 注册
- `wmsManifest(toolDefs)` 从工具定义派生，新工具自动进 manifest，声明面/事实面零重复
- 参数 schema 校验支持 `type: 'integer', minimum, maximum`（inventory-tools.ts:454 已在用）
- 读工具 handler 模式：`ws.sync()` → 查询 → 裁剪字段返回（见 inventory-tools.ts `wms.inventory.query`）
- 测试框架 vitest；core 测试样例 [packages/core/test/tools.test.ts](d:/my_project/demo/OneWMS/packages/core/test/tools.test.ts)，wms 测试在 packages/wms/test/

## 改动清单

### 1. ToolBus AI 守门（packages/core）

**新文件 `packages/core/src/bus/ai-result-guard.ts`**：
- 导出 `AI_RESULT_MAX_BYTES = 32_768`（32KB）与 `fitResultForAi(value, maxBytes)`
- 算法：
  1. `JSON.stringify` 失败（不可序列化）或结果 ≤ 预算 → 原样返回
  2. 顶层数组 → 保留能装进预算的前缀项，包装为 `{ items, totalItems, _truncated: true, _hint: '结果超出 AI 上下文预算已截断，请缩小查询范围或使用分页工具' }`
  3. 顶层对象 → 逐个属性检查，数组属性按剩余预算截断，记录被截断的键到 `_truncatedKeys`，附加 `_truncated: true, _hint`
  4. 兜底（巨字符串等无法装下）→ 返回 `{ error: 'TOOL_RESULT_TOO_LARGE', _hint }`

**修改 `packages/core/src/bus/tool-bus.ts` 的 `invoke()`**：
```ts
const result = tool.handler(params, ctx);
if (typeof ctx.actor === 'string' && ctx.actor.startsWith('ai:')) {
  return fitResultForAi(result, AI_RESULT_MAX_BYTES);
}
return result;
```
仅 AI actor 生效；REST 路由、memory-hook、内部调用不受影响。注释说明「宪法级护栏：AI 上下文预算」（引用 DESIGN.md §4 边界语义）。

**导出**：`core/src/index.ts` 补充导出 `fitResultForAi`、`AI_RESULT_MAX_BYTES`（供测试）。

### 2. 库存流水查询 `wms.ledger.query`（packages/wms）

**`packages/wms/src/views/inventory-view.ts`** 新增方法（放在 `ledgerOf` 旁，复用 `LedgerRecord` 与行映射）：
```ts
listLedgerPage(opts: {
  skuId?: string; locationId?: string; orderId?: string;
  from?: string; to?: string; limit: number; offset: number;
}): { rows: LedgerRecord[]; total: number }
```
- WHERE 逐条件拼接 + 同条件 COUNT；`ORDER BY created_at DESC, event_id DESC`（最新在前，审计习惯）
- 需为 `wms_inventory_ledger.order_id`、`created_at` 补索引（在 `packages/wms/src/db/migrations.ts` 的 `migrateWms` 中追加 `CREATE INDEX IF NOT EXISTS`——幂等，老库安全）

**`packages/wms/src/tools/inventory-tools.ts`** 新增工具（注册处 `return [...]` 追加 `def(ledgerQuery)`）：
- id `wms.ledger.query`，permission `'read'`
- 参数：`skuCode?`、`locationCode?`、`orderNo?`、`from?`、`to?`（ISO 时间字符串）、`limit`（integer 1..200 缺省 20）、`offset`（integer ≥0 缺省 0）
- handler：`ws.sync()` → 编码解析（`ws.skus.byCode` / 既有 `resolveLocation` / `ws.orders.byNo`，不存在则抛既有错误类型）→ `listLedgerPage`
- 返回统一分页壳：`{ total, limit, offset, hasMore, rows }`；行字段裁剪为 `createdAt, skuCode, locationCode, batchNo, delta, reason, orderNo`（orderId 经 `ws.orders.byId` 换算编码；工具内一次 Map 缓存避免 N 次查）
- description 写清楚：这是审计流水（每笔 ± 变动一事件一行），支持按 SKU/库位/单据/时间过滤

### 3. 单据查询 `wms.order.query`（packages/wms）

**`packages/wms/src/views/order-view.ts`** 新增（复用 `rowToRecord`）：
```ts
listPage(opts: { direction?: OrderDirection; state?: string;
  from?: string; to?: string; limit: number; offset: number }): { rows: OrderRecord[]; total: number }
```
- 同上：条件拼接 + COUNT；`ORDER BY created_at DESC`；`wms_order` 补 `(workspace_id, created_at)` 索引

**`packages/wms/src/tools/order-tools.ts`** 新增工具（注册处追加）：
- id `wms.order.query`，permission `'read'`
- 参数：`orderNo?`（单据号——给定时返回该单详情含明细行）、`direction?`、`state?`、`from?`、`to?`、`limit`、`offset`（同上约束）
- 单号模式：`ws.orders.byNo` + 复用 [packages/wms/src/queries/order-queries.ts:22](d:/my_project/demo/OneWMS/packages/wms/src/queries/order-queries.ts) 的 `withOrderLines`（含 SKU/往来单位联查）→ 返回完整 `OrderWithLines`（单号详情天然有限，不再截断）
- 列表模式：分页壳 `{ total, limit, offset, hasMore, rows }`，行裁剪为 `orderNo, direction, state, partnerCode, partnerName, lineCount, totalQuantity, createdAt, updatedAt`（行统计经 `ws.orders.lines(orderId)` 汇总）

### 4. 操作日志查询 `core.oplog.query`（packages/core）

**`packages/core/src/oplog/oplog-store.ts`** 新增（放在 `forEachEvent` 旁）：
```ts
listEventsPage(workspaceId: string, opts: {
  type?: string; actor?: string; from?: string; to?: string;
  limit: number; offset: number;
}): { rows: EventEnvelope[]; total: number }
```
- `ORDER BY created_at DESC, lamport DESC`；`oplog` 表补 `(workspace_id, created_at)` 索引（core migrations）
- `type` 支持精确匹配与前缀匹配：传 `wms.inventory` 匹配 `wms.inventory.*`（`type LIKE ? || '%'` 仅当以 `.` 结尾或不含完整事件名时——实现时简化为：参数 `type` 精确匹配，`typePrefix` 前缀匹配，二选一）

**新文件 `packages/core/src/oplog/oplog-query-tool.ts`**（模式照抄 propose-tool.ts）：
- id `core.oplog.query`，permission `'read'`
- 参数：`type?`、`typePrefix?`、`actor?`、`from?`、`to?`、`limit`（1..200 缺省 20）、`offset`
- 行裁剪：`eventId, type, actor, createdAt, lamport, payloadSummary`（`JSON.stringify(payload).slice(0, 300)`——审计场景足够识别，不回全文）
- 返回统一分页壳；description 说明这是全系统审计账本（谁在何时做了什么），只读

**`packages/core/src/core.ts`** 构造器注册：`this.#bus.register(createOplogQueryTool(this.#oplog))`（与 profile.propose 并列）。

### 5. 不需要改动的部分（已核实）

- `agent-defs.ts` 内置三件套按总线现状展开 → 新 read 工具自动进入 general/readonly/config 助手
- `wmsManifest` 从 `createWmsTools` 派生 → 新工具自动进声明面
- 前端聊天工具卡片按 `tool-result` 事件通用渲染 → 无需前端改动
- 既有 `wms.inventory.query` 等全量工具暂不改造——ToolBus 守门兜底（后续优化项）

## 实现顺序

1. core：ai-result-guard.ts + tool-bus.ts invoke 接线 + index.ts 导出 + tools.test.ts 补守门用例
2. core：OplogStore.listEventsPage + 索引 + oplog-query-tool.ts + core.ts 注册 + 测试
3. wms：InventoryView.listLedgerPage + 索引 + wms.ledger.query 工具 + 测试
4. wms：OrderView.listPage + 索引 + wms.order.query 工具 + 测试
5. 全量验证

## 验证

- `npm run test -w @one/core -w @one/wms`（新增用例 + 全量回归）
- `npm run typecheck`（全 workspace）
- 新增测试用例：
  - core/test/tools.test.ts：`ai:*` actor 调用返回大数组的工具 → 结果被截断且带 `_truncated`；非 ai actor → 原样返回；守门对 ≤ 预算结果零侵入
  - core：oplog 追加若干事件 → `core.oplog.query` 按 type/actor/时间过滤、分页 total/hasMore 正确、payloadSummary 截断
  - wms：造库存流水（adjust 多次）→ `wms.ledger.query` 按 skuCode/orderNo/时间过滤、分页正确、行含 orderNo；`wms.order.query` 列表分页 + orderNo 详情含 lines
  - 端到端冒烟：dev server 起后在 AI 对话中问「最近有哪些库存变动」「SO-001 单据的明细」「今天 ai 助手做过什么操作」，确认三个新工具可被 AI 选用
