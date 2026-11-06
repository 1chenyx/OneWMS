# P0 功能实施方案：上架 / 往来单位主数据 / 拣货单 / 运营 Dashboard

## Context

与 GreaterWMS 对比后确认补齐 4 个 P0 模块：②上架（Putaway）、③供应商/客户主数据、④拣货单、⑤运营 Dashboard。用户硬性要求：

- **流程必须可配置**——融入现有 Profile workflows / 模块系统，不硬编码流程
- **Dashboard 要为后续多维度查看做好架构规划**

已确认的决策：统一 partner 实体（kind 区分供应商/客户）；拣货关单时统一扣减；Dashboard 不引图表依赖（Antd 原生）。

架构铁律（必须遵守，见 docs/DESIGN.md §4 与 docs/ARCHITECTURE.md）：事件是唯一真相、投影唯一写路径是 `XxxView.applyEvent`、命令侧校验在工具 handler（拒绝路径零事件）、表 `wms_` 前缀 + uuid 主键 + workspace_id、多事件 `ws.runAtomic()` 原子包裹、新公共 API 必须同步更新 ARCHITECTURE.md。

---

## 0. 前置：`when` 条件运行时求值（流程可配置的地基）

现状：`WorkflowTransition.when`（如 `module.putaway.enabled`）只有 patch 时静态校验（`packages/core/src/profile/validate.ts`），**运行时无人求值**——配置了条件也不生效。

1. **core 新增** `packages/core/src/profile/when.ts`：
   ```ts
   export function evalWhenCondition(
     when: string | undefined,
     modules: Record<string, ModuleConfig>,
   ): boolean
   ```
   规则：`undefined` → true；`module.{id}.enabled` → modules[id]?.enabled === true；`!module.{id}.enabled` → 取反；无法识别 → false（保守）。从 `packages/core/src/index.ts` 导出。
2. **wms 消费**：`packages/wms/src/tools/order-tools.ts` 的 transition handler（L177-179 处），`assertTransition` 前先按 `evalWhenCondition` 过滤 `workflow.transitions`（条件不满足的转移视为不存在）。
3. **app 消费**：`packages/app/src/pages/OrdersPage.tsx` 的 `nextStates()`（L199-203）同样过滤——app 不允许 runtime import core，在 app 内写 6 行等价小函数（注明与 core 语义同步）。
4. core 测试 `packages/core/test/when.test.ts`：真/假/取反/未装模块/未识别模式。

## 1. Partner 往来单位主数据（统一实体）

**表** `wms_partner`（`packages/wms/src/db/migrations.ts`）：

```sql
CREATE TABLE IF NOT EXISTS wms_partner (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  partner_code TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('supplier','customer')),
  name TEXT NOT NULL, contact TEXT, phone TEXT, address TEXT, note TEXT,
  ext_data TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT,
  UNIQUE (workspace_id, partner_code)
);
CREATE INDEX IF NOT EXISTS idx_wms_partner_ws ON wms_partner (workspace_id);
```

**老库升级**（关键）：`wms_order` 加 `partner_id TEXT` 列 → 在 migrations.ts 增加第 4 道 pragma 检测（`table_info(wms_order)` 无 `partner_id` → `dropAll()` 整组重建），并把 `wms_partner`、`wms_picking`、`wms_picking_line` 加入 dropAll 清单。

**事件**（`packages/wms/src/events/catalog.ts`）：`wms.partner.created` / `wms.partner.updated` + payload 接口（`PartnerCreatedPayload` 等，字段同表，created 携带全量、updated 只携带变更字段）。

**投影** `packages/wms/src/views/partner-view.ts`：仿 `sku-view.ts`——applyEvent（byId 查重幂等；update 为 UPDATE 已登记字段）+ `byCode/byId/list(kind?)`。挂进 `views/wms-projections.ts`（applyEvent 分发 + `clear()` DELETE），`wms.ts` 暴露 `readonly partners`。

**工具**（`packages/wms/src/tools/partner-tools.ts`，仿 sku-tools.ts 三步护栏）：
- `wms.partner.create`（code/kind/name 必填，code 查重 `WMS_PARTNER_EXISTS`）
- `wms.partner.update`（按 partnerCode，改名/联系方式等）
- `wms.partner.resolve`（read，code → 档案）

**订单关联**：
- `wms.order.create` 增可选参数 `partnerCode`；校验存在 + 方向匹配（in↔supplier / out↔customer，不匹配抛 `WMS_PARTNER_KIND_MISMATCH`）
- `OrderCreatedPayload` 增 `partnerId?: string`；`wms_order.partner_id` 列
- `packages/wms/src/queries/order-queries.ts` 联查补 `partnerCode/partnerName` 展示字段

