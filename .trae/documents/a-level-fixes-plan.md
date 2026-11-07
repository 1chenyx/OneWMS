# A 级硬伤修复计划：单据打印 / SKU 软停用 / 单位字段

## Context

上一轮"挑刺"评审确认：修完 4 项一票否决级问题后，项目已可真用，但仍剩 3 条 A 级问题（每天会卡住日常）：

1. **A1 单据打不出来**：全项目只有条码标签能打印，拣货/出入库没有纸质输出——个人仓库无 PDA，拣货要端着电脑走。
2. **A2 建错的档案永远删不掉**：无 sku.delete/archive/status，错误 SKU 永久污染列表与搜索。
3. **A3 数量没有单位**：小数功能落地后，"3.5"是 3.5 什么？散装称重用户在单据/标签上看不到单位。

用户已拍板：打印范围 = **拣货单 + 出入库单**（盘点暂不做）；停用语义 = **软停用**（隐藏 + 排除选择器 + 关预警，存量照常可扣，不加操作校验）。手机端继续延后。

核心设计决策（两探索代理 + 一规划代理已核实全部落点）：

- **status 与 unit 合并一次迁移**（同批文件，dropAll 重建一次、破一次测试）。
- **不新增事件类型**：archive/unarchive 复用 `skuUpdated` 的 LWW COALESCE 语义，上面挂两个薄工具；投影零新分支。
- **`status` 声明为可选字段**（`SkuRecord.status?: string`）：老事件重放、测试 fixture 字面量不破，消费端统一 `?? 'active'`。
- **A1 不抽公共 PrintSheet**：照 LabelsPage 先例各页内联 `@media print` 块；零新依赖（本机 npm install EBUSY 不可用）。

---

## 阶段 0：共享后端底座（status + unit 一次迁移）

| 文件 | 改动 |
|---|---|
| `packages/wms/src/events/catalog.ts` | `SkuCreatedPayload` + `unit?: string`；`SkuUpdatedPayload` + `unit?: string`、`status?: 'active'\|'archived'` |
| `packages/wms/src/db/migrations.ts` | L51-57 缺列检测加 `status`/`unit`；DDL（L75-87）加 `status TEXT NOT NULL DEFAULT 'active'`、`unit TEXT`（复用 dropAll + sync 全量重放） |
| `packages/wms/src/views/sku-view.ts` | `SkuRecord` 加 `status?: string`、`unit?: string\|null`（可选声明）；created INSERT 9→11 列（status='active'，unit=`p.unit ?? null`）；updated COALESCE 加两列；rowToRecord 带出 |
| `packages/wms/src/tools/sku-tools.ts` | skuCreate/skuUpdate schema 加 `unit`（可选，status **不**开放给通用 update）；新增 `wms.sku.archive` / `wms.sku.unarchive`（params `{skuCode}`，已停用再停 = 零事件直接返回，照 L68-122 结构 appendEvent skuUpdated 带 status）；L146 注册数组追加 |
| `packages/server/src/routes/wms.ts` | `POST /skus/:skuCode/archive`、`POST /skus/:skuCode/unarchive`（照 L114-123 path 参数注入模式） |

测试：`packages/wms/test/sku.test.ts` 加「archive→unarchive 重放收敛」「老库事件流 dropAll 重建后 status 收敛 active / unit 为 null」（照 L209/L357 老库收敛写法）、「unit 走 LWW：传则改不传不改」。

## 阶段 1：A2 软停用全链路

| 文件 | 改动 |
|---|---|
| `packages/server/src/routes/wms.ts` GET /skus | **默认只回 active**，`?includeArchived=1` 回全量；**barcode 精确查询分支不过滤**（扫码定位语义）。收敛在 route 层 → 三个 SKU 下拉零改动自动排除 |
| `packages/wms/src/tools/inventory-tools.ts` | lowstock L416-423 filter 加 `(s.status ?? 'active') === 'active'`；expiring L467 逐桶同滤 |
| `packages/wms/src/queries/dashboard-queries.ts` L33 | skuCount 只计 active |
| `packages/app/src/api/wms-api.ts` | `Sku` + `status?: string`；`archiveSku` / `unarchiveSku`；`skus()` 支持 includeArchived 参数 |
| `packages/app/src/api/hooks.ts` | useArchiveSku / useUnarchiveSku（照 useUpdateSku L29；invalidate ['skus'] 全前缀含带参 key） |
| `packages/app/src/pages/SkusPage.tsx` | 状态 Tag 列（启用/已停用）、操作列停用/启用（Popconfirm）、「显示已停用」开关切 includeArchived |
| `packages/app/src/pages/DataPortPage.tsx` L201 | 导入比对请求加 includeArchived=1（需全量） |

不过滤的点（软停用语义）：InventoryPage L26 / StocktakePage L273 扫码定位、库存扣减、DataPort 导出比对。

