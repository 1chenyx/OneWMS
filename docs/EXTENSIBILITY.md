# OneWMS 扩展性重构设计

> 本文是**执行文档**。目标读者是实施者（人或 AI），不是决策评审者。
> 只写「做什么、按什么顺序、有什么约束、怎么验收」。决策理由压缩到最小必要。
> 引用格式为 `文件路径 :: 符号名`，行号仅作辅助定位（会随改动漂移，以符号名为准）。

---

## 1. 目标与范围

三条产品线共用同一领域内核：

| 线 | 形态 | 代码库 |
|---|---|---|
| ① 单机版 | Tauri 便携版 / NSIS 安装包 | **本仓库** |
| ② 私有部署服务器版 | 锚点节点 + 瘦客户端，客户自己运维，跨互联网走 VPN | **本仓库** |
| ③ SaaS 平台版 | **客户端仅存**（Tauri 壳或浏览器），数据与后端全在我方平台 | **另起代码** |

**本仓库的服务对象是 ①②，外加「③ 的前端」**。具体含义：

- ③ 的客户端会复用本仓库前端（`packages/app`）去连平台 API
- 因此 `packages/app` 必须做到 **base URL 可配置、与 sidecar 生命周期解耦**（Phase A）
- `packages/server/src/routes` 是 **①② 的实现**，同时也是 **③ 必须遵守的契约**（Phase A）
- `packages/core` + `packages/wms` 的领域逻辑 **③ 直接复用**（Phase P）

**不做多租户改造。** ③ 另起代码实现。

### 1.1 核心决策：数据配置驱动，零第三方代码

扩展手段是**声明式模块**——客户提交 JSON 定义（实体、字段、流程、页面），宿主解释执行。**不执行任何第三方代码。**

分界线：**引擎写代码（我方，一次性），定制写数据（客户，可配置）。**

这样做的收益：三条线通用；配置可随客户在 ①②③ 之间迁移；配置走账本，天然获得审计/回滚/下发能力；AI 可安全生成（数据能静态校验，代码不能）。

### 1.2 红线（不要做的事）

| 禁止 | 理由 |
|---|---|
| 动态 `import()` / 目录扫描加载第三方 JS | 多租户下物理不成立，且导致两套定制机制、配置不可迁移 |
| `eval` / `new Function` / 嵌入式脚本引擎（Lua、QuickJS 等） | 同上，且藏在配置层里更难发现 |
| 运行时热装载模块 | 「重启生效」已足够，热装载成本数量级提升 |
| 认证系统自建（登录/token/session） | ①② 是 localhost / VPN 可信域；③ 由平台侧承接 |
| 跨互联网直连 | 由 VPN 组网承接，不做穿透 |
| 多租户改造 | ③ 另起代码 |
| 为 Phase P 提前重构 core/wms 全部 SQL | ③ 立项时再做，现在只保证新增代码可移植 |
| `packages/app` 内隐含「与后端同源」 | 全部请求走相对路径（无硬编码 host），Phase A.1 要消除的第一项 |

---

## 2. 现状与改动锚点

### 2.1 装配链路

```
index.ts :: createServer()
  workspaceId = process.env.ONE_WORKSPACE ?? 'default'
  ctx = createAppContext({ nodeId, workspaceId, ... })
  app.route(...) × 10 组路由，全部闭包捕获同一个 ctx
context.ts :: createAppContext()
  域装配（WmsDomain / MemoryDomain）+ aiManifest install
  ← Phase B 的动态模块注册挂在这之后
wms.ts :: WmsWorkspace 的 view getter（已公开，可横向复用）
module-registry.ts :: install()      6 道预检，Phase B 直接复用，不改
module-registry.ts :: uninstall()    Phase B.0 需在此补投影清理
```

### 2.2 四个能力缺口

| 缺口 | 证据 | 对应任务 |
|---|---|---|
| 前端隐含同源，与 sidecar 强绑定 | `packages/app/src/api/request.ts :: request` 直接 `fetch(url)`，全部调用点传相对路径（无硬编码 host） | A.1 |
| actor 单点已收敛但未提交 | `packages/server/src/actor.ts :: resolveActor(ctx, c)` | A.2 |
| 实体结构由代码写死 | `manifest-types.ts :: ModuleManifest.records` 注释明写「固定列，不能用 profile.propose 增删」 | B.1 |
| 前端页面封闭枚举 | `app-nav.tsx :: Page` 是字面量联合，`Record<Page, ComponentType>` 穷尽检查 | B.6 |

### 2.3 当前配置能力边界

`profile-types.ts :: PATCH_ROOTS = ['/schema', '/workflows', '/modules', '/roles']`

- ✅ 可配：给**已有实体**加扩展字段、改流程状态/转移、开关内置模块、改模块 settings（后端）
- ❌ 不可配：新增实体类型、固定列、字段级业务规则、页面、角色（`roles` 恒为空且被冻结）
- ⚠️ `manifest.settings.schema` 在 `packages/app/src` **全仓零消费**——后端能存，界面上配不了

**Phase B 的任务就是把 ❌ 变成 ✅。**

### 2.4 三个必须知道的技术约束

**① 投影版本只到域级** —— ✅ 已由 B.0 解决
原状：`wms-projections.ts :: WMS_PROJECTION_VERSION = 1` 十表共用，`clear()` 硬编码 20 条 DELETE，任何新投影表触发 bump → **整个 WMS 域全量重放**。
现状：一个域可声明多组，各组各打各的戳；表清单登记在 `WMS_PROJECTION_GROUP.tables`（core `ProjectionGroupSpec`），`clear()` 照清单执行，并有测试对着 `sqlite_master` 守卫完整性。详见 §B.0。

**② oplog 有 `(workspace_id, actor, seq)` 唯一约束**
这是同步通道「单写者」的地基。actor 命名不能随意变更格式。

**③ `stage.ps1` 的固定包名单不是偷懒**
项目历史记载：npm 沙箱安装 workspace 依赖时 `@one/*` junction 会指向临时随机名目录（如 `.ai-Ac5uymqI`），打包前必须删除 junction 并用固定名单真实目录拷贝替代。`stage.ps1` 的 junction 替换循环是**唯一静默失败点**（打包成功但运行时缺包）。改动后必须实际打一次便携版并启动验证，不能只跑单测。

---

## 3. Phase A · 契约固化（③ 的真正前置）

**目标**：前端可连任意后端；API 成为受版本管理的契约。

### A.1 API base URL 可配置

现状不是「写死了 host」，而是**全部走相对路径**（`api/request.ts :: request` 直接 `fetch(url)`，调用点传 `/api/...`），隐含「前端与后端同源」。

- `packages/app/src/api/request.ts :: request` 增加 base URL 前缀拼接（构建期 env + 运行时设置界面）
- base URL 为空时保持相对路径行为不变（①② 默认形态零回归）
- ⚠️ **跨源是本项真正的成本，方案原先漏了**：一旦 base URL 指向别的 origin，
  - `packages/server` 需要 CORS 中间件（当前同源所以没配）
  - Tauri 下前端 origin 是 `tauri://localhost`，需列入允许来源
  - SSE 端点（chat 流式）的跨源行为要单独验，不能只验普通 JSON 请求
- **验收**：`packages/app` 构建产物指向远程 URL 时可正常登录并读写，且 chat SSE 流式正常

### A.2 actor 单点收敛