**错误**（`packages/wms/src/errors.ts`）：`WMS_PARTNER_EXISTS / WMS_PARTNER_NOT_FOUND / WMS_PARTNER_KIND_MISMATCH`。

**路由**（`packages/server/src/routes/wms.ts`）：`GET /api/partners?kind=&q=`（仿 skus 的 q 模糊过滤）、`POST /api/partners`（201）、`PUT /api/partners/:partnerCode`。

**前端**：`packages/app/src/pages/PartnersPage.tsx`（克隆 SkusPage：Segmented 切换 supplier/customer + `PartnerFormModal`）；OrdersPage 建单表单加往来单位 Select（按方向过滤 kind）、列表/详情加列。`app-nav.tsx` Page 加 `'partners'`，App.tsx 菜单与 skus 同组相邻。

## 2. 上架 Putaway（module.putaway 贡献流程状态）

**设计**（零语义破坏）：上架 = 入库流程 `received` 之后的**可选确认+归位步骤**。收货落账行为完全不变（仍按行库位入库）；进入 `putaway` 状态时可选地为行**改派目标库位**（一对 transfer 流水，reason `putaway:{orderNo}`），不改目标的行只做确认。模块停用 → 无 `putaway` 状态，老流程原样。

**新 manifest** `packages/wms/src/putaway-manifest.ts`（module id `module.putaway`，name 上架作业，version 0.1.0）：
- `workflows.contributes.inbound`：
  - states: `[{ id: 'putaway', label: '已上架' }]`
  - transitions: `[{ from: 'received', to: 'putaway', when: 'module.putaway.enabled' }, { from: 'putaway', to: 'done' }]`
- `tools`: `[wms.order.putaway]`（detachHandler）
- 依赖 `dependencies: { modules: ['core.wms'] }`

**装配**（`packages/wms/src/wms.ts`）：工具 partition——putaway 工具不进 `core.wms` manifest 的 tools 数组（否则双声明）；WmsWorkspace 构造期 install core.wms 后再 install module.putaway，**try/catch 降级**（老库若自定义过 inbound 流程导致贡献校验失败，跳过安装并 log，上架不可用但不阻塞打开）。

**工具 `wms.order.putaway`**（`packages/wms/src/tools/putaway-tools.ts`）：
- params：`{ orderNo, targets?: [{ skuCode, fromLocationCode, batchNo, toLocationCode }] }`
- handler：sync → 订单存在、direction='in'、state='received' → inbound workflow 过滤 when 后 `assertTransition('received','putaway')` → 每个 target 匹配行（sku+源库位+批次 = 行四段键前三段）→ 目标 `resolveLocation` → 守卫：源桶余量 ≥ 行数量（不足抛 `WMS_PUTAWAY_SOURCE_SHORT`）→ `ws.runAtomic`：一条 `orderStateChanged(received→putaway)` + 每个 target 行两条 `inventoryAdjusted`（−源/+目标，reason `putaway:{orderNo}`，批次/效期保留，带 orderId/orderNo）
- 无 targets = 纯确认步骤（只有状态事件）；通用 `wms.order.transition(to='putaway')` 天然兼容（`stockEffectOf` 对 putaway 无效应定义，无需改）
- 错误：`WMS_PUTAWAY_LINE_NOT_FOUND / WMS_PUTAWAY_SOURCE_SHORT / WMS_PUTAWAY_ONLY_INBOUND`

**前端**（OrdersPage）：`nextStates()` 含 `putaway` 时流转按钮打开 `PutawayModal`——行表格（每行：SKU/批次/当前库位/目标库位 Select 默认=行库位），确认后调新工具；不改目标可直接走通用 transition。

**测试** `packages/wms/test/putaway.test.ts`：模块安装贡献状态 + when 过滤生效（停用后转移非法）/ 无 targets 纯确认 / 带 targets 归位流水正确 / 源桶不足拒绝 + 零事件 / replay 重建 / 老库（partner_id 检测触发 dropAll 后重装）。

## 3. 拣货单 Picking（stocktake 模式实体 + 关单统一扣减）

