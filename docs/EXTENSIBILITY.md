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

### B.1 放开 `records` 为可配置

- `manifest-types.ts :: ModuleManifest` 允许 `records` 由声明式模块提供
- 新增 `dyn.module.register` 提案类型，挂进现有 Profile 提案管线（提案 → 影响报告 → confirm/reject）
- **复用 `module-registry.ts :: install()` 的 6 道预检，一行不改**
- 校验：实体 id 命名空间隔离（建议 `dyn.{moduleId}.{recordId}`）、字段类型白名单、与内置实体撞名拒绝

### B.2 通用记录存储（单表 JSON + 独立索引表，不做动态 DDL）

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

### B.3 通用 record 端点

- `GET/POST/PATCH/DELETE /api/dyn/:module/:type[/:id]`
- **白名单严格来自 manifest**：未声明的 module/type/字段一律 404，不做兜底
- 分页、排序、过滤参数只允许作用于 manifest 声明为可查询的字段

### B.4 通用 record 工具注册到总线

- 为每个声明实体注册 `dyn.{module}.{type}.list/get/create/update/delete`
- **工具 description 从 manifest 动态拼装**（实体名、字段名、字段含义、枚举值）

⚠️ **这一项不能省**。否则配置了新实体 AI 也不知道，「AI 立刻可用」不成立。

⚠️ `tool-bus.ts :: permission` 是 `'read' | 'write'` 二值，**已有消费方**（见 B.5 更正）。但 B.3/B.4 一开放，等于把全部写操作暴露给前端。**B.5 是硬要求，不是可选项。**

### B.5 写操作二次确认

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

### B.6 SDUI（界面）

前端是 Vite 打包的静态 `dist`，**运行时无法加载新的 React 组件**。方案是服务端驱动 UI：

1. `manifest` 增加 `ui` 贡献字段——⚠️ **`manifest-types.ts` 并未预留该字段**，只有注释写了「ui / jobs / entry / rules 不实现（无 v1 消费方，v2 生长点）」。需真正新增 `ModuleManifest.ui` 类型定义，并同步放行 `manifest-validate.ts`（否则声明式模块带 `ui` 会被校验拒绝）
2. `app-nav.tsx :: Page` 从字面量联合改为 `BuiltinPage | (string & {})`——**保留内置调用点的编译期检查与补全**
3. 新增运行时页面注册表
4. 通用实体列表页组件——推广 `SkusPage.tsx` 的动态列闭环（列定义来自 manifest）
5. `settings.schema` 表单渲染器——复用 `SkuFormModal.tsx :: fieldControl` 模式
6. `nav.ts :: categoryOfPage` 的兜底逻辑**原样保留**，保证未知页面不崩

**不做**：Web Component（AntD 的 portal/弹窗会逃出 shadow DOM）、动态 `import()` ESM（React 实例共享 + 版本对齐极脆弱）、iframe（除非将来出现声明式覆盖不了的需求，届时再在 `static.ts` 加插件资源挂载点）。

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
  [ ] B.1 records 可配置 + dyn.module.register 提案类型
  [ ] B.2 dyn_records 单表 JSON + dyn_index 独立索引表 + record.* 事件
  [ ] B.3 通用 record 端点（白名单严格来自 manifest，未声明一律 404）
  [ ] B.4 通用 record 工具注册，description 从 manifest 动态拼装
  [ ] B.5 写操作二次确认（沿用现有 `permission === 'write'`，不扩枚举）
  [ ] B.6 SDUI：新增 ModuleManifest.ui + Page 改 string + 运行时注册表 + 通用列表页 + settings.schema 渲染器
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