`packages/server/src/actor.ts :: resolveActor(ctx, c)` 已实现（返回 `user:local@{nodeId}`），并已接入 `agents.ts` / `profile.ts` / `memory.ts` / `proposals.ts` / `wms.ts`。

**待办**：
- 确认 `chat-attachments.ts` 等剩余写操作调用点全部接入，全仓无裸写 `'user:local'` 字面量
- **签名保持 `(ctx, c)`**，不要改成只收 `req`——② 的局域网多用户和 ③ 的租户身份都需要从请求里取
- ⚠️ 账本不可变：已落盘的旧 actor 永远洗不掉，只能影响新事件。**改历史事件 = 破坏账本完整性 = 同步指纹全变，绝对禁止**

### A.3 API 契约文档化（**暂缓**）

> 决策：本项暂缓，等 §8 战略决策落定 + ③ 立项后再做。
> 原因：「契约测试双跑」要求同一套用例跑本地 server 与 mock 平台 server，
> 但 ③ 目前连代码库都不存在，mock 平台 server 无从构造，**该验收项当前不可执行**。

原范围（保留备查）：
- 为 `packages/server/src/routes/*` 产出 OpenAPI（或等价 schema）
- **契约测试双跑**：同一套用例跑本地 server 与 mock 平台 server，任一失败即契约漂移
- 明确哪些端点进契约（③ 必须实现）、哪些是 ①② 专属

⚠️ **条件反转提醒**：若 ③ 决定直接复用 `packages/server/src/routes`，则必须补做 **ctx 池化改造**（61 个端点从 `routes(ctx)` 闭包捕获改成 `routes({ resolveCtx })` 每请求解析）。当前判定为「③ 另写」，故不做。**这个前提一旦被推翻，A 阶段范围立即扩大。**

### A.4 卸载后工具不可见（**改：授权层过滤，不动总线**）

原方案是「`uninstall()` 补 `ToolBus.unregister`」。**这个做法会引入 bug，已否决**，三条理由：

1. **所有权反转**：`module-registry.ts :: install()` 预检 5 明确要求工具必须**已由代码装载方预先注册在总线上**，ModuleRegistry 自己从不注册工具。让 uninstall 去摘它没装过的东西，语义上站不住。
2. **总线是进程级单例**：`ToolBus` 实例注入每个 `WorkspaceFacade`（`core/src/workspace/workspace.ts`），而 `unregister(toolId)` **不带 workspace 维度**。workspace A 卸载模块会把 workspace B 的工具一起摘掉。
3. **模块变成一次性**：摘掉 handler 后重装同模块，预检 5 直接抛「工具未在工具总线上注册」，装不回去。

**改后的做法**：保留 handler，在**授权/可见性层**按「已安装且 `enabled` 的模块」过滤工具清单。
- AI 拿不到工具 = 调不到，达到原目标（「模块卸了 AI 仍能调用」）
- 重装无损，多 workspace 互不干扰
- 落点：AI 侧工具目录装配（`ai/src/agent-defs.ts` / `tool-catalog.ts`）与 `routes/chat.ts` 的 catalog 取用处

⚠️ 仍是本方案**唯一的行为变更**（其余纯增量），必须跑全量测试，确认没有测试依赖「卸载后工具仍在清单里」的旧行为。

---

## 4. Phase B · 声明式模块（主线）

**目标里程碑**：客户提交一份 JSON，即可新增业务对象，端到端可用（存储 → 读写端点 → AI 工具 → 界面），全程零代码、热生效。

### B.0 per-group 投影版本（前置件）✅ 已完成

解决 §2.4 ①。

**实施时的事实更正**：版本戳机制**本来就是 per-group**的——`ensureProjectionVersion(db, { group, workspaceId, codeVersion, rebuild })` 已带 group 维度，meta key = `projection.<group>.<workspaceId>`，core / wms / memory 各自成组。真正缺的是两件事：

1. **一个域只能声明一组**。WMS 十表挤在 `group='wms'` 下共用一个版本号，新增任何投影都得跟着整域重放。
2. **「本组有哪些表」是硬编码**。`WmsProjections.clear()` 里 20 条 DELETE，加表要同时改建表和清空，漏一条不报错而是静默错账（重放时旧行还在、新行又插一遍）。

**实际改动**：
- 新增 `core/src/projection/projection-group.ts`：`ProjectionGroupSpec { group, codeVersion, tables }` + `clearProjectionTables(db, workspaceId, tables)`。表支持 `scope`（同表被多组共用时按列切片，B.2 的 `dyn_records` 按 `module_id` 分组靠它）；表名/列名要拼进 SQL，走标识符白名单校验。
- `wms-projections.ts`：新增 `WMS_PROJECTION_GROUP` 常量登记 20 张表，`clear()` 改为照清单执行。`wms.ts` 的 `ensureProjectionVersion` 调用点从该常量取 `group` / `codeVersion`，不再散落字面量。

⚠️ **老库兼容：不需要迁移，(a)(b) 两个选项都作废。** 原判断的前提（「改成 per-group 后 key 形状变化」）不成立——组名沿用 `core` / `wms` / `memory`，key 形状一字未改，老库的戳照常命中。另外即便真的失配，`decideProjectionVersion` 对「库里没戳」判的是 `fresh`，而 **fresh 只打戳不重建**，压根不会触发全量重放。原方案在这里把两条路径都判错了。

**验收（已达成，测试落地）**：
- `core/test/projection-group.test.ts`：只清本工作区、scope 切片、畸形标识符拒绝
- `wms/test/projection-group.test.ts`：
  - 清单完整性守卫——`WMS_PROJECTION_GROUP.tables` 对着 `sqlite_master` 里全部 `wms_*` 表校验，新建表忘登记当场红
  - 新增一组（`wms-extra`）并 bump → 只重建该组，`wms_sku` 被篡改的值原样留着（证明十表没动）
  - 反向——WMS 组戳回拨触发整域重建，额外组的表不受牵连
- 基线：typecheck 全绿；测试 963 → **974**（core 135→141、wms 325→330）

### B.1 放开 `records` 为可配置 ✅ 已完成

- `manifest-types.ts :: ModuleManifest` 允许 `records` 由声明式模块提供
- 新增 `dyn.module.register` 提案类型，挂进现有 Profile 提案管线（提案 → 影响报告 → confirm/reject）
- **复用 `module-registry.ts :: install()` 的 6 道预检，一行不改**
- 校验：实体 id 命名空间隔离（建议 `dyn.{moduleId}.{recordId}`）、字段类型白名单、与内置实体撞名拒绝

**实施结果（事实记录）**：