测试：`ai/test/wms-agent.test.ts` L115-149 工具数组按序插 `'wms.sku.archive'`、`'wms.sku.unarchive'`；`server/test/wms-routes.test.ts` 加 archive 路由 + GET /skus 默认隐藏/includeArchived 用例；inventory 预警测试加「archived 不进 lowstock/expiring」；dashboard 加「archived 不计 skuCount」。

## 阶段 2：A3 unit 全链路

后端联查（均已 `ws.skus.byId`，各加一行 + 接口字段）：

- `packages/wms/src/queries/inventory-queries.ts`：InventorySummaryRow L5-13 + 组装 L20-27；getExpiryBoard L125-135/L173-183
- `packages/wms/src/queries/picking-queries.ts`：PickingLineWithMeta L5-10 + L23-29
- `packages/wms/src/queries/stocktake-queries.ts`：StocktakeLineState L32-39、StocktakeDetail.lines L67-77（L48/L85 两处映射）
- `packages/server/src/routes/wms.ts` L190-207：buckets map 加 unit（CSV 导出带单位）
- `packages/wms/src/queries/order-queries.ts` L26-32：lines 加 `unit: sku?.unit ?? null` **和 `batchExpiryDate: line.batchExpiryDate ?? null`**（OrderLineRecord L42 有此字段但未映射——出入库单打印要效期列，此处一并补齐）

前端：

- 新增 `packages/app/src/lib/format.ts`：`fmtQty(q, unit?)`（unit 空返原值字符串）——约 10 行共享，不做更多抽象
- `wms-api.ts`：OrderLine / PickingLine / 盘点明细 / ExpiryBatchRow / InventoryRow 同步加 `unit?: string | null`
- 渲染点全套 fmtQty：InventoryPage L65-100 三列、OrdersPage L198-205、StocktakePage L339-382 四列、ExpiryPage L93-100 + L166-173、PickingsPage L307/L310-318
- `SkusPage.tsx`：加「单位」列（'-' 兜底）；`SkuFormModal.tsx` 加可选单位 Input（空 = 不提交，照 reorderPoint 惯例）
- `LabelsPage.tsx`：L145-150 加「印单位」Checkbox（默认关），标签渲染尾拼 unit
- `DataPortPage.tsx`：SKU_HEADERS 尾加'单位'；COLUMN_ALIASES 加 unit 别名（单位/unit）；ImportRow + 导出行 + 提交体（`unit: row.unit || undefined`）+ 预览列；handleFile 不加强校验（老文件缺列天然兼容）

测试：manage.test.tsx fixture s-1 加 `unit: '个'`，用例 1 加单位列断言，用例 2 六键 toHaveBeenCalledWith 变七键（+`unit: '个'`）；csv.test.ts 加「导出含单位列 / 导入别名映射单位」。

## 阶段 3：A1 打印（纯前端，最后做）

- `PickingsPage.tsx`：操作列加「打印」→ state 挂载 `#picking-print-area`（**仅打印态渲染**）：表头（拣货单号/日期/备注），行**按 suggestedLocationCode 排序**，列 = 勾选框□ / SKU / 名称 / 建议库位 / 建议批次 / 应拣量(fmtQty) / 已拣；底部「拣货人签字____ 日期____」；`@media print` 块照 LabelsPage L197-205（@page 适配 A4）；doPrint 照抄 L80-87（setTimeout 60ms），onafterprint 清 state
- `OrdersPage.tsx`：加「打印」→ `#order-print-area`：表头（单号 / 入库单|出库单 / 日期 / 往来单位 partnerName / 备注），列 = SKU / 名称 / 数量(fmtQty) / 批次 / 库位，入库单按 direction 加「效期」列；底部「签收人签字____ 日期____」
- 关键约束：两个 print-area **不可同时在 DOM**（`body * { visibility: hidden }` 全局生效，同现会互相隐藏）——print state 置空时机用 onafterprint
- 测试：app 测试加 describe「单据打印」：`vi.spyOn(window, 'print')`，点打印按钮断言单据表头/签字栏入 DOM 且 window.print 被调

## 阶段 4：测试收口

PowerShell（无 &&），逐条跑：

```powershell
npm test --workspace @one/wms
npm test --workspace @one/server
npm test --workspace @one/app
npm test --workspace @one/ai
npm run typecheck
```

重点回归：wms `boundaries.test.ts`（工具命名约束）、`end-to-end.test.ts`。

## 风险与顺序说明

- **先红后绿**：wms-agent 工具清单断言在注册工具后立即红（补两行绿）；manage 用例 2 六键断言在表单加单位后红（改七键绿）；SkuRecord 若误声明 status 必填会大面积 TS 红——可选声明规避。
- **A1 放最后**：纯前端 + 只读字段，吃到 A3 的 unit 数据形状后打印模板一次成型不返工。
- **GET /skus 默认过滤是行为变化**：既有 server 测试 fixture 无 status（视为 active 照常返回）不破；DataPort 比对必须带 includeArchived 否则误报"新建"。
- **零新依赖**：打印用原生 window.print + antd，绕开本机 npm install EBUSY 限制。
