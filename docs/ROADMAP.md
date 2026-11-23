# WMS 能力补全路线图（对照 OCA/wms）

> 结论来源：对照 [OCA/wms](https://github.com/OCA/wms)（16.0 分支 39 个 addon + 17 个姊妹仓库生态）。
> 现有 21 个内置模块已覆盖出入库主流程、批次/效期、序列号、托盘、盘点、补货、退货、报损、调拨、报表；
> 缺口集中在**执行层（现场作业）、调度层（订单放行）、生态层（承运商/包装/月台/设备）、数据层（成本/时点可用量）**。
> 本路线图新增 **17 个模块 + 1 个 settings 扩展**，全部按现行模块标准实现。

## 1 设计原则（沿用现行标准）

1. **一切皆模块**：每个能力一份 manifest（fields / records / tools / workflows / settings），
   启用即生效、停用即收回；每个模块的停用语义必须写清「新单怎么走、存量单怎么收尾」。
2. **流程接线用 when 谓词**：新步骤通过 transitions 的 `when` 插入出入库状态机（如 `module.release.enabled`），
   不硬编码顺序；跨模块叠加靠谓词组合（如 `module.batchpick.enabled` 叠在 released 之后）。
3. **配置全走慢通道**：所有 settings 改动走 `profile.propose → 人工确认 → 热应用`，
   路径 `/modules/<id>/settings/<key>`；schema 一份三用（校验、表单渲染、AI 上下文）。
4. **停用不伤数据**：停用模块不删数据，oplog 留痕，重新启用即恢复。
5. **模式分级**：节点连接模式有两种——**局域网 / 平台**（代码里没有独立 local 模式：
   不组局域网、不连平台时的单机使用，就是连接未建立的默认态）。
   单人作业免登录；**用户与角色（module.rbac）装上但默认停用**（`#installOptIn`），
   单人时界面零变化；需要多人时经慢通道启用，前端一切 rbac UI 以
   `snapshot.modules['module.rbac'].enabled` 为门。

## 2 模块总表

| # | 模块 id | 名称 | 层 | 优先级 | 依赖 | 骨架文件 |
|---|---|---|---|---|---|---|
| 1 | module.scenario | 场景作业 | 执行 | P0 | core.wms | scenario-manifest.ts |
| 2 | module.rbac | 用户与角色 | 系统 | P0 | （默认停用 `#installOptIn`） | rbac-manifest.ts |
| 3 | module.gs1 | GS1 条码 | 执行 | P1 | core.wms | gs1-manifest.ts |
| 4 | module.release | 订单释放 | 调度 | P1 | core.wms | release-manifest.ts |
| 5 | module.carrier | 承运商发运 | 生态 | P1 | core.wms | carrier-manifest.ts |
| 6 | module.packaging | 多级包装 | 生态 | P1 | core.wms | packaging-manifest.ts |
| 7 | module.batchpick | 批次拣货 | 执行 | P2 | core.wms、module.picking | batchpick-manifest.ts |
| 8 | module.channel | 释放通道 | 调度 | P2 | core.wms、module.release | channel-manifest.ts |
| 9 | module.cost | 库存成本 | 数据 | P2 | core.wms | cost-manifest.ts |
| 10 | module.ticket | 异常工单 | 生态 | P2 | core.wms | ticket-manifest.ts |
| 11 | module.qcdisposition | 质检处置 | 生态 | P2 | core.wms、module.qc | qcdisposition-manifest.ts |
| 12 | module.availability | 时点可用量 | 数据 | P2 | core.wms | availability-manifest.ts |
| 13 | module.dock | 月台预约 | 生态 | P2 | core.wms（软依赖 module.asn） | dock-manifest.ts |
| 14 | module.workstation | 工位 | 执行 | P3 | core.wms、module.scenario | workstation-manifest.ts |
| 15 | module.routing | 动态改道 | 调度 | P3 | core.wms | routing-manifest.ts |
| 16 | module.weighing | 称重商品 | 生态 | P3 | core.wms（软依赖 module.cost） | weighing-manifest.ts |
| 17 | module.device | 设备接口 | 生态 | P3 | core.wms | device-manifest.ts |
| — | （settings 扩展） | 整位拣空 | — | P3 | core.wms 的 defaultAllocation 旁挂 | 改 wms-manifest.ts |

骨架已生成于 `packages/wms/src/`，**尚未在 wms.ts 接线**（见 §6），接线即进模块目录、可被安装启用。

## 3 分层业务细节

### 3.1 执行层（现场怎么干）

#### module.scenario 场景作业（P0）

- **定位**：面向库工的扫码场景向导（收货/上架/拣选/盘点/移库），手机与桌面浏览器自适应；
  是表单、AI 之外的第三种作业入口。
- **业务规则**：
  - 场景档案：名称、入口类型、步骤序列；每步声明扫描目标（单据/库位/商品/批次/托盘）、
    可否跳过、确认动作；步骤字段可配（如收货批次必录/可省）。
  - 内置种子场景五个：收货（扫单→扫商品→录数量→超收拦截）、上架（扫托盘/库位→给目标）、
    拣选（扫单→按路径逐位扫位扫货）、盘点（扫位→盲录数量）、移库（扫位→扫货→扫目标位）。
  - 所有确认动作走工具总线，与表单、AI 同一条 oplog 事实流，不旁路。
  - 数量确认方式可配：手输 / 扫码带出 /（后续）秤。
- **settings**：`defaultScenario`、`pickPathStrategy`（locationCode 库位编码序 / pickZoneFirst 拣货区优先）、
  `feedbackSound`。
- **停用语义**：场景入口从导航收回，作业回退到表单页；进行中的会话作废，已确认动作已在账。

#### module.gs1 GS1 条码（P1）

- **定位**：解析 GS1-128 / GTIN 标准码，一张码带出商品 + 批次 + 效期 + 数量。
- **业务规则**：
  - 工具 `wms.gs1.parse`：输入原始码串，输出结构化字段（GTIN/批次/效期/数量/序列号）。
  - 商品档案可登记多个 GTIN 包装码（多码一字段）；收货/拣货/盘点输入框遇 GS1 码自动拆填，操作员只确认。
  - 未登记的码提示「新码」，一键登记到商品（`wms.gs1.bind`）。
  - 过期码是否拦截沿用 core.wms 的 `blockExpiredOutbound`，不另设开关。
- **settings**：`aiIdentifiers`（启用哪些 AI 位，默认 01/10/17/37）。
- **停用语义**：码串按普通文本处理；已登记 GTIN 留在商品档案。

#### module.batchpick 批次拣货（P2）

- **定位**：多张出库单合一个拣货批次给一个库工，边拣边分（簇拣）。
- **业务规则**：
  - 拣货批次档案：批次号、状态（待拣/拣货中/已分完/已交接）、格口分配表（拣选车格口↔单据）、指派人。
  - 生成：手动勾单，或自动聚合（按区域/按单数上限/按格口上限，自动默认关）。
  - 作业流：扫批次→逐位拣（一位多单分放格口）→逐格口交接→各单进入已拣货。
  - 与打包联动：分完的格口可直接生成打包任务。
- **状态机贡献**：outbound 增加 `batched 已合批`；created/released → batched → picking/canceled。
- **settings**：`autoCreate`、`maxOrders`（默认 10）、`maxBins`（默认 12）。
- **停用语义**：回到按单拣货；已开批次仍可拣完交接。

### 3.2 调度层（单据何时放行）

#### module.release 订单释放（P1）

- **定位**：出库单的可承诺量（ATP）闸门——创建后先进「待释放」，够数才放行到拣货。
- **业务规则**：
  - 判定按行：可用量（余量 − 冻结 − 预占 − 已释放未拣）≥ 行数量 → 可整单放行。
  - 出库单增加 priority（1-9，小者先放）；缺量时高优先级先释放，同优先级先到先放。
  - 释放方式：手动（工作台按钮）/ 自动（`wms.release.run`，默认关）。
  - 部分释放默认关；开启后行内拆分，只放满足的部分。
  - 缺口明细可一键生成补货单（联动 module.replenish）。
- **状态机贡献**：outbound 增加 `pending_release 待释放`、`released 已释放`；
  created→pending_release→released→（picking/waved/shipped 扇出，镜像 created 的既有扇出）。
  实现期需把 created 直达 picking/waved/shipped 的进入谓词收紧为「对应模块开 **且** 释放关」。
- **settings**：`autoRelease`（默认 false）、`partialRelease`（默认 false）、
  `excludeLocations`（自用库位不参与 ATP，默认空）。
- **停用语义**：新单跳过待释放直接走原流程；pending_release 存量自动放行；已释放照常。

#### module.channel 释放通道（P2）

- **定位**：按承运商/承诺日期/客户分组，定时分批放行出库。
- **业务规则**：
  - 通道档案：名称、筛选条件（承运商=某物流 / 承诺日期=今天 / 客户分组）、放行时刻表（每日 HH:mm 多条）、
    单次放行上限（单数或行数）。
  - 到点对符合条件的待释放单批量放行；与手动放行并行。
  - 工作台看板：今日各通道放行计划与完成进度。
- **settings**：`checkIntervalMinutes`（默认 5）。
- **停用语义**：通道不再定时放行，回到 release 的默认放行规则；通道档案保留。

#### module.routing 动态改道（P3）

- **定位**：作业执行中允许改目的地（爆满改道、越库直发）。
- **业务规则**：
  - 上架/移库目标库位可生成改道指令（原因：爆满/越库/借道、新目的地）；未执行前可撤销。
  - 越库：入库单标记「直发」，收货后不进存储位，暂存区直接对出库需求扣减。
- **settings**：`allowCrossdock`（默认 true）。
- **停用语义**：目标库位回到静态规则；未执行改道作废，按原目标走。

### 3.3 生态层（和上下游打交道）

#### module.carrier 承运商发运（P1）

- **定位**：物流商档案、运单登记、发运跟踪。
- **业务规则**：
  - 承运商档案：名称、服务类型（快递/专线/自提）、结算方式、联系方式。
  - 出库单增加承运商与运单号字段；装车页可按承运商分车。
  - 发货登记：运单号/件数/重量 → 复用既有 shipped。
  - 轨迹：手动登记节点（揽收/中转/签收）+ 状态时间线；平台模式预留 API 回传。
  - 面单：以打印任务（收件人 + 运单号）占位，具体模板走集成扩展。
- **settings**：`requireCarrierOnShip`（默认 false）。
- **停用语义**：出库单不再要求承运商/运单号，发货回到直接确认；历史运单保留。

#### module.packaging 多级包装（P1）

- **定位**：SKU 包装层级（件/中包/箱/托），按包装收发、自动换算。
- **业务规则**：
  - 包装档案挂在商品上：层级名、每层含量、条码、长宽高与毛重。
  - 单据行支持按包装录入：扫箱码 = +1 箱自动折 24 件；行上双单位展示（箱 + 件）。
  - 收货支持整箱收；拣货建议整箱拆散件。
  - 打包开着时按包装尺寸推荐纸箱型号（长宽高简单匹配）。
  - **账目恒以基础单位存储**，包装只做录入换算，不改库存口径。
- **settings**：`suggestCarton`（默认 false）。
- **停用语义**：行回到基础单位录入；未完成单的已录包装行按折算件数展示。

#### module.dock 月台预约（P2）

- **定位**：月台档案 + 到车预约排队。
- **业务规则**：
  - 月台档案：编号、类型（收/发）、可用时段。
  - 预约：供应商/承运商、预计到达、月台、关联 ASN 或出库单；状态预约/到车/作业中/离场。
  - 同月台同时段互斥；迟到提示顺延。
  - ASN 详情页显示预约月台（软依赖，asn 未开则只按月台排队）。
- **停用语义**：不做月台约束，收发货照常；存量预约自动关闭。

#### module.ticket 异常工单（P2）

- **定位**：现场异常（短少/破损/错发）开单流转。
- **业务规则**：
  - 工单：类型、来源场景、关联单据与商品、描述、照片（路径占位）；
    状态待处理/处理中/已解决/已关闭。
  - 处置四选一：让步接收 / 退供应商（生成退货出库）/ 报损（生成报损单）/ 补货重发。
  - 计入看板异常块统计。
- **停用语义**：不能再开工单；存量只读保留。

#### module.qcdisposition 质检处置（P2）

- **定位**：质检从「只有通过」扩展为判定 + 处置。
- **业务规则**：
  - 判定三选：合格 / 让步接收 / 不合格。
  - 不合格三路：退供应商（生成退货出库）/ 转不合格品库位并冻结 / 报废（生成报损单）。
  - 让步接收批次打标记，效期看板可见。
  - 报表：按供应商月度来料合格率。
- **settings**：`rejectLocation`（不合格品库位编码，默认空）、`autoReturn`（默认 false）。
- **停用语义**：质检回到只有通过；已生成的处置单据照常流转。

#### module.weighing 称重商品（P3）

- **定位**：按重量收发的商品（生鲜类），单位 kg、步进 0.001。
- **业务规则**：入库录重量（可多件累加），出库按称重扣减；成本开着时按重计价。
- **停用语义**：不能再按重量收发新单，商品恢复按件；存量库存与流水保留。

#### module.device 设备接口（P3，占位）

- **定位**：外部设备（电子秤/DWS/立库）统一接入通道。
- **业务规则**：设备档案（类型/连接方式）、设备事件→工具总线映射表、心跳与离线提示。
  **当前版本只建档案与映射表，不做真实协议对接**（对接走集成扩展）。
- **停用语义**：设备事件不再消费。

### 3.4 数据与系统层

#### module.cost 库存成本（P2）

- **定位**：库存金额化——入库成本、移动加权平均、金额报表。
- **业务规则**：
  - 商品增加计价方式（moving_average / fixed）与默认单价；入库行录单价
    （不录按默认价，两者都没有 = 不计价）。
  - 出库/报损/调拨按当时加权价出成本流水；库存汇总与报表出现金额列。
  - 报表：库存金额表（按分类/库区）、收发存汇总（数量 + 金额）。
  - 盘点差异自动折算金额影响；手动重估走成本调整单（慢通道确认）。
- **settings**：`valuationDefault`（默认 moving_average）。
- **停用语义**：不再要求单价，金额列隐藏；成本流水保留。

#### module.availability 时点可用量（P2）

- **定位**：从「现在有多少」升级为「哪天有多少」。
- **业务规则**：
  - 可用量加日期轴：在途入库按预计到货日并入（asn 未开时按入库单创建日）。
  - 工具 `wms.availability.byDate`：按商品查未来 N 日逐日可用量，AI 与报表共用。
  - 报表：缺货日历（哪天开始缺）。
  - release 的放行判定可选「含在途」口径（默认不含）。
- **settings**：`horizonDays`（默认 30）。
- **停用语义**：可用量回到当前口径。

#### module.rbac 用户与角色（P0，装上但默认停用）

- **定位**：多节点多人作业的账号权限体系。
- **门控**：模块随包安装但**默认停用**（`#installOptIn`）——单人使用（连接未建立、
  或仅本机作业）时免登录、界面不出现任何账号 UI，行为与从前完全一致；
  需要多人时经慢通道启用。前端一切 rbac UI 以
  `snapshot.modules['module.rbac'].enabled` 为门。
- **业务规则**：
  - 用户：账号/显示名/所属节点/状态；平台模式含组织字段（多租户占位）。
  - 角色可自定义，内置种子四个：
    - **仓库经理**：全部操作 + 配置慢通道的提案与确认权；
    - **仓管员**：单据与库存全操作（不含配置确认）；
    - **库工**：场景作业 + 查询；
    - **审计**：只读 + oplog 查询。
  - 权限对象四类：页面、工具（读/写）、慢通道提案与确认、报表导出。
  - 出库单与拣货批次可指派到人，工作台按人过滤待办。
  - 登录与关键写操作的操作人写入 oplog 元数据（审计）。
- **settings**：`sessionTimeoutMinutes`（默认 240）、`assignOnCreate`（出库创建即指派创建人，默认 false）。
- **停用语义**：回到免登录单人模式（lan 模式下停用需二次警示确认）；用户与角色档案保留。

#### module.workstation 工位（P3）

- **定位**：固定作业位（收货台/打包台/复核台/称重台）与外设绑定。
- **业务规则**：工位档案（类型、默认场景、打印机模板）；现场设备选工位进场景，动作带工位标识；
  条码标签与面单按工位路由打印任务。
- **停用语义**：场景不再按工位过滤；工位档案与历史保留。

#### settings 扩展 · 整位拣空（P3）

- 不新增模块：core.wms 的 allocation 旁挂布尔键 `fullLocationPick`（默认 false）。
- 语义：开启后出库分配时，若库位余量 − 预占 ≤ 拣货需求 + 容差，整位预占并在拣货单提示「整位拣空」。
- 落点：wms-manifest.ts 的 settings.schema 加键，分配逻辑（numbering/allocate 侧）实现期消费。

## 4 三模式能力矩阵

| 能力 | 本地 | 局域网 | 平台 |
|---|---|---|---|
| 全部业务模块（scenario/gs1/release/carrier/…） | 可启停 | 可启停 | 可启停 |
| 多节点 oplog 同步 | — | 默认开 | 默认开 |
| module.rbac 用户角色 | **默认停用，界面零变化** | 可启用 | 可启用（多租户占位） |
| 轨迹 API 回传 / 集成扩展 | 手动登记 | 手动登记 | API 回传 |
| 设备接口 / 面单模板 | 占位 | 占位 | 集成扩展 |

## 5 落地顺序

- **P0**：scenario（现场作业形态）→ rbac（多人前提，随局域网/平台模式一起交付）
- **P1**：gs1 → release → carrier → packaging（接通真实供应链的最小集）
- **P2**：batchpick → channel → cost → ticket / qcdisposition → availability → dock
- **P3**：workstation → routing → weighing → device → 整位拣空 settings

## 6 骨架文件与接线说明

17 个 manifest 骨架已生成在 `packages/wms/src/`（`*-manifest.ts`，纯声明、无 handler）。
**尚未接线**：按现有模式，实现某个模块时在 `wms.ts` 构造器里

```ts
this.#releaseManifest = releaseManifest();
core.exposeModuleRegistry().registerManifest(this.#releaseManifest);
```

需要工具的模块同时补 `tools/release-tools.ts`（handler 注册上总线，manifest 经 detachHandler 声明），
需要建表的模块在 `db/migrations.ts` 加表。骨架里的 tools/records/settings 声明就是实现契约。

骨架文件清单：

| 文件 | 模块 |
|---|---|
| scenario-manifest.ts | module.scenario 场景作业 |
| rbac-manifest.ts | module.rbac 用户与角色 |
| gs1-manifest.ts | module.gs1 GS1 条码 |
| release-manifest.ts | module.release 订单释放 |
| carrier-manifest.ts | module.carrier 承运商发运 |
| packaging-manifest.ts | module.packaging 多级包装 |
| batchpick-manifest.ts | module.batchpick 批次拣货 |
| channel-manifest.ts | module.channel 释放通道 |
| cost-manifest.ts | module.cost 库存成本 |
| ticket-manifest.ts | module.ticket 异常工单 |
| qcdisposition-manifest.ts | module.qcdisposition 质检处置 |
| availability-manifest.ts | module.availability 时点可用量 |
| dock-manifest.ts | module.dock 月台预约 |
| workstation-manifest.ts | module.workstation 工位 |
| routing-manifest.ts | module.routing 动态改道 |
| weighing-manifest.ts | module.weighing 称重商品 |
| device-manifest.ts | module.device 设备接口 |