- **manifest 持久化**：`ModuleConfig` 加可选 `manifest?: ModuleManifest`，存 `/modules/{id}.manifest`，随 `config.change` 进 oplog——重启/同步/重放/迁移免费获得，不改 `profile_state` 表结构、不加 PATCH_ROOT。**只有代码不在场的模块才落账**（install 时不在进程目录）：内置模块的真相是代码，再存一份就是两份真相。
- **提案 kind**：`Proposal.kind: 'patch' | 'dyn.module.register'`（默认 `'patch'`，既有调用零改动）+ `manifest?` 载荷；`ProposalStore` 由 ProfileService 与 ModuleRegistry 共享同一实例（core.ts 装配），两种提议共处一个待确认队列。
- **依赖方向**：ProfileService 不 import ModuleRegistry（会成环）。WorkspaceFacade 把 `install` 作为闭包注入 `ProfileView.confirm`，按 kind 分派——`routes/proposals.ts` 一行未改。
- **id 命名空间**：**独立正则方案**（内置 `RECORD_ID_RE` 不动，`dyn.` 前缀分流到 `isDynamicRecordId(id, moduleId)` 前缀匹配）——内置正则不含点号，所以 `dyn.` 前缀结构上不可能与内置撞名；内置 manifest 声明 `dyn.` 开头实体会被拒（保留字）。
- **提案期静态三关**（`proposeInstall`，全部零事件）：manifest 结构（含新增列 `type` 白名单 / `queryable` 布尔）+ 命名空间（`validateDynamicRecords`：不许裸 id、不许冒用他模块命名空间、列必填 type）+ 撞名（与**全部已声明实体**的 id/别名比对，含未安装的内置模块；重装自己放行）。**6 道安装预检故意不在提案期跑**（依赖/工具在场性随时间变化，confirm 时刻重新判定，失败抛结构化错误、提议留 pending）。
- **install 预检 7**（新增，仅当 manifest 声明了 `dyn.` 实体时生效，内置零影响）：命名空间 + 撞名断言。
- **AI 可见性**：`query-tools.ts` 全部目录装配改用 `effectiveManifests()`（进程目录 ∪ 已落账声明式 manifest）；`listInstalled` 的 manifest 回落到 config（声明式模块重启后目录为空）。列的 `type`/`queryable` 透传进 `profile.field.query` 结果。
- **验收（已达成）**：`core/test/dyn-module.test.ts` 13 例——提案期静态拒绝（缺 type / 命名空间逃逸 / 撞含未安装内置的 id 与别名）、kind 分派与补丁同队列、confirm 落账（config.change 携带 manifest + module.installed 审计）、确认时刻动态拒绝提议留 pending、幂等确认零事件、异版本确认被冲突预检拒、**文件库重开后 manifest 经 config.change 重放仍在场**、replay 前后快照一致、卸载后 manifest 随 modules 段移除、`dyn.` 保留字。
- **既有断言更新**：`modules.test.ts`「全流程」一例——直接 install 未经 registerManifest 注册目录 → 视为代码不在场 → modules 段现在含 manifest（行为刻意，非回归）。
- 基线：typecheck 全绿；core 测试 141 → **154**（+13）。

### B.2 通用记录存储（单表 JSON + 独立索引表，不做动态 DDL）✅ 已完成

**决策：单表 + JSON 列 + 独立索引表**，不为每个声明实体建表，**也不用生成列**。

理由：跨库可移植（Postgres 同样成立）；改配置无需 schema 迁移；卸载无需 drop table。

⚠️ **为什么不用生成列（方案原先自相矛盾处）**：本节要求「可移植 SQL」，§6 也要求 B.2「不写 SQLite 方言」。但生成列两边不通——
- SQLite：`GENERATED ALWAYS AS (json_extract(data,'$.x')) STORED|VIRTUAL`（3.31+）
- Postgres：只支持 `STORED`，取值写法是 `data->>'x'` / `jsonb_path_query`
- JSON 列类型本身也不同（SQLite TEXT vs Postgres jsonb）

所以改用**独立索引表**，纯可移植 SQL，代价是查询多一次 join：

```
dyn_records(
  workspace_id, module_id, record_type, record_id,
  data,                 -- JSON 文本，全部字段（列类型用 TEXT，两边通用）
  created_at, updated_at, version
)

dyn_index(
  workspace_id, module_id, record_type, record_id,
  field_key, field_value,        -- 仅 manifest 声明为「可查询」的字段才落行
)
-- 索引：(workspace_id, module_id, record_type, field_key, field_value)
```

- 记录变更走 `record.created` / `record.updated` / `record.deleted` 事件，投影时**同步重建该 record 的索引行**（先删后插，幂等）
- 用 B.0 的 per-group 版本管理，group 名 = `dyn.{moduleId}`
- **卸载模块保留表和数据**（符合「卸载不丢业务数据」承诺）；重装同 id 但 schema 变了 → 走 `ensureProjectionVersion` 迁移
- ⚠️ **孤儿数据行为需写进对外文档**：卸载后 manifest 不在场，B.3 端点「白名单严格来自 manifest，未声明一律 404」→ 数据仍在库里但界面上不可访问，只有重装同 id 模块才能重新看到。这是刻意的（不静默暴露无 schema 数据），但客户必须知道。

**能力边界（必须写进对外文档）**：适合「独立管理的辅助档案」，不适合「参与核心库存联动的实体」。复杂联表与聚合报表撑不住（索引表只支持等值/范围单字段过滤，不支持多字段联合索引）。

**实施结果（事实记录）**：

- **建表**：`core/src/db/migrations.ts` SCHEMA_VERSION 4→5 落 `dyn_records` / `dyn_index` + 查询索引 `idx_dyn_index_query`，纯可移植 SQL（全 `IF NOT EXISTS`，老库升版本重跑迁移块即补表）。`data` 列存 JSON 文本（TEXT 两边通用）。
- **服务**：新建 `core/src/dyn/dyn-store.ts`。写路径（create/update/delete）：白名单解析（实体必须来自**已安装**模块的 manifest）→ 字段校验（未声明键拒绝；按列 `type` 白名单校验值；date 宽松解析不限死 ISO）→ recordId 规则（字母数字开头、`_`/`-`、≤64 位，缺省自动生成）→ 乐观并发（expectedVersion 过期拒绝）→ 落事件 + 立即应用投影（FieldRegistry 同一纪律）。读路径（get/list）：等值过滤只认 `queryable:true` 字段（下推 dyn_index join），分页上限 200。
- **事件**：`record.created/updated/deleted`，created/updated 携带**全量 data**（整替，不做 JSON patch——重放无须基准）与**目标 version**（写路径按当前行算好写进载荷——重放幂等靠它：若在投影时 `version+1` 推导，重开库的构造期追账会把 version 顶到 2，乐观并发当场失真），deleted 只带定位三键。幂等摄入下的并发裁决 = 全序 LWW（UPSERT 后到者胜；deleted 对缺失行 no-op），确定性由 (lamport, actor) 全序保证。
- **索引行重建**：applyEvent 先删后插，与 data 严格同步；索引值规范形态 = string 原样、其余 JSON 序列化（`canonicalFieldValue`）。⚠️ TEXT 字典序对 number 范围查询不可靠（"10" < "9"），B.3 做范围过滤需回表取 data 再按类型比较。
- **版本管理**：per-module 组 `dyn.{moduleId}`（`dynGroupName`），表按 `module_id` 切片（B.0 `ProjectionTable.scope`）——某模块 bump 或重装只重建自己的切片。派生规则版本 `DYN_PROJECTION_VERSION=1`，改投影语义即 +1，下次启动整组自动重建。
- **重装换 schema 的更正**：原设计写「重装同 id 但 schema 变了 → 走 ensureProjectionVersion 迁移」——**版本戳帮不上这里**：戳只认代码版本，manifest 是数据不是代码。实际做法是 **install() 成功后无条件整组重投影**（ModuleRegistry 经 `DynProjectionPort` 回调 `reprojectModule`：清模块切片 + 按当前 manifest 重放），安装是低频人工确认动作，代价可忽略；版本戳继续负责代码级 bump（门面构造期 `ensureModuleProjection` 打戳/重建）。
- **追账与重放**：DynStore 进程内持 per-workspace 游标，门面构造期 `sync()` 增量追账（重启游标归 -1 = 全量重放，applyEvent 幂等所以安全，顺带自愈「append 已提交、投影未应用」的崩溃窗口）；`WorkspaceFacade.replay()` 纳入 dyn 两表（清投影 + 全量重放 + 游标复位）——于是**备份恢复 / 同步摄入 / 迁移导入三条 ingest 路径免费获得 dyn 重建**，server 路由零改动。
- **依赖方向**：DynStore ← 闭包 `(wsId) => installedDynRecords(wsId)`（ModuleRegistry 新增方法：生效 manifest 全集 ∩ 已安装）；ModuleRegistry ← `DynProjectionPort` 接口（只有 reprojectModule 一个方法）。两服务互不 import 实现，无环。
- **孤儿数据行为（对外文档口径）**：卸载后 manifest 不在场 → 读写一律 NotFound（存储层 #resolveSchema 即拒绝）；数据行保留在 dyn_records，**索引行不再维护**（applyEvent 时 schema 不在场只保数据行）——无 schema 数据不静默暴露，重装同 id 模块时 reprojectModule 按新 manifest 补齐索引。
- **验收（已达成）**：`core/test/dyn-records.test.ts` 17 例——全类型白名单校验、自动生成 recordId、create 冲突/版本冲突/缺失 NotFound、update 整替且 created_at 不变（UPSERT 保留建档时间）、事件落账、索引等值过滤下推 + 非 queryable 拒绝、分页、删除后索引行消失、**replay 幂等**、**文件库重开后追账可读**、**摄入远端 record.* 后新门面构造期自动可见（含重复摄入幂等）**、**版本戳落 meta**、**卸载保留数据不可访问 + 重装回来且索引重建**、**重装换 schema（queryable 翻转）触发整组重投影**。