**表**：
```sql
wms_picking (id, workspace_id, picking_no UNIQUE, note, state TEXT, ext_data, created_at, updated_at)
  -- state: created | closed | canceled（固定生命周期，不进 Profile workflows——M17 先例）
wms_picking_line (id TEXT PK = pickingId:orderLineId, workspace_id, picking_id,
  order_id, order_no, order_line_id, sku_id, qty_to_pick,
  suggested_location_id, suggested_batch_no,
  picked_qty INTEGER NOT NULL DEFAULT 0, picked_location_id, picked_batch_no,
  created_at, updated_at, UNIQUE (workspace_id, picking_id, order_line_id))
```

**事件**：`wms.picking.created`（payload：单头 + 行数组，行含建议桶）/ `wms.picking.picked`（lineId、pickedQty、实际桶）/ `wms.picking.closed` / `wms.picking.canceled`。**禁冗余快照**：建议桶在 created 事件携带（事实），实拣只记增量。

**投影** `picking-view.ts`：applyEvent（picked → UPDATE 行 picked_*）+ `byNo / withLines / list(state?) / lines(pickingId)`。挂 wms-projections + clear() + wms.ts 暴露 `pickings`。

**守卫提取**（重构）：把 `order-tools.ts` L201-245 的出库守卫（过期拦截/逐桶余量/SKU 冻结聚合）提取为 `packages/wms/src/state/outbound-guards.ts` 纯函数 `assertOutboundBuckets(ws, rows)`，order-tools 与 picking-tools 共用（行为不变，现有测试兜底）。

**分配建议提取**：把 `expandAllocatedLines` 的批次分配逻辑（strict/fifo/fefo，`batchesOf` 数据源）提取为 `packages/wms/src/state/allocation.ts`，拣货单建议桶复用。

**工具**（`picking-tools.ts`）：
- `wms.picking.create({ orderNos: string[], note? })`：每单须 direction='out' 且 state='picking'（否则 `WMS_PICKING_ORDER_STATE`）；逐行生成建议桶（行有库位+批次→该桶；无→按 defaultAllocation 分配）；单号 `PK-YYYYMMDD-uuid8`
- `wms.picking.pick({ pickingNo, orderNo, skuCode, batchNo, pickedQty, locationCode?, pickedBatchNo? })`：校验 open + 余量待拣；默认用建议桶，允许改实际桶；落 picked 事件
- `wms.picking.close({ pickingNo })`：全部行拣满（否则 `WMS_PICKING_INCOMPLETE`）；逐单 outbound workflow 过滤 when 后 `assertTransition(订单态,'shipped')`；`assertOutboundBuckets` 以**实拣桶**校验；`runAtomic`：每单 `orderStateChanged(→shipped)` + 每行 `inventoryAdjusted`（−pickedQty @ 实拣桶，reason `picking:{pickingNo}`）+ `pickingClosed`
- `wms.picking.cancel({ pickingNo })`：open 才可（已拣记录保留审计；订单留在拣货中人工处理）
- `wms.picking.query({ pickingNo? })`（read）

**错误**：`WMS_PICKING_NOT_FOUND / WMS_PICKING_NOT_OPEN / WMS_PICKING_LINE_NOT_FOUND / WMS_PICKING_INCOMPLETE / WMS_PICKING_ORDER_STATE / WMS_PICKING_NO_ORDERS`。

**路由**：`GET /api/pickings?state=`、`POST /api/pickings`、`GET /api/pickings/:no`（withLines）、`POST /api/pickings/:no/pick|close|cancel`（全仿 stocktakes 路由，wms.ts L98-136）。

**前端** `PickingsPage.tsx`（仿 StocktakePage）：列表 + 创建弹窗（多选「拣货中」出库单）+ 详情抽屉（行表：建议桶/实拣数量/实拣库位/实拣批次输入）+ 关单/取消按钮。Page `'pickings'`，菜单「作业」组。

**测试** `packages/wms/test/picking.test.ts`：创建（建议桶分配 fifo/fefo）/拣货/关单自动 ship + 扣减流水 / 守卫拒绝（未拣满、余量不足、冻结、过期拦截）/ 取消 / replay / 断言「拣货事件先于扣减事件」全序。

## 4. 运营 Dashboard（多维度架构）

**架构原则**：一个维度 = 一个独立查询函数 + 一个独立端点 + 一个 queryKey 前缀段，前端一个 Tab。维度间互不耦合，后续加维度零改造。