### B.3 通用 record 端点 ✅ 已完成

- `GET/POST/PATCH/DELETE /api/dyn/:module/:type[/:id]`
- **白名单严格来自 manifest**：未声明的 module/type/字段一律 404，不做兜底
- 分页、排序、过滤参数只允许作用于 manifest 声明为可查询的字段

**实施结果（事实记录）**：

- **路由**：新增 `server/src/routes/dyn.ts :: dynRoutes`，挂在 `/api/dyn`（`index.ts :: createApp`，**先于** `app.route('/api', wmsRoutes)` 挂载）。URL 的 `:module` + `:type` 拼成实体 id `dyn.{module}.{type}`，命名空间规则与 `manifest-types.ts :: dynamicRecordId` 同源；拼装即绑定，type 里塞点号冒用别的模块实体也只会拼出不存在的 id → 404。
- **白名单单一来源**：`ModulesView.dynRecords()`（委托 `ModuleRegistry.installedDynRecords`，= 生效 manifest 全集 ∩ 已安装）——**与 DynStore 解析 schema 是同一个入口**，所以端点判「未声明 → 404」与存储层判「无 schema → NotFound」不会错位。
- **404 覆盖三处**：module/type 未声明或模块已卸载；过滤字段未声明；排序字段未声明。「已声明但未标 `queryable`」**也归 404**，不区分「没这个字段」和「有但不许查」——白名单外的列在这个端点上就是不存在，少一个信息泄露面。
- **查询文法**：`?limit=&offset=`（limit 缺省 50、上限 200）、`?filter=<列>&equals=<值>`、`?sort=<列>&dir=asc|desc`。`equals` 的值**按 manifest 声明的列类型转换**（number/boolean/json/date/string）——索引存的是规范字符串（number→`"9"`），拿原始查询串直接比永远匹配不上，列类型是唯一转换依据。`dir` 只接受两个字面量（要拼进 SQL，不收自由文本）。
- **状态码分档**（`errors.ts :: STATUS_BY_CODE` 新增三条）：`DYN_RECORD_NOT_FOUND` 404 / `DYN_RECORD_CONFLICT` 409（乐观并发撞版本、重复创建）/ `DYN_RECORD_VALIDATION` 422（列校验不过）；分页与查询串参数不合法走既有 `BadQueryError` 400（**不静默回落默认值**，坏参数当场暴露）。
- **写路径**：POST body `{ recordId?, data }`（`recordId` 缺省自动生成）→ 201；PATCH body `{ data, expectedVersion }` → 200，**语义是整替不是 JSON patch**（缺列按 manifest required/default 判，前端须带上没改的列）；DELETE 走 `?version=`（DELETE 带 body 不是通用惯例）。actor 全部经 `resolveActor(ctx, c)`，审计与账本通道免费获得。
- **排序实现（补 B.2 留下的坑）**：`DynStore.list` 新增 `sort`，`DynListOptions` 扩字段。
  - ⚠️ **number 列必须 `CAST(field_value AS REAL)` 再排**：索引值是 TEXT 规范形态，字典序下 `"100" < "9"`。`CAST(x AS REAL)` 在 SQLite / Postgres 都成立，不引方言（§B.2 记的范围过滤同源坑，排序这里已解）。
  - **排序用 LEFT JOIN**：排序列是可选列，INNER JOIN 会把没这个字段的记录悄悄丢掉；缺失值用 `CASE WHEN ... IS NULL THEN 1 ELSE 0 END` 显式排最后——两库对 NULL 的默认排序方向相反（SQLite ASC 在前、Postgres ASC 在后），不写死就没有跨库确定的顺序。
  - **过滤用 INNER JOIN**（索引行缺失本就不该被等值条件命中），两者可组合，各占一个 join 别名。
- **顺带修掉一个真 bug**：原 `clampPage` 把 `offset` 也按单页上限截断（`Math.min(offset, 200)`），深分页会静默返回第 200 页。现拆成 `clampLimit`（要封顶）与 `assertOffset`（只校验非负整数）——limit 是「一次取多少」，offset 是「翻到第几页」，两者不是一类东西。
- **对外文档口径（承接 §B.2 孤儿数据）**：卸载模块后端点一律 404，但 `dyn_records` 的行仍在库里，重装同 id 模块即恢复（已有测试对着这条路径验）。
- **验收（已达成）**：`server/test/dyn-routes.test.ts` 17 例——未安装/未声明 module/type/命名空间冒用 → 404 且 code 为 `DYN_RECORD_NOT_FOUND`；卸载后 404 + 重装数据回来；create/get 往返与 recordId 自动生成；PATCH 乐观并发（200/409）、缺 expectedVersion 400、列校验 422；DELETE 三档；actor 审计为 `user:local@…` 而非节点 id；分页信封 total/limit/offset/hasMore；过滤按类型转值（`?filter=score&equals=9` 命中）；白名单外过滤/排序 404、参数不成对或类型不匹配 400；number 排序按数值（`R2(9) → R3(50) → R1(100) → R4(缺失)`）；过滤+排序+分页组合翻页不重不漏；坏 JSON body 400。`core/test/dyn-records.test.ts` 新增 6 例排序与深分页。
- 基线：typecheck 全绿；core 171 → **177**、server 169 → **186**（其中 `api.test.ts` 1 例为 B.2 期已记录的既有失败：授权工具总数越过 `TOOL_CATALOG_DEFER_AT=64`，剧本未先 `tools.load`，与本节无关）、wms 361 全绿。

### B.4 通用 record 工具注册到总线 ✅ 已完成

- 为每个声明实体注册 `dyn.{module}.{type}.list/get/create/update/delete`
- **工具 description 从 manifest 动态拼装**（实体名、字段名、字段含义、枚举值）

⚠️ **这一项不能省**。否则配置了新实体 AI 也不知道，「AI 立刻可用」不成立。

⚠️ `tool-bus.ts :: permission` 是 `'read' | 'write'` 二值，**已有消费方**（见 B.5 更正）。但 B.3/B.4 一开放，等于把全部写操作暴露给前端。**B.5 是硬要求，不是可选项。**

**实施结果（事实记录）**：

- **落点**：新增 `core/src/dyn/dyn-tools.ts`，导出 `createDynTools(schemas, store)`（纯函数，便于直接断言拼装结果）与 `syncDynTools(bus, store, schemas)`（覆盖注册，返回工具 id）。工具 id = `{实体 id}.{动词}`，实体 id 本身就是 `dyn.{moduleId}.{recordId}`，所以形如 `dyn.vendor.extra.qualification.list`，与原文的 `dyn.{module}.{type}.list` 同形。
- **注册时机两处，缺一个就不成立**：① `WorkspaceFacade` 构造末尾（工作区打开）——重启后声明式模块的 manifest 是靠 `config.change` 重放回来的，进程目录里没有它的代码，只有这条路径能把工具装回总线；② `ModuleRegistry.install()` 成功且 `hasDynRecords` 时，经新增的**可选**第 8 个构造参数 `onDynRecordsInstalled?: (workspaceId) => void` 回调（闭包反转，注册表不 import 工具拼装逻辑；同 `DynProjectionPort` 的风格）。顺序刻意排在 `reprojectModule` 之后：工具一可见就该能查到数据。
- **卸载什么都不做**（§A.4 红线）：工具留在总线上，但 handler 一律按 `ctx.workspaceId` 现取 schema，卸载后调用即失败；「AI 看不见」由 A.4 的授权/可见性层负责。**重装即恢复**，因为 `bus.register` 同 id 覆盖，幂等。
- ⚠️ **原文「枚举值」这项素材不存在**：`ManifestRecordField` 只有 `key` / `label` / `description?` / `type?` / `queryable?`，没有 enum/options/required/default/unit。能拼进 description 的就是实体名与别名、note、来源模块 id、列名、列中文标签、列类型、列含义、可过滤/排序标记。顺带更正 §B.3 里「缺列按 manifest 的 required/default 判定」的说法：**manifest 没有 required/default 概念，列全部可选**，整替更新时没带上的列会从记录里消失（`routes/dyn.ts` 的注释已同步改正）。
- **description 分配**：身份行（实体名/别名/实体 id/来源模块/note）五个工具都带——deferred 模式下会被截到 600 字，得让 AI 先认出「这是哪个对象」；**列清单只给 `create`/`update`/`list`**（要照着填、照着查的），`get`/`delete` 的返回值自解释。五个工具各抄一遍列清单是白烧 token。写工具统一附一句「列结构不能用 `profile.field.propose` 改，要改走 `dyn.module.register`」，免得 AI 走错门。
- **parameters 也按 manifest 生成**：`list` 的 `filterField`/`sortField` 用 `enum` 收窄到 queryable 列（AI 少猜一次，白名单外的列压根递不进来）；实体没有 queryable 列时**整个不给 enum**（空 enum 会把任何值都判为非法）；`filterValue` 声明为 `string`，按列类型还原。写工具的 `expectedVersion` 是 `integer` + `required`——乐观并发不可绕过。
- **查询值转换规则收敛到 core**：`dyn-store.ts :: coerceQueryValue(column, raw)` 成为唯一实现，B.3 端点与 B.4 工具共用（两处各写一遍必然漂移）。`routes/dyn.ts` 只保留错误语义映射（存储层抛 422 语义的 ValidationError，端点包成 400 Bad Query）。同时导出 `LIST_LIMIT_MAX` / `LIST_LIMIT_DEFAULT`，端点与工具的 limit 文案不再各写一个 200/50。
- ⚠️ **进程级总线 vs per-workspace manifest（本项唯一妥协，别当 bug 修）**：`ToolBus` 是进程级单例，而 description/parameters 是注册期固化的。两个 workspace 装同 id 模块但 schema 不同时，后注册者的**文案**覆盖前者。**正确性不受影响**——校验与白名单一律按调用方 workspace 的 manifest 现判。①② 的实际形态是单 workspace（`ONE_WORKSPACE`），多租户隔离是 ③ 的事。
- **工具分组未改**：`ai/src/tool-catalog.ts :: toolGroup` 的规则是「`wms.*` 取第二段，其余取第一段」，所以全部 dyn 工具挤进 `dyn` 一组，`tools.load dyn` 会一次展开全部声明式实体的工具。当前判定为可接受（B.7 的示例模块只有 1–2 个实体），**未改 tool-catalog**；等示例模块落地后若一组过大再按实体细分。
- **AI 侧零改动即生效**：`ai/src/agent-defs.ts :: builtinAgentDefs` 按 `permission` 现场过滤 `ws.tools.list()`，新工具自动进 general/readonly（读）与 general/config（写）；`routes/chat.ts :: allowApply` 只认 `wms.` 前缀，dyn 写工具不会被附件落库路径误放行。
- **验收（已达成）**：新增 `core/test/dyn-tools.test.ts` 10 例——装前总线为空/装后五个工具与读写权限分明、description 含实体名与 note 与列含义且 queryable 标记只落在声明列上、`filterField` enum 收窄、无 queryable 列时不给 enum、经总线端到端 create→list(过滤/排序/翻页)→get→update→delete、缺 `expectedVersion` 与版本不对都被拒、四类错误消息可行动（含「另一个 workspace 调用同一条总线上的工具解析不到实体」）、**重启后工具自己装回总线**、**卸载后工具仍在但调用失败且重装即恢复**、重复同步幂等不留两份。
- 基线：typecheck 全绿（core/wms/ai/server）；core 177 → **187**（+10）、server **186** 全绿、wms **361** 全绿。§B.3 遗留的那条已知红灯（`api.test.ts` mock provider 剧本）本轮已不复现。

### B.5 写操作二次确认 ✅ 已完成

⚠️ **更正方案原文的两处事实错误**：
1. `permission` 的实际类型是 `'read' | 'write'` 二值（`core/src/bus/tool-bus.ts :: ToolDefinition.permission`），**不存在** `.write` / `.create` / `.delete` 这种点分词表。擅自扩枚举会连带打破 `install()` 预检 5 的 permission 一致性比对与 `manifest-validate.ts` 的白名单校验。
2. 它也**不是「无消费方」**，现有三处在用：
   - `server/src/routes/chat.ts :: allowApply`——判定助手是否有业务写权限
   - `ai/src/agent-defs.ts`——只读助手的工具集按 `permission === 'read'` 过滤
   - `app/src/pages/agent-tools.ts :: permissionRank`——UI 分类与筛选

**做法（沿用现有二值，不引入新词表）**：
- `permission === 'read'` 的工具直通
- `permission === 'write'` 的工具返回待确认令牌，前端二次提交才执行
- 令牌需带过期与幂等键，避免重复提交造成双写