**后端** `packages/wms/src/queries/dashboard-queries.ts`（纯函数，只组合 View API）：
1. `getDashboardOverview(ws)`：skuCount/locationCount/batchCount/totalUnits、lowStockCount、expiringByLevel（expired/critical/warning，复用 getExpiryBoard 口径）、openOrders（按 direction×state 计数）、openPickings、pendingStocktakes
2. `getFlowTrend(ws, days=14)`：`[{ date, inQty, outQty, netQty }]`——InventoryView 新增 SQL 日聚合（`substr(created_at,1,10)` 分组，inQty=Σ正 delta、outQty=|Σ负 delta|，含全部流水来源）
3. `getLocationDistribution(ws)`：每库位 `{ locationCode, skuKinds, totalQty, pct }`（占总数百分比，按 totalQty 降序）
4. `getOrderStats(ws, days=14)`：按日建单量（in/out）+ 非终态单账龄 `{ orderNo, direction, state, ageDays }`
5. `getAlertSummary(ws)`：低库存行 + 临期/过期计数 + 未关盘点/拣货汇总

**路由**：`GET /api/dashboard/overview | /flow-trend?days= | /locations | /orders | /alerts`，re-export 行类型（仿 ExpiryBatchRow）。

**前端** `DashboardPage.tsx`（仿 ExpiryPage 骨架）：
- `Segmented` 五维切换：总览（Statistic 卡阵）/ 出入库趋势（自写 `MiniTrend` 纯 SVG 双折线组件 + 明细 Table）/ 库位分布（Progress 条形 + Table）/ 单据分析（卡 + 账龄 Table）/ 预警（列表）
- queryKey：`['dashboard','overview']` 等；`packages/app/src/api/hooks.ts` 相关写 mutation（建单/转移/调整/拣货/上架）onSuccess 补 `invalidateQueries({ queryKey: ['dashboard'] })`
- 菜单「作业」组首位；默认页保持 skus 不动

## 5. 配置中心：SettingsPage 新 Tab「流程与模块」

让「流程可配置」对人可见可操作（复用慢通道 propose→confirm，不新发明机制）：

- **server**：`packages/server/src/routes/profile.ts` 加 `POST /api/profile/propose`（body: `{ patch, note? }`，actor=`user:local@{nodeId}`，调 `ProfileService.propose`——仿 routes/agents.ts 的 propose 先例）
- **UI**（SettingsPage 第 4 个 Tab）：
  - 模块卡片（读 profile snapshot）：名称/版本/描述 + enabled Switch；切换 → 构造 `replace /modules/{id}/enabled` patch → 调 propose → 弹窗展示 ImpactReport → 确认（既有 `POST /api/proposals/:id/confirm`）/ 放弃（reject）
  - 流程编辑器：选 inbound/outbound → 转移表（from/to + 删除 + 新增行，状态下拉来自该流程 states）→ `replace /workflows/{id}/transitions` 整数组替换（避免索引路径脆弱）→ 同 propose/confirm 流
- **app api**：`profile-api.ts` 加 `proposeProfile`；hooks 加对应 mutation

## 实施顺序

1. core `when` 求值器 + 测试（0）
2. partner 全链路 + 订单关联 + 老库检测（1）
3. putaway manifest + 工具 + OrdersPage 集成（2）
4. 守卫/分配提取重构 → picking 全链路（3）
5. dashboard 查询 + 路由 + 页面 + 失效联动（4）
6. 配置 Tab（5）
7. 文档同步：`docs/ARCHITECTURE.md`（各包文件职责表 + 新里程碑 M21 记录：when 求值/partner/putaway/picking/dashboard/配置中心）、`docs/DESIGN.md` §8 事件目录补 `wms.partner.*`、`wms.picking.*`

## 验证

- **单测**（新增/扩展）：`packages/core/test/when.test.ts`；`packages/wms/test/` 增 `partner.test.ts`、`putaway.test.ts`、`picking.test.ts`、`dashboard-queries.test.ts`，扩展 `workflow-config.test.ts`（when 运行时过滤）；`packages/server/test/wms-routes.test.ts` 增 partner/picking/dashboard/putaway 端点、profile propose 端点；`packages/app/test/pages` 增新页面渲染测试。运行：根目录 `npm test`（或各包 `npx vitest run`）
- **端到端手验**（dev server + app）：建供应商 → 建入库单（选供应商）→ 收货 → 上架（改派目标库位，查库存流水有 putaway 对账）→ done → 建出库单（选客户）→ picking → 建拣货单 → 逐行实拣 → 关单（订单自动 shipped、库存按实拣桶扣减）→ done → Dashboard 五个维度数据正确；Settings 停用 module.putaway → 提案确认 → OrdersPage 上架入口消失、received→done 直达
- **老库升级**：用旧结构数据文件重开（vitest 内模拟 pragma 检测路径）确认 dropAll 重建 + module.putaway 安装幂等