**实施结果（事实记录）**：

- **落点**：新增 `server/src/tool-confirm.ts`（`ConfirmGate`：内存 Map + TTL）与 `server/src/routes/tools.ts`（`POST /api/tools/:toolId/invoke`、`POST /api/tools/:toolId/confirm`）。闸门挂在 `AppContext.confirmations`，路由随 `createApp` 挂到 `/api/tools`。
- **分流口径**：`read` → 直接 `ws.tools.invoke`，200 `{ pending:false, toolId, label, result }`；`write` → **不执行**，202 `{ pending:true, token, expiresAt, toolId, label, permission, params }`。⚠️ 用 202 而不是 200：让「还没执行」在状态码上就看得出来，只看 `res.ok` 的粗心客户端不会把它当成写成功。
- **令牌 TTL** 默认 5 分钟（`CONFIRM_TOKEN_TTL_MS`），可由 `createAppContext({ confirmTokenTtlMs })` 注入（测试注入位，与既有 `appVersion` 同类）。过期项靠**惰性清扫**回收，不起定时器——定时器会吊住测试进程，还得管卸载时机。
- ⚠️ **令牌的「一次性」不靠删除实现**：`consume()` 校验后不删，而是把令牌本身当幂等键传给 `ws.tools.invoke` → 命中既有 `tool_idempotency` 表，第二次确认**回放首次成功结果**而不重跑 handler。于是双击 / 网络重发既不双写，客户端还能拿到同一份结果。该表只缓存成功，所以业务失败后同令牌可重试（测试里有对照组：先失败、补建记录、同令牌再确认即成功）。
- **顺带更正上面第 2 条**：`permission` 的消费方其实是**四处**，漏了 `ai/src/wms-agent.ts`——它按 `permission === 'write'` 挑出写工具，用 callId 当幂等键调 `ws.tools.invoke`。B.5 正是复用这套幂等基建，没有新造去重表。
- **令牌绑定 `(workspaceId, toolId)`**，`consume` 两者都校验，串工具 / 串工作区 → 409。⚠️ 少这两行，任意一张令牌就成了万能钥匙。
- **确认时执行的是令牌里冻结的 params 与 actor**，本次请求体除 `token` 外一律忽略——「确认的」和「执行的」必须是同一件事，否则确认框只是装饰（测试直接塞了一份 `params` 试图改主意，落库内容不受影响）。
- **调用方不许在 `params` 里自带 `idempotencyKey`**（→ 400）：幂等键只能由令牌充当，否则「确认的那次」和「执行的那次」可能落在不同幂等键上，防双写失效。
- **错误码**：新增 `ConfirmTokenError`（`CONFIRM_TOKEN_INVALID`）→ **409**（语义是「这次确认作废了」，前端该重新发起，不是原地改参数重试）；`STATUS_BY_CODE` 补 `TOOL_NOT_FOUND: 404`（此前该码落到 400 兜底，与「没这东西」的语义不符）。工具入参类问题沿用 core 的 `ToolValidationError` → 400，不新造错误类。
- **刻意不动的部分（范围决策）**：① 既有点名端点 `/api/dyn/*`、`/api/wms/*` 不加闸——各有业务语义与既有前端契约，B.2/B.3 测试零改动；② AI 通道不加闸——AI 写操作的护栏是慢通道 `propose→confirm`（配置类）+ 幂等键（数据类），给每个 write 工具插一次人工确认会直接毁掉对话体验。本端点是「写操作暴露给前端」的唯一确认口，B.6 的 SDUI 通用列表页从这里写。
- ⚠️ **令牌是进程内存态**：重启即全失效（前端拿到「令牌不存在」重新发起即可，无数据损失），也不跨进程。①② 的实际形态是单进程单机（`ONE_WORKSPACE`），不构成问题；真要多进程，把 Map 换成一张表即可，调用点不动。
- **前端消费者随 B.6 落地**：通用端点已就绪，SDUI 列表页的写按钮走 invoke → 弹确认框 → confirm 三步。
- **验收（已达成）**：新增 `server/test/tool-confirm.test.ts` 15 例——read 直通 / write 只发令牌且库里一条没多 / confirm 才落地 / 过期 409 / 串工具 409 / 跨工作区 409 / 伪造与缺失令牌 / 工具不存在 404（invoke 与 confirm 同口径）/ read 调 confirm 被拒 / 自带幂等键被拒 / 请求体与 params 不合法 400（空 body 合法）/ 同令牌双确认幂等回放且只有一条 / 两张令牌写同记录仍真冲突（闸门不掩盖业务错误）/ 参数冻结 / 失败可重试。
- 基线：typecheck 全绿（core/wms/memory/ai/server）；`packages/server` 186 → **201**（+15）全过，core/wms/app 本轮未改动。

### B.6 SDUI（界面）✅ 已完成（`settings.schema` 渲染器拆下一轮）

前端是 Vite 打包的静态 `dist`，**运行时无法加载新的 React 组件**。方案是服务端驱动 UI：

1. `manifest` 增加 `ui` 贡献字段——⚠️ **`manifest-types.ts` 并未预留该字段**，只有注释写了「ui / jobs / entry / rules 不实现（无 v1 消费方，v2 生长点）」。需真正新增 `ModuleManifest.ui` 类型定义，并同步放行 `manifest-validate.ts`（否则声明式模块带 `ui` 会被校验拒绝）
2. `app-nav.tsx :: Page` 从字面量联合改为 `BuiltinPage | (string & {})`——**保留内置调用点的编译期检查与补全**
3. 新增运行时页面注册表
4. 通用实体列表页组件——推广 `SkusPage.tsx` 的动态列闭环（列定义来自 manifest）
5. `settings.schema` 表单渲染器——复用 `SkuFormModal.tsx :: fieldControl` 模式（⚠️ **本轮未做，拆到单独一轮**：它与页面清单不同源，是「模块设置项」而不是「实体页面」，硬塞进本轮会让通用列表页背上第二套表单语义）
6. `nav.ts :: categoryOfPage` 的兜底逻辑**原样保留**，保证未知页面不崩

**不做**：Web Component（AntD 的 portal/弹窗会逃出 shadow DOM）、动态 `import()` ESM（React 实例共享 + 版本对齐极脆弱）、iframe（除非将来出现声明式覆盖不了的需求，届时再在 `static.ts` 加插件资源挂载点）。

**实施结果（事实记录）**：

- **落点**：core 新增 `ManifestUi` / `ManifestUiPage` / `UiPageKind` / `UI_PAGE_PREFIX` / `UI_PAGE_KINDS`（`manifest-types.ts`）与 `validateUi` + `isUiPageId`（`manifest-validate.ts`）；server 新增 `routes/ui.ts`（`GET /api/ui/pages`）；app 新增 `api/ui-api.ts`、`pages/DynamicPage.tsx`、`pages/RecordListPage.tsx`。
- **页面清单端点**：`GET /api/ui/pages` 一次返回 `{ pages: [...] }`，**内联该实体的列定义与读写工具 id**（`record.fields[]`、`record.tools.{list,get,create,update,delete}`）。不扩 `/api/profile/catalog`——那份是「配置能力目录」，混进渲染描述会让两个消费方互相牵制。
- **只下发已安装且 `enabled` 的模块页面**，且 `record` 必须能在 `ModulesView.dynRecords()` 白名单里解析到；解析不到就**整页跳过**而不是发个空壳——⚠️ 空壳会在前端渲染成一张 404 的表，比「导航里没这一项」难查得多。
- **`record.type` 用 `record.id.slice(record.id.lastIndexOf('.') + 1)` 反推**，不引 `DYN_RECORD_PREFIX` 常量拼串。⚠️ 曾按前缀长度 slice，结果 `@one/core` 在 vitest 下解析到陈旧 `dist`、常量运行时为 `undefined`，切出来的 type 是错的；改用 `lastIndexOf('.')` 后与打包产物无关（type 词法不含点号，安全）。
- **命名空间**：页面 key 形如 `ui.{moduleId}.{pageId}`，与实体的 `dyn.{moduleId}.{recordId}` 同构。`isUiPageId` 复用 `RECORD_ID_RE`（不含点号）保证段内不再嵌点，与内置裸 key（`skus`、`inbound`…）结构性不撞。
- **`category` / `icon` 存自由字符串**：core 是领域无关层，导航大类与图标库都是 app 的知识，让它认识 `CategoryKey` 就是反向依赖。映射规则长在 `app/src/nav.ts`：`navCategoryFor` 认不出一律归「档案」，`navIconFor` 走**图标白名单**（只收本文件已 import 的 30 个）——⚠️ 「按名字取任意图标」在 Vite 打包后无从实现，白名单是唯一能静态打包的做法。写错一个词的后果是位置不对/图标默认，页面不会消失也不会崩。
- **`Page` 开放**：`app-nav.tsx` 拆成 `BuiltinPage`（27 个字面量）与 `Page = BuiltinPage | (string & {})`。⚠️ 不能写 `BuiltinPage | string`——TS 会直接塌成 `string`，18 处 `navigate('字面量')` 调用点的编译期检查与补全全丢。本轮 typecheck 验证既有调用点零改动。
- **运行时注册表**：`App.tsx :: PAGE_COMPONENTS` 的类型**仍收在 `Record<BuiltinPage, ComponentType>`**（不是开放后的 `Page`）——漏登记内置页面会当场编译报错，这份穷尽性检查是白拿的，别顺手改宽。查不到就落到 `DynamicPage`。⚠️ 那句 `?? DynamicPage` 不能省：本项目未开 `noUncheckedIndexedAccess`，索引不到不会报错，只会渲染 `<undefined />` 白屏。
- **`DynamicPage` 三个分支都必须渲染出东西**：清单加载中 → `Spin`；清单失败 / 找不到该 page（模块刚停用、已卸载、旧书签）→ `Result「页面不可用」`；kind 前端不认识（新模块配旧前端）→ `Result「暂不支持这种页面」`。渲染器表用 `Partial<Record<UiPageKind, …>>`，让「未知 kind」在类型上就诚实返回 undefined。
- **通用列表页 `RecordListPage`**：表头、单元格呈现、表单控件、可过滤列、读写工具 id 全部来自 descriptor，不含任何领域知识（与 `SkusPage` 分工：那是内置页，有 SKU 专属动作与跳转）。`date` 列用纯文本框而非日期控件——不为一个声明式页面引入日期库。
- **写操作三步（消费 B.5 闸门）**：`invoke` 拿令牌 → `modal.confirm` 摊开「服务端将要写什么」（入参 JSON 原文）→ `confirm` 落地。封成 `useRecordWrite` 一个 hook，⚠️ 漏掉第三步的后果是「界面提示成功、库里没数据」，这种静默失败不该依赖每个调用点都记得。表单弹框在 `invoke` 前先关，两层弹框叠着人看不清要确认哪一层。确认失败（令牌过期 409）只提示不 rethrow——重试没有意义，关掉让人重新发起。
- **过滤能力受 `/api/dyn` 约束**：只支持 `filter` + `equals`（单列精确匹配，且列必须 `queryable`），所以通用页做成「下拉选列 + 输入框精确匹配」，**不做自由文本搜索**。`filter`/`equals` 必须成对才下发，只给字段不给值服务端会 400。
- **导航高亮**：`categoryOfPage` 对 `ui.*` 只会兜底到第一个大类（看板），高亮就错了。`ModuleRail` 先查页面清单再回落内置那套；`nav.ts` 的兜底逻辑按子项 6 **原样保留**。动态导航项**不设 `NavItem.moduleId`**——那字段是「内置项按模块开关显隐」的过滤条件，而动态页面已由服务端按 enabled 过滤过一遍，再挂上只会被二次过滤，两份真相迟早对不上。
- **验收（已达成）**：core 新增 3 例（合法页面零错误 + `isUiPageId` 四形态 / 七项非法逐条 / `ui` 与 `ui.pages` 结构错误）；server 新增 `test/ui-routes.test.ts` 8 例（空清单 / 内联列与 `module`+`type` 对齐且回打 `/api/dyn` 得 200 / 工具 id 与总线注册一致 / `category`+`icon`+`description` 透传 / 可选字段键缺席 / 停用模块不下发 / 卸载后消失 / 多页面顺序）；app 新增 `test/record-list-page.test.tsx` 8 例 + `module-rail.test.tsx` 3 例。
- 基线：typecheck 全绿（core/server/app）；core 187 → **190**，server 201 → **209**，app 197 → **208**（197 例既有回归全过）。

### B.7 示例模块 + CI 守卫

建一个**纯 JSON** 的示例声明式模块（一张实体、若干字段、一条流程），接入 CI 跑全链路：注册 → 存储 → 端点 → 工具 → 界面。

**双重价值**：活文档（客户照抄）+ 回归守卫（改动破坏扩展点则 CI 立刻红）。
无需构建、无需 external 名单、无需 Node 版本对齐。

### B.8 受限条件 DSL（已定调，暂不排期）

**触发条件**：真实客户提出字段级业务规则需求（如「效期不足 30 天禁止出库」「同一库位禁止混批」）。

现状：`profile-types.ts :: when` 只认 `module.{id}.enabled`；`effect` 只有 `increase`/`decrease`/`check`/`none` 四个枚举值。流程层表达能力非常窄。

**定调：做受限 DSL，不做通用表达式引擎。**

```
白名单字段 + 白名单运算符 + 纯布尔组合
无循环、无函数调用、无副作用、无 I/O
```

| 性质 | 为什么成立 |
|---|---|
| 天然可终止 | 没有循环结构 |
| 执行前可静态校验 | 字段存在性、类型匹配、运算符适用性，全部可在提案阶段拒绝 |
| 可跨端求值 | DSL 是数据，三条线、两种存储都能求值，甚至可下推到 SQL |
| AI 可安全生成 | 生成的是可校验的数据，不是不可信的代码 |

⚠️ **禁止**为此引入 `eval` / `new Function` / 嵌入式脚本引擎。见 §1.2 红线。

---

## 5. Phase C · 分发与治理

**触发条件**：模块需要跨客户/租户复用。

- JSON 包导入导出 + schema 校验
- **展示变更清单 + 人工确认**（符合「配置变更必须人工确认」硬约束）
- 落 `module.installed` 事件 → 提示生效范围
- 版本兼容与冲突处理：**复用 B.1 的 6 道预检**

不需要签名链、不需要沙箱、不需要权限清单裁剪——因为没有代码执行。JSON schema 校验就是全部安全面。

⚠️ **③ 是配置即代码的唯一例外**：租户配置直接决定服务端行为，恶意/错误配置可能放大成平台级故障。需要**平台侧**做配额与校验（如单租户实体数上限、字段数上限、DSL 复杂度上限），这属于 ③ 的范畴，不在本仓库。

---

## 6. Phase P · 领域逻辑可移植性

**触发条件**：③ 立项。

**范围比「抽象整个存储层」小得多。** ③ 复用**前端 + HTTP 契约**，不复用 `packages/server` 实现（Hono 路由、单 ctx 闭包、SQLite、P2P 同步协议、Tauri 壳、sidecar 打包全部另写）。因此只需保证**领域逻辑与 SQL 方言解耦**：

```
core 定义：EventStore / ProjectionStore / RegistryStore 接口
本仓库实现：SqliteEventStore（现状透传）
③ 实现：PostgresEventStore
领域逻辑（core 护栏、wms 事件应用、Profile 服务）不碰 SQL 方言
```

**高复用价值，③ 应直接搬**：
- 事件模型 / oplog 结构 / 双时钟（节点 seq + 跨节点 lamport）全序重放
- `ModuleManifest` 契约 + Profile 三层配置（字段/流程/模块）
- WMS 领域逻辑：库存联动效应点、批次分配策略、效期出库拦截、流程转移规则
- 投影/重放机制、字段 owner/usedBy 所有权模型、模块安装 6 道预检

**约束现在就生效**：B.2 的通用记录存储必须用可移植 SQL（不写 SQLite 方言），因为它是 ③ 也要用的。**生成列（generated column）因此被排除**——SQLite 与 Postgres 的生成列语法、JSON 取值函数、列类型都不一致，详见 B.2。改用独立索引表 `dyn_index` 承接可查询字段。

---

## 7. 实施顺序与验收

```
Phase A · 契约固化
  [x] A.2 actor 单点收敛（本地工作区已实现，待提交；剩余调用点待核查）
  [ ] A.1 API base URL 可配置（含 CORS + Tauri origin + SSE 跨源验证）
  [~] A.3 OpenAPI + 契约测试双跑 —— **暂缓**，等 §8 决策 + ③ 立项
  [ ] A.4 卸载后工具不可见 —— **改为授权层过滤，不动 ToolBus**（唯一行为变更，重点跑测试）
  ── 验收：前端指向远程后端可正常工作（含 SSE）；模块卸载后 AI 取不到其工具，且重装成功 ──

Phase B · 声明式模块（主线）
  [x] B.0 per-group 投影版本（前置件）—— 已完成，老库无需迁移（key 形状未变）
  [x] B.1 records 可配置 + dyn.module.register 提案类型 —— 已完成（manifest 随 config.change 落账；提案 kind 分派；命名空间/撞名/类型三关；effectiveManifests 保证 AI 可见）
  [x] B.2 dyn_records 单表 JSON + dyn_index 独立索引表 + record.* 事件 —— 已完成（per-module 投影组 + 构造期追账 + 安装后整组重投影 + facade.replay 纳入 dyn；孤儿数据保留但不可访问）
  [x] B.3 通用 record 端点（白名单严格来自 manifest，未声明一律 404）—— 已完成（`/api/dyn/:module/:type[/:id]`；白名单取自 `ModulesView.dynRecords()` 与存储层同源；分页/排序/过滤只作用 queryable 列；404/409/422/400 四档分明）
  [x] B.4 通用 record 工具注册，description 从 manifest 动态拼装 —— 已完成（`core/src/dyn/dyn-tools.ts`；两处注册时机：facade 构造全量同步 + install 成功后回调；description/parameters 全部按 manifest 生成；同 id 覆盖注册，⚠️ 从不 unregister（§A.4））
  [x] B.5 写操作二次确认（沿用现有 `permission === 'write'`，不扩枚举）—— 已完成（`server/src/tool-confirm.ts` + `server/src/routes/tools.ts`；`POST /api/tools/:id/invoke` read 直通 200、write 只发令牌 202，`POST /api/tools/:id/confirm` 才执行；令牌 TTL 5 分钟、绑定 (workspaceId, toolId)、冻结 params/actor，且自身充当幂等键复用既有 `tool_idempotency` 防双写；既有 `/api/dyn`、`/api/wms` 与 AI 通道刻意不加闸）
  [x] B.6 SDUI：新增 ModuleManifest.ui + Page 改 string + 运行时注册表 + 通用列表页 + settings.schema 渲染器 —— 主体已完成（`settings.schema` 渲染器**拆到单独一轮**，本轮未做）。core 加 `ManifestUi`/`ManifestUiPage` 与 `validateUi`+`isUiPageId`；server 加 `GET /api/ui/pages`（内联列定义与读写工具 id，只发已安装且 enabled 的模块，解析不到整页跳过）；app 拆 `BuiltinPage | (string & {})`、`PAGE_COMPONENTS` 查不到落 `DynamicPage`、新增 `RecordListPage` 通用列表页（列/表单/过滤全来自描述，写操作走 B.5 的 invoke→确认框→confirm），`ModuleRail` 按 `category` 白名单插动态页面（认不出归「档案」，图标走白名单）
  [ ] B.7 纯 JSON 示例模块 + CI 全链路守卫
  ── 验收：一份 JSON 即可新增业务对象，端到端可用，AI 立刻可用，零第三方代码 ──

B.8 · 受限条件 DSL（已定调，暂不排期）
  触发条件：真实客户提出字段级业务规则需求
  [ ] 白名单字段 + 白名单运算符 + 纯布尔组合；无循环/无函数调用/无副作用/无 I/O
  [ ] 提案阶段静态校验（字段存在性 / 类型匹配 / 运算符适用性）

Phase C · 分发与治理（触发条件：模块要跨客户/租户复用）
  [ ] JSON 包导入导出 + schema 校验 + 变更清单人工确认
  [ ] 版本兼容与冲突处理（复用 6 道预检）

Phase P · 可移植性（触发条件：③ 立项）
  [ ] core 抽出 EventStore / ProjectionStore / RegistryStore 接口
  [ ] SqliteEventStore 实现（现状透传）
  [ ] 领域逻辑与 SQL 方言解耦验证
```

### 7.1 每个 PR 的通用验收门槛

```
npm run typecheck     # 必须全绿
npm run test          # 必须全绿，且不低于改动前的用例数
```

⚠️ **Windows PowerShell 环境，不支持 `&&` 连接命令**，分开执行。

改动 `packages/desktop/stage.ps1` 或新增 workspace 包时，**额外**要求：实际打一次便携版并启动验证（junction 替换是静默失败点）。

### 7.2 开工前先跑基线

在动任何代码之前执行一次 `npm run typecheck` 与 `npm run test`，记录是否全绿与用例数。**基线不绿则先修基线**，否则后续无法判断问题来源。

---

## 8. 战略前置决策（不属于实施，但必须先有答案）

**③ 是否接受「断网停工」？**

③ 形态是「客户端仅存 + 数据全在平台」。仓库现场断网 = 无法出入库。对 WMS 这可能是不可接受的。

- 若接受 → 本方案全部成立
- 若不接受 → ③ 必须做离线模式，那 ③ 就不再是「另起一套服务端」，而是「本仓库 + 多租户 + 同步」，**Phase A/P 的范围要重新评估**

**这个决策必须在 ③ 立项前做出。它决定整个架构，不能开发到一半才发现。**
