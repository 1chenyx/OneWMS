# @one/core 内核架构

> 配套 [DESIGN.md](./DESIGN.md)（系统设计蓝图）。本文回答「代码长什么样、每个文件管什么、谁能依赖谁」。

## 分层地图

```
┌─ 出口层 ─────────────────────────────────────────────┐
│  index.ts            公共 API 唯一出口（内部路径非 API）│
├─ 组合层 ─────────────────────────────────────────────┤
│  core.ts             OneCore：生命周期 + workspace() 工厂 │
│  workspace/          WorkspaceFacade：能力组合与工作区绑定  │
├─ 服务层 ─────────────────────────────────────────────┤
│  oplog/oplog-store.ts        账本存取（append/ingest/全序）│
│  registry/field-registry.ts  字段注册（事件投影 + 命令）    │
│  profile/profile-service.ts  Profile 聚合 + 热应用编排（M4）│
│  profile/proposal-store.ts   提议登记（进程内存态，M4）    │
│  profile/propose-tool.ts     profile.propose 工具（M4）   │
│  bus/tool-bus.ts             工具注册与分发                │
│  sync/sync-service.ts        节点间同步编排（M5）           │
│  modules/module-registry.ts  模块安装/卸载编排（M6）        │
│  crypto/key-service.ts       工作区密钥管理（M7）           │
│  migration/migration-service.ts 迁移包导出/导入（M7）       │
├─ 基础层 ─────────────────────────────────────────────┤
│  profile/profile-types.ts    Profile 纯类型 + 空快照构造   │
│  profile/patch.ts            JSON Patch 应用器（纯函数）   │
│  profile/validate.ts         校验管线三关（纯函数）        │
│  profile/impact.ts           影响报告生成（纯函数）        │
│  oplog/envelope.ts           事件信封（纯类型 + 构造）      │
│  registry/key-naming.ts      字段键命名（纯函数）           │
│  bus/schema-validator.ts     参数校验（纯函数）             │
│  sync/sync-protocol.ts       握手载荷 + 拉取计划（纯函数，M5）│
│  crypto/seal.ts              事件密封/解封（纯函数，M7）     │
│  modules/manifest-types.ts   manifest 纯类型 + 能力词表（M6）│
│  modules/manifest-validate.ts manifest 结构校验（纯函数，M6）│
│  db/migrations.ts            表结构（schema 唯一定义点）    │
│  errors.ts                   错误类型（纯类型）             │
└──────────────────────────────────────────────────────┘
```

## 依赖方向规则（白名单制）

1. **只能向下**：出口层 → 组合层 → 服务层 → 基础层。任何反向 import 禁止。
2. **服务层之间**：许可的横向依赖共七条，均须登记理由：
   - `field-registry → oplog-store`：注册表是事件投影（§8 唯一真相纪律的代码化）；
   - `profile-service → oplog-store`：热应用落 `config.change` 事件、追账读账本（同上）；
   - `profile-service → field-registry`：Profile 是「注册表状态 + config 状态」的聚合视图，热应用的字段部分翻译成注册表命令（§5.2 字段属于注册表）；
   - `profile-service → proposal-store`：确认工作流的编排方与登记方；
   - `propose-tool → tool-bus`（type-only，编译期擦除）：工具定义类型 `ToolDefinition` 的规范源在总线，造工具定义者引用之——无运行时耦合。
   - `sync-service → oplog-store`：同步是账本的对外交换通道（§8.5 ③ 按 actor 交换、水位握手的直接实现）；
   - `sync-service → profile-service`：profileVersion 是握手比较位（§8.5 ②，经轻量 `getVersion` 读取，不聚合全快照）；
   - `module-registry → oplog-store`：module.installed/uninstalled 生命周期审计事件落账（§8.2 事件目录）；
   - `module-registry → field-registry`：安装/卸载的字段轨道（provides/requires 驱动命令、unregister 逆操作）；
   - `module-registry → profile-service`：modules 段与 workflows 贡献经 `applyDirect` 落账——config 部分写路径唯一（真相源分治）；
   - `module-registry → tool-bus`：安装期「manifest 工具声明 ↔ 总线事实」一致性校验（listTools 只读比对）；
   - `migration-service → oplog-store`：迁移是账本的全量导出/导入通道（§8.5 迁移与同步同构——同一动作的两种节奏）；
   - `migration-service → profile-service`：profileVersion 是迁移包元信息（同 sync-service 的 getVersion 轻量读取）。
   新增横向依赖必须在此登记理由。
3. **基础层之间允许纯函数/常量的单向复用，禁止环、反向与有状态依赖**：
   - 现存单向边：`validate → patch`（校验器在虚拟快照上工作，内聚地调用应用器）、`validate → profile-types`（PATCH_ROOTS 常量）、`schema-validator → errors`、`patch/impact/proposal-store → profile-types|impact`（type-only）、`manifest-validate → manifest-types|schema-validator`（类型与词表常量 + ParameterSchema 结构复用）、`seal → envelope|errors`（type-only + 错误类型——密封的是信封，纯函数复用其形状）；
   - `errors.ts` 不 import 任何东西，是人人可引用的零依赖叶子；
   - 基础层 → 服务层**禁止**（历史缺陷已修：FieldSharing 曾定义在 field-registry、被 key-naming 反向引用，现已下移到 key-naming 作为定义点）。
4. **领域隔离**：本包不得出现仓储词汇（SKU/库存/单据）——那是 `@one/wms` 的领地（§13.5 平台化口子）。profile/ 把 entity/workflow/module 当**不透明键**处理：只做结构校验与图算法，不解释仓储语义；基础流程内容作为种子数据由领域包注入。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `core.ts` | 进程生命周期：open（建库/迁移/nodeId）、close、workspace() 工厂、领域装配口（exposeDb/exposeToolBus/exposeModuleRegistry，§13.5 口子 1 的落点）、构造 ProfileService 并注册 profile.propose 工具 | 不含任何业务逻辑 |
| `workspace/workspace.ts` | WorkspaceFacade：持有五个 View 实例 + replay() | 只组合与委托，不实现能力 |
| `workspace/events-view.ts` | 账本的工作区绑定视图：append/ingest/forEach/byActor/watermarks/count | 不做事件语义校验之外的任何业务判断 |
| `workspace/fields-view.ts` | 注册表的工作区绑定视图：provide/require/setVisibility/unregisterModule/list/get | 只绑定 wsId 并委托 FieldRegistry |
| `workspace/tools-view.ts` | 工具总线的工作区绑定视图 + 向 handler 注入 ToolContext（含 appendEvent 受控入口） | 不做业务校验（那是 handler 的事，§7 规则即护栏） |
| `workspace/profile-view.ts` | Profile 的工作区绑定视图：getSnapshot/propose/confirm/reject/listPending/seedDefaults | 只绑定 wsId 并委托 ProfileService |
| `workspace/modules-view.ts` | 模块系统的工作区绑定视图：install/uninstall/listInstalled/listManifests/getManifest | 只绑定 wsId 并委托 ModuleRegistry |
| `oplog/oplog-store.ts` | 事件账本：事务内分配双时钟、幂等 ingest、(lamport,actor) 全序遍历、水位、通道指纹（actorChecksums：per-actor eventId 集合 sha256） | 不解释事件内容（对 payload 透明） |
| `registry/field-registry.ts` | 字段注册：命令侧冲突校验 → 落事件 → applyEvent 投影；卸载移交/软删除语义 | 不存储业务数据本身（只管字段元数据） |
| `profile/profile-service.ts` | Profile 管线服务：快照聚合（注册表 + config 投影）、config.change 投影与追账游标、propose（校验三关 + 影响报告）、confirm（新鲜度检查 + 双轨热应用）、applyDirect（受管直接落账口，M6）、seedDefaults 幂等种子 | 不做提议登记（proposal-store）、不理解仓储语义（entity/workflow 是不透明键） |
| `profile/proposal-store.ts` | 提议登记（进程内存态）：pending → applied/rejected 生命周期、按 id 查询与列举 | 不落库不落事件（提议不是事实；重启丢弃 pending 是设计行为） |
| `profile/propose-tool.ts` | profile.propose 工具定义：AI 慢通道入口，参数 schema + 委托 ProfileService.propose | 不提供 confirm/reject 工具（确认权在人类，§4.1） |
| `bus/tool-bus.ts` | 工具注册表（进程内存态）+ invoke 三步：存在性→参数校验→handler | 不做业务校验、不落事件（事件由 handler 经 ctx 写） |
| `sync/sync-service.ts` | 节点间同步编排（进程级服务，方法带 workspaceId）：handshake（nodeId/版本/水位+通道指纹/计数）、eventsFor（按 actor 区间供事件 + 分页游标）、applyRemote（幂等摄入委托） | 不做网络 IO（传输在宿主层）、不碰投影（重建在门面 replay）、不裁决业务冲突（账本层无冲突，§8.3） |
| `modules/module-registry.ts` | 模块生命周期编排（进程级服务，方法带 workspaceId）：进程 manifest 目录（registerManifest）、install（预检 → 双轨落事件 + 审计事件）、uninstall（逆操作） | 不存安装状态（modules 段是唯一真相）、不直接落 config 事件（经 applyDirect）、不做运行时沙箱（v2 WASM） |
| `modules/manifest-types.ts` | manifest 纯类型族 + 能力词表 MODULE_CAPABILITIES + CORE_VERSION 常量（与 package.json 同步的手写纪律） | 无状态 |
| `modules/manifest-validate.ts` | manifest 结构校验（纯函数）：id/semver 格式、能力词表、字段类型域与 sharing、工具命名空间与 permission、contributes 结构、settings schema 粗校验 | 不做安装期检查（依赖/slot/状态冲突/在场性在 ModuleRegistry 预检）、不做 IO |
| `profile/profile-types.ts` | Profile 纯类型 + PATCH_ROOTS 常量 + 空快照构造（无副作用） | 无 IO、无状态 |
| `profile/patch.ts` | JSON Patch（RFC 6902 子集：add/replace/remove）应用器：路径解析 + 受控变更 + 克隆不改源 | 不做语义校验（那是 validate.ts）、不碰数据库 |
| `profile/validate.ts` | 校验管线三关（§9.1）：①语法（op/路径白名单）②语义（结构完整、流程连通性图算法、when 条件域、roles 冻结、字段操作约束） | 不生成报告（那是 impact.ts）、不做 IO |
| `profile/impact.ts` | 影响报告：应用前后快照 diff → 分条目（info/warning 分级 + 中文人话） | 不做裁决（人类确认） |
| `oplog/envelope.ts` | EventEnvelope 类型 + buildEnvelope 构造（uuid/时间戳/命名空间校验） | 不碰数据库 |
| `registry/key-naming.ts` | privatePrefix / qualifyKey：private 字段前缀化（§7.2 消撞名）；`FieldSharing` 类型的定义点（共享模式是键命名的语义核心） | 无状态 |
| `bus/schema-validator.ts` | JSON Schema 子集校验（type/required/enum/min/max/items） | 无状态 |
| `sync/sync-protocol.ts` | 同步协议纯函数层：`SyncHandshake`/`Watermarks`/`PullRange` 类型 + `computePullPlan`（双方水位差 → 拉取区间清单；水位持平 + 指纹不同 → 该通道全量区间。客户端视角） | 无状态、无 IO |
| `crypto/seal.ts` | 事件密封纯函数层（M7）：`SealedEvent` 类型 + `sealEnvelope`/`unsealEnvelope`（AES-256-GCM，payload 加密、信封明文）+ `keyFingerprint` | 不管理密钥（那是 KeyService）、不做 IO |
| `crypto/key-service.ts` | 工作区密钥管理（进程级服务，方法带 workspaceId，M7）：generate / get / importKey（SQLite 持久，已有 → KeyExistsError） | 不参与事件流（密钥是边界参数不是业务事实）、不做出库分发（export 是宿主端点的事） |
| `migration/migration-service.ts` | 迁移包编排（进程级服务，方法带 workspaceId，M7）：exportBundle（全量事件 + 元信息）、importBundle（结构校验 + workspaceId 一致性 + 幂等 ingest） | 不做 manifest 在场性报告（宿主层组装）、不碰投影（导入后 replay 在宿主）、不加密（迁移包是本地可信域文件） |
| `db/migrations.ts` | 全部内核表结构 + user_version 迁移 | 唯一允许 `CREATE TABLE` 的文件 |
| `errors.ts` | CoreError 族（code 供机器识别） | 无状态 |

## 命名约定

| 后缀/位置 | 语义 | 实例 |
|---|---|---|
| `*Store` | 有状态存取服务（对应存储区域） | OplogStore |
| `*Registry` | 有状态注册服务（登记/查询/生命周期） | FieldRegistry |
| `*Bus` | 有状态分发服务（注册方 ↔ 调用方） | ToolBus |
| `*View` | 工作区绑定视图（薄委托 + 参数绑定） | EventsView |
| `*Facade` | 组合门面 | WorkspaceFacade |
| 无后缀（纯函数/类型文件） | 无状态 | key-naming、schema-validator、envelope、errors |

## View 层的存在理由

服务层方法的第一参数恒为 `workspaceId`（§13.5 口子 2 的纪律）。View 在构造时绑定 workspaceId，调用方 thereafter 不再传——**纪律由类型系统代管，不靠开发者自觉**。五个 View 均为构造期创建的实例属性（非 getter），避免重复分配。

## 慢通道管线（里程碑 4）

> AI 改配置的唯一合法路径：`propose → 影响报告 → 人工确认 → 热应用`（DESIGN.md §4.1/§4.2/§9.1）。快通道（工具改业务数据）见 @one/ai 章节。

### 真相源分治（事件类型即分界）

| 配置域 | 真相源（事件） | 投影 | 说明 |
|---|---|---|---|
| 字段元数据（含 visible） | `registry.*`（M1 已实现） | field_registry 表 | 字段属于注册表（§7.1），命令侧校验（类型冲突/存在性）在 FieldRegistry |
| 流程 / 模块 / 角色 | `config.change`（M4 新增） | profile_state 表 | payload = `{ patch, profileVersion, summary }`；profileVersion 严格 +1 成链（§8.4） |

- **Profile 快照 = 聚合投影**：`schema.entities` 实时读注册表；`workflows/modules/roles` 读 profile_state。快照不单独存「第二份真相」。
- **与 DESIGN §8.2 的工程偏差**（已评估接受）：蓝图设想全部配置走 `config.change`；实现中**字段可见性走 `registry.field.visibility_changed`**（M1 既有命令路径，含存在性校验）。理由：① 避免 ProfileService 重复实现字段语义校验；② 不改 M1 公共 API；③ 两类事件各自可独立重放收敛（§8.5 ③ 按 actor 交换），聚合快照仍然一致。代价：profileVersion 链只覆盖 workflows/modules/roles——字段部分的同步完整性由 registry 事件流自身保证（M5 已落地：握手携带 per-actor 通道指纹兜底，见「同步回合」决策 4/5）。

### 热应用编排（confirm 的双轨）

确认一个 patch 时按路径分轨，**顺序固定**（确定性铁律）：

```
confirm(by, proposalId)
  1. 提议存在且 pending（proposal-store）
  2. sync() 追账 → 新鲜度检查：config 部分比 baseVersion、字段部分比涉及字段的现状指纹
     —— 不匹配 = 提议过期（StaleProposalError），拒绝应用，需重新提议
  3. 重跑校验管线（应用时刻的护栏，双保险）
  4. 轨道 A：/schema/** 操作逐条翻译成注册表命令（actor=确认者）：
       add extension      → fields.provide
       replace visible    → fields.setVisibility
       （remove 字段在校验关已被拒：软删除铁律，删除 = visible:false）
  5. 轨道 B：/workflows/** /modules/** /roles/** 操作 applyPatch →
     落一条 config.change（patch 仅含轨道 B 操作，profileVersion+1）→ 更新投影
  6. 提议标记 applied；返回新版本
```

- propose 阶段在**虚拟快照**（聚合当前态 + 内存 applyPatch）上做校验与 diff——报告所见即应用所得（新鲜度检查保证两时刻之间无变更）。
- **提议不落库**：pending 提议是进程内存态，重启即弃（用户重新让 AI 提议即可，无数据损失）。事件里只有已确认的 `config.change`——「提议不是事实」。
- **confirm/reject 永远不注册为 AI 工具**：人工确认权不可委托（§4.1 通道表）。它们是 ProfileView 的公共 API，由前端/CLI 调用。

### 校验管线三关（§9.1 的 v1 边界）

1. **语法关**：JSON Patch 结构合法（op ∈ add/replace/remove）、路径根 ∈ {`/schema`, `/workflows`, `/modules`, `/roles`}。
2. **语义关**（对应用后的虚拟快照）：结构完整（visible 是布尔、states id 唯一、transitions 的 from/to ∈ states、enabled 是布尔、settings 是对象）；**流程连通性**（states[0] 为初始态约定：全部状态从初始态可达、至少存在一个终态）；when 条件域（只认 `module.{id}.enabled` / `!module.{id}.enabled`，§5.3）；roles 冻结（v1 恒空对象，触碰即拒）；字段操作约束（禁止 remove、add 必须声明 providedBy、replace 只允许 visible）。
3. **预演关（v1 简化）**：影响报告 = 结构 diff 分条目（新增/隐藏/恢复字段、流程状态增删、模块开关），不扫业务数据行数（ext_data 行数统计需要领域表知识，跨层——留待领域消费方，M5+）。死锁细分析（互补条件覆盖）以 warning 软提示，不硬拒。

### 事件与表

- `config.change` 事件：actor = 确认者；payload `{ patch, profileVersion, proposalId?, summary }`。种子装载（seedDefaults）同样落此事件（actor = 领域模块标识）。
- `profile_state` 表：`(workspace_id PK, version, workflows JSON, modules JSON, roles JSON)`——config.change 的投影，命令路径与重放共用 applyEvent（与注册表同构）。
- ProfileService 持每工作区 lamport 游标（内存），View 方法入口 sync() 增量追账——ingest 远端事件后自愈（与 WmsWorkspace 同模式）。

### 与里程碑的接缝

- **M6 模块系统（已落地）**：manifest 驱动 fields.provide/require + ProfileService（modules 段 / workflows 贡献经 applyDirect），详见「模块系统（里程碑 6）」章节。**遗留临时状态**：M2 硬编码状态机仍是单据行为的权威（wms.order.transition 的 handler 裁决），workflows 配置（含模块贡献）仍只驱动 UI 候选按钮——「流程引擎消费配置面（基础 + contributes 合成 + when 条件求值）」是 M6 之后的接缝，两者内容在此期间保持一致。
- **M5 同步**：profileVersion 链即握手比较位（§8.5 ②，已随 `getVersion` 落地）；字段部分随 registry 事件流交换。详见下文「同步回合（里程碑 5）」。
- **@one/ai**：System Prompt 注入 Profile 摘要（§6.4 闭环 ②）；`profile.propose` 是 AI 的慢通道入口，返回影响报告由模型转述。

## 同步回合（里程碑 5）

> DESIGN §8.5 五步协议的 v1 落地。**账本交换是增量的（水位 + 区间 + 幂等摄入），投影更新是全量的（回合后 replay）**——「全量为真，增量为快」的最保守实现。

### 协议（拉模型，一次回合）

```
客户端                                    对端（任意节点）
  │ GET /api/sync/hello ──────────────────→│ ① 握手
  │ ← { nodeId, workspaceId, profileVersion,│    （水位 = 各 actor 的 seq 高位 + 通道指纹）
  │      watermarks, eventCount }           │
  │ computePullPlan(我的水位, 对端水位)      │ ② 纯函数：水位差→区间；持平+指纹分歧→全量
  │ GET /api/sync/events/:actor?fromSeq=.. ─→│ ③ 分页拉取（500/页）
  │ ← { events, nextFromSeq, hasMore }      │
  │ syncService.applyRemote(events)          │ ④ 幂等摄入（eventId 查重 + 计数器 MAX 推进）
  │ 若 accepted > 0 → ws.replayAll()         │ ⑤ 全量重建「内核 + 领域」投影
```

- **双向同步 = 两个方向的拉取回合**（A 拉 B、B 拉 A）；对等网无权威，谁触发都收敛。
- **同步组 = 同 workspaceId**：客户端校验 hello 返回的 workspaceId 与本地一致，不等则拒绝交换（密钥边界的前置形态）。
- **自拉防护**：hello 发现对端 nodeId 等于自己 → 跳过（配错 peer 指向自己时不自伤）。

### 关键决策与理由

1. **回合后投影全量重放，而非增量追账**：
   - `registry.*` 事件目前没有增量投影路径（命令路径是「落事件 + 立即投影」双写，ingest 远端事件不经过它）——只有 replay 能补；
   - 投影游标是 lamport 单值，对「迟到事件」（ingest 了 (lamport,actor) 全序早于游标的事件）不安全；
   - replay 是既有的幂等自检路径，复用零新逻辑；个人场景量级（万级事件）下一次全量重放耗时可忽略。
   - 代价（已评估接受）：回合开销 O(账本全量)。遗留优化见「未来生长点」。
2. **profileVersion 收敛被 ③④ 覆盖**：§8.5 ② 的「低者全量拉 Profile」是为部分副本准备的快照优化；v1 全量节点只要事件交换完整，config.change 事件流带着版本链走，replay 后版本自然一致。专门的 Profile 快照拉取留到 §8.6 场景出现时再做。
3. **配置并发的 v1 语义**：两个节点基于同一 baseVersion 各自 confirm → 产生两条同版本号事件。账本照单全收（都是事实）；投影按全序应用，后到者不满足「严格 +1」被静默跳过——输掉的变更留在事件历史可追溯。与 §8.3「字段并发 LWW，输的编辑留在历史」同精神。
4. **传输层 v1 裁剪**（对照 §8.8 全景）：

| 蓝图能力 | v1 形态 | 理由 |
|---|---|---|
| mDNS 自动发现 | 手动 peer 地址（env `ONE_SYNC_PEERS` 或请求体传入） | 发现是体验优化，协议正确性先行；个人 2-3 节点手填地址成本可忽略 |
| WebSocket 双向推送 | HTTP 拉模型 + 手动/定时触发 | 拉模型天然幂等可重入；轮询间隔对个人场景足够 |
| 端到端加密 | 局域网明文 HTTP | 加密边界在工作区密钥——**M7 已引入**（seal/unseal + 中继密文通道，见「云中继与迁移导出」章节）；节点直连仍定位局域网可信网段，跨互联网走中继 |
| checksum 摘要兜底 | 已实现：per-actor 通道指纹（eventId 集合 sha256），随握手交换 | 正确性必需而非量级优化——水位持平时的内容分歧检测（见决策 5） |
5. **actor 通道节点唯一**：oplog 的 `(workspace_id, actor, seq)` 唯一约束要求每条 actor 通道**单写者**——两个节点若以同一 actor 名落账，会在相同 seq 上撞唯一约束，且「水位持平」会让漏拉静默发生。因此所有落账 actor 统一带节点后缀：`user:local@{nodeId}`（UI 写路径）、`ai:{model}@{nodeId}`（AI 工具）、`module:core@{nodeId}` / `module:core.wms@{nodeId}`（种子装载）；`registry.provide` 为此提供 `opts.actor` 覆盖口。通道指纹（决策 4 的 checksum 行）是同一致命场景的第二道防线：即使 actor 撞名，指纹分歧也会触发全量重拉、幂等摄入去重。防线测试固化：双实例同 actor 落账 → ingest 撞 UNIQUE 约束报错。

### 组件协作（谁调谁）

```
server/sync/sync-client.ts（runSyncRound，传输编排）
  → core.sync（OneCore.sync: SyncService）—— handshake / eventsFor / applyRemote
  → ws.replayAll()（WmsWorkspace）—— 内核投影(facade.replay) + 领域投影(wms replay)
server/routes/sync.ts（HTTP 契约：hello / events / run 三端点）
```

- `core.sync`（节点间账本交换）与 `ws.sync()`（投影追账）是两个动作，命名相近但层次分明：前者跨节点、后者本地缓存刷新。
- SyncService 不做网络 IO、不碰投影——传输与重建都在宿主层，内核保持「领域无关 + 传输无关」。

## 模块系统（里程碑 6）

> DESIGN §6/§7 的 v1 落地：**manifest 是声明性数据，驱动既有服务完成受管的安装/卸载**。「AI 被工具边界管住、模块被 capabilities 管住」（§6.3）——v1 的「管住」= 能力词表校验 + 安装审计事件；运行时代码沙箱（动态 import 外部插件包 / WASM Extism）是 v2 生长点。

### v1 形态与裁剪（对照 DESIGN §6.1 全景）

| manifest 分区 | v1 形态 | 理由 |
|---|---|---|
| id / name / version / description / minCoreVersion / capabilities / slot / dependencies | 完整实现（安装期硬校验的输入） | description 必填——AI 组装匹配的一等公民（§6.3） |
| signature | 类型占位（恒 null） | DESIGN §10：v1 本地模块无签名 |
| fields（provides / requires） | 完整实现 → 驱动 FieldRegistry | §7.1 字段共享/冲突的既有执行点（M1） |
| tools | 完整实现 → 安装期与总线事实比对 | handler 注册仍在代码装载期（WmsDomain.attach）；manifest 声明面从工具定义派生，零重复维护 |
| events（subscribes / publishes） | 类型声明，不做前缀强校验 | 订阅/发布是运行时纪律，v1 无事件路由消费方 |
| workflows.contributes | 完整实现 → patch 合并 | §6.3 贡献机制（模块永不替换流程，只做贡献） |
| workflows.base（本实现新增） | 基础流程种子（目标流程不存在才生效） | 「内核基础」由领域包提供（core 领域无关，§13.5）；core.wms 的特权，逐流程守卫保证不覆盖既有配置 |
| rules | 类型占位（v1 恒空数组） | veto/warn 规则注入无校验点消费方 |
| settings.schema | 完整实现（默认值提取进 modules 段） | 校验、表单渲染、AI 上下文三用一份 schema（§5.4） |
| ui / jobs / entry | 不实现 | 前端组件注册 / 定时任务 / 外部代码加载均无 v1 消费方 |

### 安装管线（预检 → 落事件，顺序固定）

**预检全过才落第一条事件**（「先证明后动手」）：落事件阶段理论不可失败，原子性边界与 confirm 同水平（进程崩溃窗口由「重装幂等收敛」兜底）。

```
install(manifest, { actor })
  预检（零事件）：
   1. validateManifest（结构）+ minCoreVersion ≤ CORE_VERSION
   2. 已装同 id：同版本 → 幂等返回 { installed:false }（零事件）；异版本 → 拒绝（v1 无原地升级，先卸载）
   3. 依赖模块在场且 enabled；slot 无其他占位者（进程 manifest 目录扫描）
   4. 字段：provides 类型冲突预检；requires 存在性 + 类型（复用注册表读 API）
   5. 工具：manifest.tools ⊆ 总线（id + permission 一致）
   6. 贡献：目标流程必须已存在（模块不创建流程）；贡献状态 id 不与现有冲突（§6.3）
  落事件（顺序固定，确定性铁律）：
   7. 轨道 A：fields.provides → registry.provide（已存在且类型兼容 → DO NOTHING + usedBy 追加，§7.1 后装共享语义）
   8. 轨道 B：ProfileService.applyDirect(patch)——
      modules/{id}（enabled/version/settings 默认值）
      + workflows.base（逐流程守卫：不存在才装）
      + contributes（states 带 providedBy 尾加、transitions 尾加）
   9. module.installed 审计事件（id/name/version/capabilities 摘要）
```

- **循环依赖在单装模型下结构性消除**（§7.2 循环型）：install 一次一个模块、依赖必须先在场——A↔B 互赖时第二个永远装不进，无需显式拓扑排序。
- **幂等短路在第 2 步**：已装同版本直接返回——文件库反复构造（WmsWorkspace 每次构造都调 install）零新事件。

### 卸载 = 逆操作（§6.2 表格的执行）

字段处置委托 `registry.unregisterModule`（M1 既有的移交/软删除语义）；workflows 摘除 = 移除 `providedBy={id}` 的 states + 两端引用这些 states 的 transitions（**规则从数据推导**——远端节点无 manifest 也能重放），以 replace 整个流程定义的形式走 patch；modules/{id} remove。摘除 patch 同样过 applyDirect 校验（连通性兜底：摘除只减不增、基础图不动，正常不触发）。最后落 module.uninstalled 审计事件。

### 真相源分治（模块部分）

| 数据 | 真相源 | 说明 |
|---|---|---|
| modules 段（enabled/version/settings）+ workflows 贡献/base | `config.change`（既有） | ModuleRegistry 经 `ProfileService.applyDirect` 落账——config 写路径唯一 |
| 字段元数据 | `registry.*`（既有） | install/uninstall 的轨道 A |
| `module.installed` / `module.uninstalled` | 生命周期审计事件 | 节点行为历史的记录（同步 / 迁移 / AI 上下文消费），**不是配置投影的真相源**——ProfileService.sync 不认它，重放投影时忽略 |
| manifest 元数据（description / settings schema / tools 声明） | 进程内存目录（代码装载方 registerManifest） | 「代码在场」的声明面；远端节点装同一模块 = 各自装载代码 + 各自 registerManifest（DESIGN §6.4 迁移闭环） |

### ProfileService.applyDirect（新受管入口）

propose/confirm 是人类慢通道、seedDefaults 是领域种子——applyDirect 是**宿主/模块系统的直接落账口**：校验管线（双保险）→ 落 config.change（version+1）→ 投影。不登记提议、不走确认（调用方受信：模块系统、未来 CLI 管理端）。**不注册为 AI 工具**（§4.1：AI 改配置仍只有 profile.propose 慢通道）。

### wms 种子迁移（M4 手写种子 → manifest 驱动）

- **WmsDomain.attach**：工具注册到总线后，从工具定义**派生** manifest.tools（id/label/description/parameters/permission，零重复维护）→ `registerManifest` 进进程目录。
- **WmsWorkspace 构造期**：`modules.install(WMS_MANIFEST, { actor: module:core.wms@{nodeId} })` 替代 `#seedDefaultProfile()`。
- **老库一次性收敛**：字段已存在（owner='core'）→ provide 落 DO NOTHING + usedBy 追加，owner 不动（'core' 的字段不随 core.wms 卸载——归属语义自洽）；流程已存在 → base 守卫跳过；modules 段登记后，后续重开文件库全部在幂等短路处返回。
- seedDefaults 保留（ProfileService 公共 API，其他领域包仍可用）。
- **tools 校验顺序依赖**：attach 先注册工具（进程级）、workspace 构造后 install 才校验声明 ↔ 事实一致。

### 冲突治理落点对照（§7.2 四形态）

| 形态 | v1 落点 | 状态 |
|---|---|---|
| 类型冲突（字段层） | FieldRegistry.provide/require 命令侧校验 | M1 既有 |
| 循环依赖 | 单装模型结构性消除（依赖必须先在场） | 结构性 |
| 择一型（slot） | install 预检 3：进程目录扫描同槽占位者 | M6 新增 |
| 同 id 状态冲突 | install 预检 6 | M6 新增 |
| 对抗型（rules veto/warn） | 不实现（无校验点消费方） | v2 |

## 云中继与迁移导出（里程碑 7）

> DESIGN §8.5 传输安全 / §8.8 中继 / §6.4 迁移闭环的 v1 落地。三件事一个主题：**让事件流离开本机**——迁移是「一次性的全量带走」，中继是「持续性的异地汇聚」，两者共用同一批原语（全量事件 + 幂等摄入 + 工作区密钥）。

### 工作区密钥（加密边界——M5 决策 4 预定「M7 迁移导出时引入」的兑现）

- **密钥形态**：每工作区一把 256-bit 对称密钥（hex 存储，`workspace_keys` 表，SCHEMA_VERSION 3）。生成/导入是管理动作，**不经事件**——密钥不是业务事实，是边界参数（与 nodeId 同类，落 meta 型存储）。
- **密封协议（seal/unseal，纯函数）**：`sealEnvelope(env, keyHex)` → `SealedEvent`：信封字段明文（workspaceId/actor/seq/lamport/eventId/type/createdAt——路由、水位、幂等去重所需）+ payload 以 AES-256-GCM 加密（`{ cipher, nonce }`，随机 nonce）。`unsealEnvelope(sealed, keyHex)` → 还原 `EventEnvelope`；密钥不符或密文被篡改 → CryptoError。
- **加密范围 = payload**（DESIGN §8.5 字面：「信封明文供路由，中继只见密文」）。type 留明文——它是信封的一员，中继分页存取不解释它。
- **KeyService**（进程级，方法带 workspaceId）：`generate`（已有 → KeyExistsError）/ `get` / `importKey`（已有 → KeyExistsError——**换密钥会使存量密文不可解，v1 禁止**；确需换钥 = 开新工作区）。指纹 = 密钥 sha256 前 8 位 hex，供两台设备上人工比对。
- **密钥交换是人工动作**（§8.5「人工确认交换」）：`GET /api/keys/export` 取明文密钥 → 用户经任意渠道（口述/扫码/加密消息）交给新节点 → `POST /api/keys/import`。**中继全程不经手密钥**——这正是「E2E 加密下中继无需被信任」的实现方式。

### 迁移导出（migration）

**v1 形态：全量事件包 + 重放**（§1.1「配置包 + 事件重放」、§8.5「迁移和同步是同一个动作的两种节奏」）。

- `MigrationBundle` = `{ kind, bundleVersion, nodeId, workspaceId, profileVersion, eventCount, createdAt, events }`——events 为账本全量、按 (lamport, actor) 全序。**Profile 不单独打包**：快照是事件投影，重放自动恢复；快照引导（§8.6）是部分副本的优化，v1 全量节点不需要（同 M5 决策 2 的裁剪）。
- `exportBundle(workspaceId)`：全量事件 + 元信息；`importBundle(workspaceId, bundle)`：结构校验（kind/bundleVersion/信封合法性）→ **workspaceId 一致性**（迁移 = 同工作区搬家；跨工作区 = 跨密钥边界，v1 拒绝并提示）→ 幂等 ingest（重复导入零事件，eventId 查重）。
- **迁移包明文**（与 DESIGN §8.5 的工程偏差，已评估接受）：蓝图的加密语境是同步传输通道（不可信基础设施）；迁移包是用户本地文件（可信域——U 盘/网盘人工搬运），v1 不加密、不做口令。中继通道的密文安全不依赖迁移包形态。
- **manifest 在场性报告**（宿主层组装）：导入后扫描 `module.installed` 事件引用的模块 id，对照本进程 manifest 目录（`listManifests`）；缺失 → 响应报告清单，**不阻塞**——账本是事实全收；缺代码的模块在 manifest 注册前只是「已安装记录」，不提供运行时行为。v1 无插件仓库/无签名（§10 冻结），「按 id+version 拉代码包」留待插件市场（未来生长点）。

### 云中继（relay）

**v1 形态：HTTP 加密邮箱（在线目录 + 密文暂存 + 水位自愈）。** 与 DESIGN §8.8「WebSocket 实时转发」的偏差及理由：

| 蓝图 | v1 形态 | 理由 |
|---|---|---|
| WebSocket 长连接实时转发 | HTTP 拉模型 + push 端点（异步暂存） | 延续 M5 裁剪（拉模型幂等可重入、协议已验证）；异步暂存让 NAT 后节点**不必同时在线**也能交换 |
| 中继「只转发不存」 | **内存暂存**密文（重启即清） | 拉模型下异步交换必然暂存；内存态 = 中继连密文都不持久化，重启后节点按水位差额自动重推（自愈）——比「转发」更贴合「中继无需被信任」的精神 |
| 一套 WebSocket 消息目录 | 端点与节点 sync 同构（hello/events）+ push | 复用 computePullPlan / applyRemote / 通道指纹，零新协议概念；WebSocket 化是传输层替换，留待生长点 |

- **中继存储**（`RelayStore`，进程内存）：`workspaceId → (actor → SealedEvent[]（按 seq 有序）)` + 每 workspace 的最新 profileVersion（push 时节点上报，hello 透传——配置版本号不是业务数据）+ 在线目录（nodeId → lastSeen，push 顺带刷新，无独立心跳端点）。**存储中永远没有明文 payload。**
- **中继端点**（`createRelayApp()`，独立 Hono 应用，不依赖 OneCore 实例/不开数据库——VPS 零状态部署）：
  - `GET /relay/hello?workspaceId=` → SyncHandshake 同形：nodeId = relay 身份（`relay-` 前缀，不与节点撞名）；watermarks 从暂存密文派生（信封元数据明文，通道指纹照算——eventId 明文）；profileVersion = 最近 push 上报值（无则 0）；
  - `GET /relay/events/:actor?workspaceId=&fromSeq=&limit=` → 密文事件页（分页契约与节点端点同形）；
  - `POST /relay/push` body `{ workspaceId, nodeId, profileVersion, sealedEvents }` → `{ accepted, skipped, conflicted }`——幂等：同 (actor,seq) 同 eventId → skipped；异 eventId → **conflicted 拒收该条**（actor 通道节点唯一防线在中继侧的延伸）；同时刷新目录 lastSeen；
  - `GET /relay/directory?workspaceId=` → 在线节点清单（管理展示用）。
- **节点侧回合**（`runRelayRound`，server 层）：
  1. `GET /relay/hello`（校验 workspaceId 一致）；
  2. **push**：计划 = `computePullPlan(中继水位, 本地水位)`——中继缺什么我推什么（方向与 pull 相反的同一纯函数）；逐区间分页读本地 `eventsFor` → `sealEnvelope` → `POST /relay/push`；
  3. **pull**：计划 = `computePullPlan(本地水位, 中继水位)`——与节点间同步完全相同；逐区间拉密文页 → `unsealEnvelope` → `applyRemote`；
  4. accepted > 0 → `replayAll()`（与 M5 同一条全量重建路径）。
  - **节点把账本全部事件推给中继（含从第三方拉来的）**——中继是汇聚点，新节点只从中继即可完成全量引导（迁移闭环的在线版）。自己 push 的部分本地水位已领先，pull 计划天然不含（无回环浪费）。
  - **无密钥不回合**：路由层预检 `core.keys.get`，缺失 → 400 `RELAY_NO_KEY`（先经 /api/keys 生成或导入）。
- **部署**：`npm run start:relay`（packages/server 独立入口，env `ONE_RELAY_PORT` 默认 3900）。中继与节点同包不同进程：复用 @one/core 的类型与纯函数（SyncHandshake/computePullPlan/SealedEvent），但不装配 OneCore——「不碰业务数据」由依赖面保证。

### 端点契约（server，M7 新增）

- 密钥：`POST /api/keys`（生成；已存在 → 409 `KEY_EXISTS`）、`GET /api/keys`（`{ exists, fingerprint, createdAt }`，不回密钥本体）、`GET /api/keys/export`（`{ key }` 明文本体——本地可信域，人工交给新节点）、`POST /api/keys/import` body `{ key }`（64 位 hex 校验；已有 → 409）。
- 迁移：`GET /api/migration/export` → MigrationBundle；`POST /api/migration/import` body `{ bundle }` → `{ accepted, skipped, replayed, missingManifests }`。
- 中继：`POST /api/relay/run` body `{ relay?: url }`（缺省 env `ONE_RELAY_URL`，两者皆空 → 400）→ 一轮 push+pull 结果；`ONE_RELAY_URL` 非空时 start() 按 `ONE_RELAY_INTERVAL_MS`（默认 60s）定时执行。
- 错误映射新增：`KEY_EXISTS` → 409；`CRYPTO_ERROR`（解密失败：密钥不一致或密文被篡改）→ 400；`MIGRATION_ERROR` → 400。

### 组件协作（谁调谁）

```
server/routes/keys.ts        → core.keys（KeyService：generate/get/importKey）
server/routes/migration.ts   → core.migration（exportBundle/importBundle）
                               + core.exposeModuleRegistry().listManifests（在场性报告）
                               + ws.replayAll()
server/relay/relay-app.ts    createRelayApp()——独立进程（VPS）；RelayStore 内存暂存，
                               复用 core 纯函数（computePullPlan/类型），不装配 OneCore
server/relay/relay-client.ts runRelayRound：hello → push(计划/分页/seal)
                               → pull(计划/分页/unseal) → applyRemote → replayAll
                               → core.sync.eventsFor（分页读本地）、core.sync.applyRemote（摄入）
                               → core.keys（工作区密钥）
```

## 测试策略

- **服务层测试**（oplog.test.ts / fields.test.ts / tools.test.ts / profile.test.ts + patch/validate/impact 纯函数测试）：经 facade 走公共 API，验证内核行为契约；纯函数（patch/校验/报告）直接单测。
- **模块系统测试**（modules.test.ts）：manifest 校验纯函数直测（合法全景 + 逐项非法）；install 全流程（字段/modules 段/settings 默认值/审计事件/贡献合并）；幂等（同版本重装零事件）；依赖缺失/slot 冲突/状态冲突/贡献目标不存在/requires 缺失/异版本/工具不在场逐项拒绝；uninstall 逆操作（字段移交与隐藏、workflows 摘除、modules 移除）；replay 重建一致；**老库收敛**（先手写种子再 install——字段 DO NOTHING + base 守卫 + modules 登记，行为与 M4 库升级一致）。
- **同步测试**（sync.test.ts）：computePullPlan 纯函数直测（含「水位持平 + 指纹不同 → 全量区间」）；双 OneCore 实例互拉收敛（水位/计数/全序序列一致、幂等重拉零 accepted、分页、profileVersion 随握手可见、ingest 后 replay 投影一致）；actor 节点唯一防线（双实例同 actor 落账 → UNIQUE 约束拒绝摄入）。
- **加密与密钥测试**（crypto.test.ts）：seal→unseal 往返（含中文/嵌套 payload）；错钥解密 → CryptoError；密文篡改 → CryptoError；nonce 随机性（同事件两次密封密文不同）；keyFingerprint 稳定；KeyService 生成/导入/已存在拒绝/格式校验/跨库持久（重开库仍在）。
- **迁移测试**（migration.test.ts）：exportBundle 元信息（nodeId/profileVersion/eventCount/全序）；importBundle 全量恢复（重放后注册表 + profile_state 投影与源一致）；幂等（重复导入 accepted=0）；workspaceId 不一致拒绝；坏 bundle（kind/bundleVersion/非数组 events）拒绝；空账本导出导入（元信息照常、零事件）。
- **集成测试**（workspace.test.ts）：多工作区并存、replay 重建（含 profile_state）、端到端链路。
- **稳定性守则**：公共 API 变更 = index.ts 导出变更 = 必须同步更新 DESIGN.md 对应章节。

## 未来生长点（与 DESIGN.md 对齐）

| 生长点 | 落点 | 备注 |
|---|---|---|
| 同步投影增量追账（M5 遗留优化） | sync/ + 各投影持有方 | 复合游标 (lamport,actor) + registry.* 增量投影路径，替代回合后全量重放；量级变大时再做 |
| 同步传输增强 | server/sync/ + server/relay/ | mDNS 发现、WebSocket 推送（§8.8 消息目录，含中继实时转发替代暂存）；端到端加密已随 M7 落地（中继密文通道），节点直连仍明文（局域网可信段） |
| 插件仓库拉包（迁移闭环完整版） | modules/ + 插件仓库 | §6.4：新节点按 modules id+version 拉代码包并验签；v1 由 manifest 在场性报告替代（缺代码不阻塞、只报告） |
| 流程 `when` 条件求值 | wms state/order-state-machine.ts | 转移级条件（如「库存不足禁发货」）成为 DSL 一等公民；M8 已落地无条件的 states/transitions 权威化（见 @one/wms「流程引擎行为闭环」），`when` 是其上的一等扩展 |
| 库存真预占 | wms state/inventory-effect.ts + views | picking 时落预占事件（reserved 字段 / 预占-释放事件对），消除「拣货后被挪用靠 shipped 硬守卫兜底」的窗口（M9 已落地 fail-fast 预检 + 硬守卫） |
| 联动效应点配置化 | wms state/inventory-effect.ts → 模块 settings | 效应状态（received/shipped）从约定迁移到 core.wms settings 声明，自定义流程可指定自己的效应点（M9 为约定词表；settings 读写管道已随 M13 落地——readSettings 同模式扩键即可） |
| 库位层级（仓库→库区→库位） | wms db/migrations.ts + views/location-view.ts | M10 为扁平模型（code 即身份）；层级化 = location 表加 parent 维度 + 编码规约（如 A-01-002） |
| 智能分配上架策略 | wms tools/wms-tools.ts | 入库行不指定 locationCode 时按策略选桶（就近 / 均衡 / ABC 分类）；v1 一律落 DEFAULT 桶由人工移库接管 |
| 库位改名 / 停用 | wms events/catalog.ts + views/location-view.ts | v1 库位不可变（只有 create）；改名 / 停用需 location.updated 事件 + 投影状态列（停用库位拒收新入账） |
| 前端库位维度展示 | app + server/routes/wms.ts | /api/inventory 现按 SKU 跨库位跨批次求和（M10/M11 前端零改动）；分桶明细界面与移库操作面板待 UI 需求出现 |
| 批次分配策略进阶 | wms tools/wms-tools.ts | M13 已落地全局缺省策略 settings.defaultAllocation（strict/fifo/fefo）+ 单参数覆盖 + 老库/脏值兜底；生长点：按 SKU / SKU 分类级策略覆盖、效期阈值柔性策略（临期 N 天内优先 FEFO） |
| 跨库位批次分配 | wms tools/wms-tools.ts | v1 分配只在行库位内；跨库位智能分拣（含上架策略）需要库位优先级/容量模型，待真实场景出现 |
| 批次主数据实体 | wms events/catalog.ts + views | 批次号附加属性（供应商/生产日期/质检状态）；v1 批次只是库存维度（入库声明的自由文本），无实体表、无生命周期事件 |
| 过期拦截进阶 | wms tools/wms-tools.ts | M13 已落地 blockExpiredOutbound 开关（单据出库预检/扣减同拦、分配跳过过期桶、adjust/move 不拦）；生长点：拦截白名单（特定 SKU / 单据类型豁免）、临期天数阈值（到期前 N 天即拒）、过期自动冻结/隔离库位 |
| 前端批次维度展示 | app + server/routes/wms.ts | 临期看板已随 M14 落地（GET /api/inventory/expiry + ExpiryPage 五层预警）；生长点：批次明细下钻（query 树形已备，从看板行点入） |
| 效期看板进阶 | server/routes/wms.ts + app | M14 分层阈值（critical ≤7 / warning ≤30 天）是 server 展示常量、前端纯展示；生长点：阈值进 core.wms settings（readSettings 同模式扩键，M13 管道复用）、按层导出 CSV、AI 查询 expiring 后跳转看板预填层过滤 |
| AI 模块目录上下文（§6.4 闭环 ② 完整版） | ai/system-prompt.ts + modules 目录 | 已装模块的 description/settings.schema/tools 注入 System Prompt，支撑「自然语言 ↔ 模块匹配」；第二个模块出现时做 |
| 外部插件包与运行时沙箱 | modules/ + manifest 的 entry | 动态 import / WASM（Extism）、signature 校验链、capabilities 运行时供给；v1 模块全部是编译期静态装载 |
| 模块运行时管理端点 | server/routes | GET /api/modules、install/uninstall 端点（当前唯一模块 core.wms 由领域包装配期自动安装，无运行时装卸消费方） |
| 权限中间件 | ToolsView.invoke 的 handler 前插一层 | ctx.actor 已备（§10 预留） |
| 预演关增强 | profile/impact.ts | 字段隐藏时统计受影响业务行数（需领域消费方提供计数回调） |
| AI 工具集分级（AgentScope） | ai/agent.ts 的 createWmsAgent 加 scope 参数 | 详见下文 |

### AI 工具集分级（AgentScope，v2 接缝——多入口多信任等级需求出现时实现）

**设计立场**：权限的正确位置在工具层，不在模型层——不拆「查询 AI / 配置 AI」两个对话入口（体验割裂），而是**一个 agent 工厂 + 按入口裁剪工具集**。现有慢通道已使「动配置」成为最弱权限档（profile.propose 只能写提案，confirm 永不注册为工具），真正的演进点是按入口差异化：

```ts
type AgentScope = 'readonly' | 'standard' | 'proposable';
// readonly:   仅 permission='read' 的工具（wms.inventory.query 等）
// standard:   + 业务写六件套（现状，快通道：handler 校验 + 全审计）
// proposable: + profile.propose（慢通道入口）
```

- **actor 携带等级**：`ai:{model}:{scope}`（如 `ai:glm-4:standard`），审计事件一眼可辨操作来自什么权限的入口。
- **消费方（触发条件）**：车间平板只留查询、本地小模型不给提议权、多成员不同权限、不同 API key 等多入口场景。单入口下无消费方，不预实现。
- **实现位置**：`ai/agent.ts` 工厂参数 + server 侧按入口选 scope（env 或入口配置）。工具的 `permission` 元数据是裁剪依据（read/write 分级已存在）。

---

# @one/wms 领域包架构（里程碑 2）

> 领域包只准 import `@one/core` 的 index.ts（公共 API + 领域装配口）。

## 分层地图

```
┌─ 出口层 ─────────────────────────────────────────────┐
│  index.ts              公共 API 唯一出口              │
├─ 组合层 ─────────────────────────────────────────────┤
│  wms.ts               WmsDomain（装配 + manifest 派生）│
│                       / WmsWorkspace（门面：追账/重放）│
├─ 服务层 ─────────────────────────────────────────────┤
│  views/sku-view.ts         SKU 投影 + 查询            │
│  views/location-view.ts    库位投影 + 查询（M10）     │
│  views/order-view.ts       单据投影（含冲突检测）+ 查询 │
│  views/inventory-view.ts   库存流水 + 汇总投影 + 查询  │
│  tools/wms-tools.ts        十个 wms.* 工具（护栏在此） │
├─ 基础层 ─────────────────────────────────────────────┤
│  events/catalog.ts         事件目录（类型 + 常量）     │
│  state/order-state-machine.ts  纯函数校验 + 种子誊写源  │
│  state/inventory-effect.ts 单据→库存联动纯策略（M9）   │
│  db/migrations.ts          领域表（wms_ 前缀，uuid）   │
│  errors.ts                 领域错误族（继承 CoreError）│
└──────────────────────────────────────────────────────┘
```

## 关键机制

- **追账模型（投影是缓存）**：`WmsWorkspace` 持内存游标（已应用 lamport 高水位）。`sync()` 增量应用游标之后的 wms.* 事件；`replay()` 清空投影全量重建——两者走同一条 `applyEvent` 路径（迁移/修复/自检 = 同一动作）。构造期即全量追账一次，新进程打开旧库直接可读。
- **write 工具三步护栏**（缺一不可）：`ws.sync()`（校验前投影新鲜）→ 业务校验（编码唯一/SKU 存在/状态机合法/库存不为负）→ `ctx.appendEvent` + `ws.sync()`（返回新状态）。校验失败绝不落事件。
- **只有流水事件**（§8.2）：`wms_inventory` 汇总表（维度 (workspace, SKU, 库位, 批次)——M11）的唯一写路径是 `InventoryView.applyEvent`；库存永远是「期初 + Σ流水」的派生视图。
- **并发冲突**（§8.3 唯一真冲突）：state_changed 的 from 与投影当前态不符 → v1 抛 `OrderStateConflictError` 停下；冲突队列 + 人工裁决是里程碑 5 的实现项。
- **依赖登记**：基础层内许可的依赖有两条（均单向）：`events/catalog.ts → state/order-state-machine.ts`（纯类型——领域词汇表同源）、`db/migrations.ts → events/catalog.ts`（DEFAULT_LOCATION_ID 插值单一来源，M10）。
- **replayAll（M5）**：全量重建「内核投影（facade.replay：注册表 + profile_state）+ 领域投影（wms 六表）」——同步回合与「修复同步」按钮的统一落点（§8.5 全量为真）。
- **manifest 驱动装配（M6）**：core.wms 是第一个模块——attach 期从工具定义派生 manifest.tools（声明面与事实面零重复）并 registerManifest；工作区构造期 `modules.install()` 完成受管种子（详见 @one/core「模块系统」章节的 wms 迁移小节）。
- **单据 → 库存联动（M9）**：见下节。
- **库位管理（M10）**：见下文专节。
- **批次/效期管理（M11）**：见下文专节。
- **批次分配策略（M12）**：见下文专节。
- **分配策略与过期拦截配置化（M13）**：见下文专节。

## 流程引擎行为闭环（里程碑 8）

> DESIGN §12 范围声明「先验证动态字段和流程引擎的内核设计」的收口：动态字段闭环在 M4/M6 已验证（动态列 + 动态表单 + manifest provides），流程引擎在 M6 前只完成了配置面（workflows 进 Profile + 前端候选按钮）——行为面仍是 M2 硬编码转移表。M8 把**转移校验的数据源换成 Profile workflows**，配置面即行为面。

- **改动前后**：`wms.order.transition` 的 handler 此前查 `ORDER_TRANSITIONS`（编译期常量，配置改了不跟）；现在从 `profile.getSnapshot().workflows` 取该方向的 `WorkflowDef`（映射 in→inbound、out→outbound，与前端 OrdersPage 同一约定）传给纯函数校验。AI 慢通道改 workflows、模块 contributes 叠加转移，**下一次流转立即生效**——「改配置 → 行为变」的端到端闭环（§5.3 流程 = 表驱动数据的完整语义）。
- **合成即生效**：M6 的合成结果（manifest.workflows.base 整段 + contributes 叠加 states/transitions，含 providedBy 标记）本来就落在 Profile workflows 里——闭环不需要新合成逻辑，只是让校验读它。
- **ORDER_TRANSITIONS 降级为种子誊写源**：只被 `defaultWorkflows()` 消费（core.wms manifest 的 workflows.base 数据源）；一致性由 profile-seed.test.ts 持续验证。不再有任何行为消费方。
- **流程缺失 = 明确报错，不静默回退**：方向的 workflow 不在快照里（如配置被整段删除）→ 抛 `WMS_WORKFLOW_NOT_FOUND`（工具层 400）。回退硬编码表会让「删流程」的配置静默失效，违背「配置是唯一权威」。
- **重放安全性（既有性质不变）**：守卫只在工具 handler 写路径；`OrderView.applyEvent` 对 `order.transitioned` 事件不做合法性校验（账本是事实全收）——校验数据源换成 Profile 投影后，重放路径依旧零依赖配置状态，投影与账本不会因配置演变脱节。
- **纯函数参数化**：`canTransition/transitionsFrom/assertTransition` 从查全局表改为接受 transitions 数组参数——校验逻辑无状态、无 IO 性质保持（order-state-machine.ts 仍不落库不读库）。

## 单据 → 库存联动（里程碑 9）

> M2 时代单据与库存脱节（transition 只做状态机校验，收发货需手动 `inventory.adjust` 关联单号）。M9 打通闭环：**单据驱动库存变动**，零 schema 变更、零投影变更、零新事件类型——纯命令侧改造。

- **效应语义（默认约定）**：入库进入 `received` → 按明细逐行落 `+delta` 流水（收货即上架）；出库进入 `picking` → 余量预检（不足拒绝，fail-fast）；出库进入 `shipped` → 按明细逐行落 `-delta` 流水（余量硬守卫）；其余状态（done / canceled / 自定义状态）无效应。默认转移表不含 `received→canceled` / `shipped→canceled`——效应发生后不可取消，无需回冲路径。
- **事件形态**：复用既有 `wms.inventory.adjusted`（每行一条，reason=`order:received` / `order:shipped`，orderId/orderNo 关联）+ `wms.order.state_changed`——1+N 事件。库存纪律不变：库存仍只经流水事件变更，投影零改动（幂等键 event_id 天然区分行级事件）。
- **原子落账（runAtomic）**：`OplogStore.append` 是逐事件独立事务，多事件裸落存在「状态变了库存没动」的崩溃窗口。`WmsWorkspace.runAtomic(fn)` 用 better-sqlite3 嵌套事务（savepoint）把 handler 发射段包成同生共死——任一 append 失败整体回滚。校验在包裹外完成（拒绝路径不进事务）。
- **效应策略位置**：`state/inventory-effect.ts` 纯函数（`stockEffectOf` / `requiresAvailabilityCheck`），只被命令侧消费——投影层不埋业务策略。效应状态词表 v1 用约定（received/shipped），自定义流程改名状态则联动不生效（文档级语义）；效应点配置化是生长点。
- **v1 无真实预占**：picking 与 shipped 之间库存仍可被其他单据/手动调整挪用，由 shipped 硬守卫兜底拒绝（测试覆盖该窗口）；真预占（reserved 字段 + 预占/释放事件）是生长点。
- **顺手修复（既有 bug）**：`wms_order_line` 有 (order_id, sku_id) 唯一约束（行 id 由二者派生保证重放幂等），但 orderCreate 命令侧此前未挡重复 SKU 行——重复行会「事件落账 → 投影 INSERT 炸裂 → 工作区永久卡死」。现命令侧拒绝同单同 SKU 重复行（同单同 SKU 请合并数量），联动守卫因此可按行逐一校验。

## 库位管理（里程碑 10）

> M9 的库存维度是 (workspace, SKU)——所有数量挤在一个隐式大桶里。M10 把维度升级为 **(workspace, SKU, 库位)**：入库分桶上架、出库按行守卫、移库双流水。代价最小化：库存侧零新事件类型（仍只有 `wms.inventory.adjusted`），仅新增一个领域事件 `wms.location.created`。

- **虚拟 DEFAULT 库位**：保留字 `DEFAULT`（id = code = 'DEFAULT'）不占 `wms_location` 表——老数据（事件无 locationId 字段）投影时自动收敛进 DEFAULT 桶，无需任何数据迁移事件。工具显式传 `locationCode: 'DEFAULT'` 直通；`wms.location.create` 拒绝占用保留字。
- **老库收敛迁移（「投影可丢」性质的兑现）**：`wms_inventory` 主键从两列变三列无法 ALTER——migrations 检测 `wms_inventory_ledger` 缺 `location_id` 列（= M9 及更早的库）→ **五张投影表整组 DROP** → 构造期 sync() 从账本全量重建。必须整组 DROP：applyEvent 幂等早退（event_id 查重）意味着只丢一张表时，兄弟表已消费过的事件不会重放，该表永不重建。
- **行级库位 + 三段行 id**：单据行的库位在 `wms.order.create` 时锁定（行 `locationCode?`，缺省 DEFAULT）；行 id 派生为 `orderId:skuId:locationId`，唯一约束同三段——同单同 SKU **可**分库位多行，同单同 SKU 同库位仍拒绝（请合并数量）。M9 的两段唯一约束语义被自然包含。
- **出库守卫按行库位（他桶有货不救本桶）**：picking 预检与 shipped 硬守卫均按 `(SKU, 行库位)` 的桶余量校验——分桶是库存事实，跨桶挪用必须显式移库。`InsufficientStockError` 的 skuCode 参数带 `@locationCode` 后缀，明示哪个桶不足。
- **移库 = 两条流水**：`wms.inventory.move` = 源桶 `-delta` + 目标桶 `+delta` 两条 `wms.inventory.adjusted`（reason=`transfer`），runAtomic 原子包裹，源桶余量守卫在事务外先验。移库是纯命令侧组合——零新事件类型、零投影改动。
- **query 分组形态**：`wms.inventory.query` 给 skuCode → 单组 `{ total, byLocation: [...] }`（跨桶明细）；给 locationCode → 该桶平铺行；都不给 → SKU 组数组。System Prompt 快照（ai 包）与 `GET /api/inventory`（server 包）按 SKU 跨桶求和、响应形态不变——前端零改动。
- **混合版本同步兼容**：M9 节点收到 `wms.location.created`（不在其事件目录）→ `isWmsEventType` 过滤后忽略；adjusted 事件多出的 locationId 字段被旧投影自然丢弃——新旧节点互同步 graceful degrade（旧节点看不到库位维度，但账本不炸、不挡同步）。

## 批次/效期管理（里程碑 11）

> M10 的库存维度是 (workspace, SKU, 库位)。M11 把维度升级为 **(workspace, SKU, 库位, 批次)**：入库声明批次与效期、出库按行批次守卫、移库带批次、临期查询。延续 M10 的最小代价路线：**零新事件类型**（仍只有 `wms.inventory.adjusted`，payload 加可选 batchNo/batchExpiryDate 字段）、零批次实体表、零批次 create 工具——批次是库存维度，不是主数据。

- **批次 = 库存维度，不是实体（D1）**：无 wms_batch 表、无批次事件、无批次创建工具。批次号是入库时声明的自由文本，身份 = (workspace, SKU, batchNo)——同号批次跨 SKU 是互不相干的桶。批次主数据（供应商、生产日期等）是生长点。
- **虚拟 DEFAULT 批次（D2/D3）**：保留字 `'DEFAULT'`（与 DEFAULT_LOCATION_ID 同词面同语义「未指定」），不携带效期（DEFAULT+效期拒绝）。不指定批次的入库落 DEFAULT 桶——与 M10 行为**逐字节等价**（不带批次的既有调用零感知、既有测试断言仅机械补 batchNo 字段）。
- **效期一致性（同批次唯一效期）**：同 (workspace, SKU, batchNo) 首个非空效期登记后，后继流水效期必须一致——工具层校验（不一致抛 `BatchExpiryMismatchError`），投影层不埋业务策略（与联动效应同一纪律）；汇总表 upsert 用 `COALESCE` 保首个非空效期（追账收敛同源）。效期只随批次声明：无批次流水不带效期，出库行带效期拒绝。
- **严格桶语义（D4）**：出库不指定批次只扣 DEFAULT 桶（他桶有货不救，与库位同构）；同单同 SKU 同库位**可**分批次多行——行 id 升为四段 `orderId:skuId:locationId:batchNo`，唯一约束同四段（M10 三段语义被自然包含）。FIFO 自动分配是生长点。
- **过期不拦截（D5）**：v1 过期批次照常出库（拦截是业务策略，不进内核）；临期/过期**可见性**交给新查询工具 `wms.inventory.expiring`（只读，days 缺省 30，返回 daysLeft，today 为 UTC 日期）。
- **query 树形下钻（D6）**：`byLocation` 内嵌 `batches: [{batchNo, batchExpiryDate, quantity}]`（按批次号字典序）；按库位平铺行加批次两列。System Prompt 加批次引导行；`GET /api/inventory`（server）按 SKU 跨库位跨批次求和——响应形态不变，前端零改动。
- **老库收敛（六表整组 DROP）**：检测特征改为 `wms_inventory_ledger` 缺 `batch_no` 列 → **六张投影整组 DROP**（wms_location 纳入组）→ 构造期 sync() 从账本全量重建。一道检测同时覆盖 M9→M11 与 M10→M11 两条升级路径（「投影可丢」性质的再次兑现）。
- **混合版本同步兼容**：M11 事件多出的批次字段被 M10 节点自然丢弃；M10 事件无批次字段由 M11 投影兜底 DEFAULT——新旧节点互同步账本不炸（与 M10 同构的 graceful degrade）。
- **错误消息兼容**：`InsufficientStockError` 的桶标识 DEFAULT 批次不加 `@batchNo` 后缀——M10 时代的错误消息逐字节兼容（消费方断言不碎）。

## 批次分配策略（里程碑 12）

> M11 出库是严格桶语义：行不指定批次只扣 DEFAULT 桶，批次化运营后出库必须逐行手填批次。M12 给 `order.create` 加单级可选参数 `allocation: 'fifo' | 'fefo'`——启用后未指定批次的行按策略在**行库位内**自动拆分为具体批次行。延续最小代价路线：**零投影改动、零新事件类型、零迁移**——分配是建单时的命令侧纯计算，事件里落的已是带批次的多行，与 M11 事件形态逐字节同构（旧节点可同步消费）。

- **缺省零变化（D2）**：不传 `allocation` = M11 严格桶语义（不指定批次只扣 DEFAULT），既有行为/测试/前端逐字节零破坏；策略是显式启用的增量能力。
- **策略词表（D1）**：`fifo`（先进先出——桶按首笔流水时间升序，firstSeenAt 从 ledger 取 `MIN(created_at)`）；`fefo`（先到期先出——效期升序，**无期批次排最后**，含 DEFAULT）。同键并列回落 firstSeenAt，再并列 batchNo 字典序——排序完全确定，不依赖时钟精度。
- **分配范围（D4）**：行库位内的全部余量桶（不跨库位）；DEFAULT 批次参与分配（它也是真实的桶，排除会造成默认桶的货永远出不掉）。显式指定 `batchNo` 的行**原样保留**（显式优先，不参与分配）。
- **跨批次凑数（D5）**：按序扣到足额，一个需求行拆成多条批次行；行库位内各批次**合计**不足 → 新错误 `WMS_ALLOCATION_INSUFFICIENT`（`AllocationInsufficientError`——区别于指定桶不足的 `InsufficientStockError`：这是「策略扫遍全库位仍凑不齐」）fail-fast，零事件。
- **拆分行纪律**：不带效期（出库行效期纪律不变——效期随入库声明）；拆分后统一进四段行键查重（分配行与手动行同键 → 拒绝，请合并数量）。
- **边界（D6）**：`inventory.adjust` / `move` 不引入策略（精确操作人工指定）；入库 + `allocation` → 拒（入库批次是声明不是分配）；非法策略值由 schema enum 白名单挡。全局缺省策略 settings 化、跨库位分配是生长点。
- **守卫链零改动**：分配在 create 时固化为行批次，picking/shipped 按行四段守卫（既有机制自然生效）；「分配后到发货间库存被挪走」由 shipped 硬守卫兜底（M9 既有窗口，行为一致）。

## 分配策略与过期拦截配置化（里程碑 13）

> M12 的分配策略是单级参数（每张单显式传 allocation），过期批次 v1 照常出库（M11 决策 D5）。M13 把两者接进 **core.wms 模块设置**（manifest settings）：`defaultAllocation`（全局缺省分配策略）+ `blockExpiredOutbound`（过期出库拦截开关）。缺省值 = M12 现状（strict / false）——**未配置未传参 = 行为零变化**；改值走既有 profile 慢通道（propose → confirm），零新通道。

- **settings 两键（D1）**：manifest settings schema 声明 `defaultAllocation`（enum strict/fifo/fefo，default strict）与 `blockExpiredOutbound`（boolean，default false）。新库由 install 从 default 种子进 modules 段；**版本不 bump**——老库（0.1.0 已装，install 幂等短路）不补种子，靠工具层兜底（bump 会触发「升级须先卸载」冲突，破坏老库重开）。
- **优先级链（D2）**：`order.create` 单参数 allocation（enum 扩加 `strict`——全局走 fifo/fefo 时单张单可强制严格桶）> `settings.defaultAllocation` > 代码缺省 strict。全局策略对入库单无感（不分配不报错；显式传参 + 入库单仍拒）。
- **工具层读取（readSettings）**：`profile.getSnapshot().modules['core.wms'].settings` 是脏面（老库缺键、慢通道可写任意值）——窄化 + 兜底，非法/缺失回落代码缺省。「配置是唯一行为权威」与「脏配置不炸运行」的边界：流程配置缺失明确报错（M8——删了就没有合法行为可回退），模块设置缺失回落缺省（M13——有明确的代码缺省）。
- **过期判定（D3）**：`batchExpiryDate < today`（UTC，today 运行时取当日）；**今天到期 = 临期可出**（与 `wms.inventory.expiring` 的 `≤ today+days` 语义衔接）。效期以流水首个非空登记为准（expiryOfBatch 同源——出库行自身不声明效期）。
- **拦截语义（D4）**：只拦**单据出库**——order.transition 的 decrease/预检守卫段逐行校验，显式行与分配行同拦（新错误 `WMS_BATCH_EXPIRED`，零事件 fail-fast）；分配器（fifo/fefo）开启拦截时**跳过过期桶**（不让过期货堵死整单，可用桶凑不齐走 AllocationInsufficientError）；`inventory.adjust` / `move` 不拦（盘点、报损、移库是库存管理操作，不是订单履约）。

## 模块化种子（M4 手写 → M6 manifest 驱动）

WmsWorkspace 构造期的 `#seedDefaultProfile()` 已被 `modules.install(WMS_MANIFEST)` 替代——种子不再是领域包手写的两段动作，而是走内核受管管线（预检 → 双轨落事件 → 审计事件）：

1. **基础扩展字段**（sku.spec/category/unit）：manifest.fields.provides → registry.provide（轨道 A）。已存在且类型兼容 → DO NOTHING + usedBy 追加（老库 owner 保持 'core'，归属语义自洽）；新库 owner = 'core.wms'。
2. **基础流程骨架**（inbound/outbound，从 ORDER_TRANSITIONS 誊写）：manifest.workflows.base → 逐流程守卫（目标流程不存在才装）→ applyDirect（轨道 B，config.change version+1）。老库已 seedDefaults 过 → base 全部跳过，仅登记 modules 段。
3. **模块登记**：modules['core.wms'] = { enabled, version, settings }——后续文件库重开在 install 幂等短路处返回（同版本已装，零新事件）。

种子事件的 actor 仍带 @nodeId 后缀（M5 通道节点唯一）：install 的 opts.actor = `module:core.wms@{nodeId}`。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `wms.ts` | WmsDomain：attach 建领域表 + 注册工具 + 派生 core.wms manifest（registerManifest，M13 起 settings 两键 defaultAllocation/blockExpiredOutbound）+ workspace 工厂（同 id 缓存实例）；WmsWorkspace：五内核视图 + 四领域投影（M10 增 locations）+ sync/replay/replayAll + runAtomic 多事件原子落账（M9）+ 构造期 modules.install 种子（M6） | 不含业务校验（在工具 handler）、不手写字段/流程种子（manifest 驱动） |
| `views/sku-view.ts` | wms_sku 投影：applyEvent 幂等（id 查重早退，code 冲突显式炸）+ 查询 | 不解释非 wms.sku.* 事件 |
| `views/location-view.ts` | wms_location 投影（M10）：applyEvent 幂等 + byCode/byId/list 查询；DEFAULT 虚拟桶不落本表 | 不解释非 wms.location.* 事件 |
| `views/order-view.ts` | wms_order/order_line 投影：state_changed 的 from 一致性检查（冲突即抛）+ 查询；行 id 按 orderId:skuId:locationId:batchNo 四段派生（M11，重放幂等键） | 不做命令侧校验（那是工具的事） |
| `views/inventory-view.ts` | 流水（event_id 主键幂等，M11 起带批次/效期列）+ 汇总 UPSERT（主键 (workspace, sku, location, batch) 四列；效期 COALESCE 保首个非空）+ 查询（quantityOf 缺省查 DEFAULT 桶/DEFAULT 批次——M10 调用点语义等价；expiryOfBatch 首个非空效期；listExpiring 临期清单；batchesOf 批次桶清单含 firstSeenAt——M12 分配排序数据源，联 ledger MIN(created_at)） | 无任何「直接改库存」入口 |
| `tools/wms-tools.ts` | 十工具：sku.create/update、location.create/list、order.create/transition、inventory.adjust/move/query/expiring（M11 增一）；`def()` 包装器集中处理 handler 参数逆变；transition 从 Profile workflows 取流程定义校验（M8 行为闭环）+ 库存联动发射段 runAtomic 原子包裹（M9，move 双流水同此）；order.create 挡同单同 SKU 同库位同批次重复行（M9 守卫的 M11 精化）；locationCode/batchNo 统一解析护栏（未建库位拒绝、DEFAULT 直通；批次缺省归 DEFAULT、DEFAULT 拒效期）；assertExpiryConsistent 同批次效期一致性（M11，入库 fail-fast / adjust / move 权威校验）；expandAllocatedLines 批次分配（M12：order.create 出库 allocation strict/fifo/fefo——M13 扩加 strict，未指定批次的行按策略拆分为具体批次行，合计不足抛 AllocationInsufficientError）；readSettings 模块设置窄化读取 + isExpired 过期判定 + 出库守卫过期拦截（M13：defaultAllocation 全局缺省策略 / blockExpiredOutbound 开关，老库缺键与脏值一律兜底代码缺省） | schema 之外不碰总线内部 |
| `events/catalog.ts` | 事件名常量 + payload 类型（M11 起 adjusted/order 行 payload 带可选 batchNo/batchExpiryDate）+ isWmsEventType 分发过滤 + DEFAULT_LOCATION_ID / DEFAULT_BATCH_NO 保留词（migrations 插值的单一来源） | 无状态 |
| `state/order-state-machine.ts` | 转移纯函数校验（canTransition/assertTransition/transitionsFrom，M8 起接受调用方传入的 transitions）+ ORDER_TRANSITIONS 种子誊写源（仅供 defaultWorkflows 消费） | 不落库、不读库、不读任何全局配置 |
| `state/inventory-effect.ts` | 单据→库存联动纯策略（M9）：stockEffectOf（received +/shipped -）+ requiresAvailabilityCheck（out+picking 预检）；仅命令侧消费 | 不落库、不读库；投影层不消费（投影不埋业务策略） |
| `db/migrations.ts` | 六张 wms_ 表（M10 增 wms_location、M11 全面带批次列），IF NOT EXISTS 幂等建表 + 老库检测（ledger 缺 batch_no → 六张投影整组 DROP 重建——M9/M10 老库一道检测全覆盖） | 唯一允许领域 `CREATE TABLE` 的文件 |
| `errors.ts` | 十三个领域错误（code 前缀 WMS_，含 M8 的 WMS_WORKFLOW_NOT_FOUND、M10 的 WMS_LOCATION_EXISTS / WMS_LOCATION_NOT_FOUND、M11 的 WMS_BATCH_EXPIRY_MISMATCH、M12 的 WMS_ALLOCATION_INSUFFICIENT、M13 的 WMS_BATCH_EXPIRED），继承 CoreError | 无状态 |

## 与内核的接缝

| 口子 | 方向 | 说明 |
|---|---|---|
| `@one/core` index.ts | wms → core | 全部内核能力消费 |
| `OneCore.exposeDb()` | core → wms | 建领域表 + 投影句柄（仅领域包装配期） |
| `OneCore.exposeToolBus()` | core → wms | 注册 wms.* 工具 |
| `OneCore.exposeModuleRegistry()` | core → wms | registerManifest 进程目录注册（core.wms 声明面） |
| `ToolContext.appendEvent` | 工具 → 账本 | 工具写业务事件的唯一受控入口 |

## 测试策略（wms）

- **领域测试**（sku/orders/inventory.test.ts）：经工具总线走公共 API，逐条验证护栏（非法转移/负库存/重复编码均拒绝且零事件）。
- **流程引擎闭环（M8）**：经 config.change 事件改 workflows（加转移 → 生效；删转移 → 拒绝；整段删除 → WMS_WORKFLOW_NOT_FOUND），验证「配置是唯一行为权威」；种子一致期（默认配置 = ORDER_TRANSITIONS）由既有用例回归（行为不变的证明）。
- **单据→库存联动（M9）**：order-inventory-linkage.test.ts——received 自动上架 / picking 预检 / shipped 扣减与硬守卫（含「picking 后库存被挪走」窗口的原子性可观测断言）/ 无效应状态不动账 / replay 重建一致 / 手动 adjust 共存；orders.test.ts 补重复行拒绝用例。
- **库位管理（M10）**：location.test.ts——创建 / 唯一 / 保留字 / 引用未建库位拒绝；inventory-location.test.ts——分桶入账 + query 三形态 / 入库行分桶上架 / 出库按行库位守卫 / 移库全家桶（余量与同库位拒绝）/ replay 重建一致 / **老库收敛**（文件库跑 M9 流量 → 模拟旧表结构（缺库位列与批次列）→ 重开断言 DEFAULT 桶与流水重建——M11 收敛语义）。
- **批次/效期（M11）**：batch.test.ts——批次分桶与效期一致性（同批次异效期拒绝 / DEFAULT 拒效期 / 出库行带效期拒绝）/ 批次出库严格桶守卫 / 单据行批次（入库声明批次与效期、同单同 SKU 同库位分批次多行、四段行键查重）/ 移库带批次 / query 树形下钻 + 临期查询 / replay 重建一致 / **老库收敛**（M10 结构 → 六表 DROP 重建）/ **混合版本**（无批次字段的 M10 事件 → 投影兜底 DEFAULT）；不带批次的 M10 流量等价性由既有测试机械补断言全绿保证。
- **批次分配策略（M12）**：batch.test.ts——fifo 首笔时间序拆行（跨桶凑数、事件行已是具体批次）/ fefo 效期升序 + 无期批次最后（DEFAULT 参与）/ 缺省不传 allocation 的 M11 严格桶回归 / 显式批次行不参与分配 / 合计不足 AllocationInsufficientError 零事件 / 分配行与手动行同键查重 / 入库 + allocation 拒 / 非法策略值 schema 拒 / 全流程（picking 预检 → shipped 逐批次扣减 → replay 一致）。
- **分配/拦截设置（M13）**：allocation-settings.test.ts——新库种子两键缺省 / 老库空 settings（remove 模拟）兜底 strict / 脏值兜底（非法策略值回落 strict、非 true 回落 false）/ 全局 fefo 不传参按 fefo 拆行 / 参数 strict·fifo 覆盖全局 / 全局策略对入库单无感 / 慢通道改值即时生效 / 拦截全家桶（显式过期批次 picking 拒 WMS_BATCH_EXPIRED 零事件、今天到期边界可出、fefo 分配跳过过期桶、全过滤凑不齐走 WMS_ALLOCATION_INSUFFICIENT、picking 后开启拦截 shipped 仍拒且库存不动、缺省 false 过期照常出的 M12 回归、adjust/move 不拦）。
- **manifest 迁移回归（M6）**：构造期 install 与 M4 手写种子行为等价（字段/流程/幂等/文件库重开零膨胀——现有 e2e 全绿即证明）；老库收敛场景在 core 的 modules.test.ts 覆盖。
- **端到端**（end-to-end.test.ts）：字段注册 → AI 工具链 → replay 重建一致；投影篡改被 replay 修正；多工作区隔离；文件库重开身份保持。

---

# @one/ai AI 快通道架构（里程碑 3）

> 自然语言 ⇄ Tool Calling。依赖方向：`@one/ai → @one/wms → @one/core`（应用层组合领域与内核）。

## 分层地图

```
┌─ 出口层 ─────────────────────────────────────────────┐
│  index.ts              公共 API 唯一出口              │
├─ 组合层 ─────────────────────────────────────────────┤
│  wms-agent.ts          WmsAgent 工厂（绑工作区/actor）│
├─ 编排层（纯逻辑，零 SDK 依赖）───────────────────────┤
│  agent.ts              runAgent 循环（run 一次性）； │
│                        streamAgent 生成器（M12 流式，│
│                        ui.ask 挂起经 next() 唤醒）   │
│  system-prompt.ts      快照 + 行为规则组装            │
│  types.ts              LlmProvider 接缝（纯类型）     │
├─ Provider 薄适配层（IO 边界）────────────────────────┤
│  provider/vercel.ts    Vercel AI SDK 单轮补全 +      │
│                        消息/工具格式互译              │
│  provider/config.ts    OpenAI 兼容 / Ollama 配置切换  │
└──────────────────────────────────────────────────────┘
```

## 关键机制

- **循环主权在编排层**：`generateText` 以 `stopWhen: isStepCount(1)` 做单轮补全，工具不挂 execute——步间循环（结果回传后再调模型）在 `agent.ts`，是纯逻辑、可单测；SDK 只负责一次网络往返与格式互译。
- **错误回传不中断**（§4.2 快通道护栏语义）：invoke 的任何异常（ToolRejectedError 族、领域错误）转为 `ok: false` 的工具结果回传模型，由它向用户解释；被拒操作本来就不落事件（审计免费）。
- **审计绑定**：`createWmsAgent` 把 actor 固定为 `ai:模型名`——AI 经工具总线的每次操作都落 oplog（`oplog.actor` 即审计日志）。
- **System Prompt v2（M4）**：行为规则 + 库存快照（SKU 跨库位求和——M10 修正多桶静默丢失；超 20 条截断引导用查询工具）+ 库位清单上下文（M10：实体库位编码 + DEFAULT 提示，分桶余量引导用查询工具）+ 批次引导（M11：SKU×库位×批次分桶、DEFAULT 虚拟批次、入库声明批次与效期、临期用 wms.inventory.expiring）+ **Profile 摘要**（§6.4 闭环 ②：可见扩展字段清单、流程概要、模块开关）+ **慢通道规则**（改配置必须走 profile.propose 工具提交 JSON Patch，把影响报告转述用户等待确认，禁止声称已应用）。工具清单走 function calling 的 tools 参数（原生通道，不在 prompt 文本重复）。
- **maxSteps 保护**：默认 8 步，超限抛 `AgentStepLimitError`（防模型无限循环）。
- **streamAgent 流式生成器（M12）**：`AsyncGenerator<AgentStreamEvent, AgentTurnResult, AskReply>`——事件流（text-delta / tool-call / ask / tool-result / turn-done）由驱动方逐个消费（server 直译为 SSE）；ui.ask 在编排层拦截（不进 invoke、不落 oplog = 审计豁免），`yield ask 事件` 后挂起，驱动方经 `next(reply)` 注入回答续流（`{answer}` 或 `{declined:true}` 跳过/超时）。
- **run() 单轮任务式；多轮会话在 server 会话层**（M12）：`run()` 无跨次记忆，多轮历史由 server 内存会话持有（见 @one/server「AI 会话与 ui.ask」），stream() 是会话通道的形态（ui.ask 只在 stream 的工具清单里附加）。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `agent.ts` | 编排循环：`runAgent`（run 一次性返回）+ `streamAgent`（M12 流式生成器：事件流逐个 yield、ui.ask 挂起经 next() 唤醒）；maxSteps 保护 | 不做任何 IO（provider 注入）、不认识 SDK 类型、不持有会话状态（驱动方的事） |
| `types.ts` | LlmProvider / AgentMessage / ToolCallRequest/Result / AgentStreamEvent / AskReply 等接缝类型 | 无运行时 |
| `system-prompt.ts` | 快照（SKU 总数/总量/明细前 20，跨库位求和）+ 库位清单（M10）+ 批次引导（M11：分桶/DEFAULT/效期/临期工具；M12：出库单 allocation 策略；M13：全局缺省策略与过期拦截是模块设置，改值走慢通道）+ Profile 摘要（可见扩展字段/流程概要/模块开关）+ 慢通道行为规则 + **ui.ask 提问规则**（M12：缺必要信息时一次问一个具体问题；用户未回答不重复追问）+ 当前时间 | 不注入工具清单（走 tools 参数） |
| `wms-agent.ts` | 便利工厂：绑定 WmsWorkspace、actor=`ai:模型名`、tools.list() 快照、每次 run/stream 重组 system；stream() 附加 ui.ask 工具（M12） | 不做编排逻辑（委托 runAgent/streamAgent） |
| `provider/vercel.ts` | 单轮 generateText + 消息/工具双向翻译（含 `error-json` 错误输出、不可序列化返回值降级） | 不做多步循环、不执行工具（无 execute） |
| `provider/config.ts` | AiProviderConfig → LanguageModel；Ollama 走原生 OpenAI 兼容端点（默认 `http://localhost:11434/v1`，`@ai-sdk/ollama` 已从 registry 移除） | 不读环境变量/配置文件（调用方给配置） |

## 测试策略（ai）——绝不打真实 API

- **编排循环**（agent.test.ts）：脚本化 mock provider 驱动——多轮循环、同轮多工具、错误回传不中断、maxSteps、旁白保留；streamAgent 流式（事件序）与 ui.ask 挂起/唤醒（answer/declined 注入、非法应答兜底 declined、与普通工具混排时 ui.ask 不进 invoke）。
- **适配层**（vercel-provider.test.ts）：`MockLanguageModelV4`（ai/test）锁定行为契约——toolCalls 解析（input JSON 串 → args 对象）、消息/工具翻译、**无 execute 的工具被调用时 SDK 正常返回**。
- **端到端**（wms-agent.test.ts）：mock provider + 真实内核/wms——actor 落审计、护栏在 AI 通道照常生效（超量出库被拒 + 零事件 + 错误回传）、快照注入。

## 环境备注：workspace 链接不可用时的解析兜底

当前命令执行沙箱会把 `node_modules/@one/*` 的 junction 目标重写为单命令私有缓存路径（命令结束即失效，fsutil 可证）。兜底：`packages/wms`、`packages/ai` 的 `tsconfig.json` 用 `paths`、`vitest.config.ts` 用 `resolve.alias`，直接指向兄弟包 `dist` 实体文件（保持「测试消费 dist」纪律）。非沙箱环境下 npm 原生链接可用，两套配置共存无冲突。

`packages/server` 同理，且多一层**运行时**兜底：`npm run dev`（tsx）走 `tsconfig.runtime.json` 的 paths（→ 各包 `dist/index.js` 实体文件），不依赖 node_modules 链接；`npm start`（node dist/main.js）留给正常链接环境。`packages/app` 的 `vite.config.ts` alias 指向 `../core/src`——type-only import 编译期擦除，不产生打包依赖（误引运行时值会在构建期报错，即护栏）。

---

# @one/server 宿主服务包架构（UI 里程碑）

> 慢通道闭环、管理界面与**局域网同步传输层（M5）**的宿主及 API 层。依赖方向：`@one/server → @one/ai → @one/wms → @one/core`（server 是最顶层的组合层/宿主）。同步的协议逻辑在 @one/core（sync/），本包只做传输编排（HTTP 拉模型）与触发（手动端点/定时轮询）。

## 分层地图

```
┌─ 出口层 ──────────────────────────────────────────────┐
│  index.ts          createApp() + start()（进程入口）   │
├─ 组装层 ──────────────────────────────────────────────┤
│  context.ts        AppContext：OneCore + WmsDomain +   │
│                    WmsAgent + 配置（进程级单例装配）    │
├─ 路由层（HTTP 边界）──────────────────────────────────┤
│  routes/profile.ts     GET  /api/profile/snapshot      │
│  routes/proposals.ts   GET  /api/proposals             │
│                        POST /api/proposals/:id/confirm │
│                        POST /api/proposals/:id/reject  │
│  routes/wms.ts         管理界面业务端点（读视图/写工具，│
│                        M14 增效期看板读端点）           │
│  routes/chat.ts        AI 会话 SSE（M12：消息流 +      │
│                        ui.ask 应答端点，见下）           │
│  routes/sync.ts        同步三端点（M5，见下）            │
│  routes/keys.ts        工作区密钥四端点（M7，见下）      │
│  routes/migration.ts   迁移导出/导入两端点（M7，见下）   │
│  routes/relay.ts       中继回合触发端点（M7，见下）      │
├─ 同步层（节点间传输编排，M5）────────────────────────────┤
│  sync/sync-client.ts   runSyncRound：hello → 拉取计划 → │
│                        分页拉取 → 摄入 → replayAll      │
├─ 中继层（节点↔中继传输编排 + 中继本体，M7）──────────────┤
│  relay/relay-app.ts    createRelayApp：中继四端点 +     │
│                        RelayStore 内存密文暂存（VPS 部署）│
│  relay/relay-client.ts runRelayRound：push（seal）→     │
│                        pull（unseal）→ 摄入 → replayAll │
├─ 支撑层 ──────────────────────────────────────────────┤
│  errors.ts         core 错误 code → HTTP 状态码映射    │
│  ai-config.ts      环境变量 → AiProviderConfig         │
│  static.ts         托管 app/dist（存在则挂载）          │
└───────────────────────────────────────────────────────┘
```

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `index.ts` | createApp(context) 组装 Hono 应用 + start() 监听端口（唯一进程入口） | 不含业务逻辑 |
| `context.ts` | AppContext 装配：OneCore.open(数据库路径) + WmsDomain.attach + createWmsAgent(provider) + 工作区选择 | 不认识 HTTP（可被任何宿主复用——含未来 Tauri sidecar） |
| `routes/*.ts` | HTTP 契约：参数提取 → 调用 workspace 视图/agent → JSON 序列化 | 不做业务校验（在工具 handler / ProfileService）、不碰 SQL |
| `routes/wms.ts` | 管理界面业务端点：读操作直查投影（skus/orders/inventory 视图，明细行联查经 `ws.skus.byId` 组装 skuCode/name），写操作一律 `ws.tools.invoke('wms.*', body, actorOf(ctx))`（actor=`user:local@{nodeId}`）并透传工具返回值；效期看板读端点（M14）`GET /api/inventory/expiry`——inventory.list() 桶行按 (SKU, 批次) 聚合（余量跨库位合计 + 库位编码清单联查）+ daysLeft/level 五层分级 + 效期升序，全在路由层组装 | 不做业务校验（工具 handler 的职责）、不碰 SQL（联查走视图 API） |
| `routes/chat.ts` | AI 会话端点（M12）：内存会话 Map（生命周期/并发约束见「AI 会话与 ui.ask」）+ SSE 流式消息 + ui.ask 应答注入 | 不做事件归约（前端的事）、不落会话到磁盘（会话是交互态不是事实） |
| `errors.ts` | 错误映射中间件：CoreError.code → HTTP 状态 + `{ code, message }` 响应体 | 不吞错（未知错误 500 带原文） |
| `sync/sync-client.ts` | runSyncRound(peer)：hello 握手（校验 workspaceId 一致 + 自拉防护）→ computePullPlan → 分页拉取 → core.sync.applyRemote → accepted>0 时 ws.replayAll；fetchImpl 可注入（测试零网络） | 不解析事件内容（摄入幂等在 core）、不做发现/推送/加密（v1 裁剪） |
| `routes/sync.ts` | 同步 HTTP 契约：`GET /api/sync/hello`（握手）、`GET /api/sync/events/:actor?fromSeq=&limit=`（区间供事件 + 分页游标）、`POST /api/sync/run`（body `{ peers? }`，缺省 env `ONE_SYNC_PEERS`；逐 peer 跑回合，单 peer 失败不炸整轮） | 不做协议计算（在 core）、不持有状态 |
| `routes/keys.ts` | 工作区密钥 HTTP 契约（M7）：`POST /api/keys`（生成）、`GET /api/keys`（存在性/指纹/时间）、`GET /api/keys/export`（明文密钥出库——人工交换）、`POST /api/keys/import`（64 位 hex 校验） | 不做密钥运算（在 core.keys）、export 不做权限控制（本地可信域定位，v1 无角色） |
| `routes/migration.ts` | 迁移 HTTP 契约（M7）：`GET /api/migration/export`（全量事件包）、`POST /api/migration/import`（幂等导入 + replayAll + manifest 在场性报告——对照 exposeModuleRegistry().listManifests 扫描 module.installed 事件） | 不做包结构校验（在 core.migration）、不阻塞缺失 manifest（报告语义） |
| `routes/relay.ts` | 中继回合触发（M7）：`POST /api/relay/run`（body `{ relay? }`，缺省 env `ONE_RELAY_URL`；密钥预检缺失 → 400 `RELAY_NO_KEY`） | 不做传输编排（在 relay-client）、不持有中继状态 |
| `relay/relay-app.ts` | 中继 HTTP 契约 + 内存存储（M7）：`createRelayApp()`——hello / events（与节点 sync 同构的分页契约）/ push（幂等 + 冲突拒收 + 目录刷新）/ directory 四端点；独立进程入口（relay-main.ts） | 不装配 OneCore、不持久化任何数据（重启即清，节点水位差额自动重推）、不解释密文（信封元数据照转） |
| `relay/relay-client.ts` | runRelayRound（节点侧中继回合，M7）：hello → push（computePullPlan 反向 + eventsFor 分页 + seal）→ pull（computePullPlan + 密文分页 + unseal）→ applyRemote → replayAll；fetchImpl 可注入（测试零网络） | 不管理密钥（core.keys 取用）、不碰中继存储（那是 relay-app 的事） |
| `ai-config.ts` | 读 env（`ONE_AI_*` / `OLLAMA_*`）→ AiProviderConfig；未配置时 chat 路由返回 503 明示 | 不做 provider 构建以外的任何事 |
| `static.ts` | SPA 静态托管：app/dist 存在则挂载 + history 回退到 index.html | dist 不存在时静默跳过（纯 API 模式可独立运行） |

## 关键机制

- **API 契约（v1）**：
  - `GET /api/health` → `{ nodeId, ok }`；
  - `GET /api/profile/snapshot` → ProfileSnapshot（确认界面的「现状」数据源）；
  - `GET /api/proposals` → `ProposalSummary[]`（仅 pending，确认/拒绝即从列表消失）；
  - `POST /api/proposals/:id/confirm` body `{ by? }`（缺省 `user:local@{nodeId}`，显式传可覆盖——预留多用户）→ `{ newVersion, appliedOps }`；`PROPOSAL_STALE` → 409（前端提示「配置已变化，请让 AI 重新提议」）；
  - `POST /api/chat/sessions/:id/message` body `{ message }` → **SSE 流式**（M12 会话化）：AgentStreamEvent 直译为 SSE 事件名（`text-delta` / `tool-call` / `ask` / `tool-result` / `turn-done` / `error`），前端逐事件渲染（工具卡先落「执行中」、结果回填、助手文本逐 delta 增长）；
  - `POST /api/chat/sessions/:id/answer` body `{ callId?, answer }`（或 `{ declined: true }`）→ ui.ask 挂起流的用户应答（M12 步骤3，见下「AI 会话与 ui.ask」）。
- **管理界面业务 API（读写分治）**：
  - **读 = 直查投影视图**（投影是缓存，只读安全）：`GET /api/skus` → `SkuRecord[]`；`GET /api/orders?direction=in|out`（query 可选）→ 订单数组，每单附 `lines`（`ws.orders.lines` + `ws.skus.byId` 联查补 skuCode/name——组装在路由层完成，不碰 SQL）；`GET /api/inventory` → 库存清单（`ws.inventory.list` 按 SKU 跨库位跨批次求和 + SKU 联查，响应形态与 M9 一致——M10/M11 前端零改动；分桶明细走 `wms.inventory.query` 工具）；`GET /api/inventory/expiry` → **效期看板**（M14）`{ today, rows }`——rows 按 (SKU, 批次) 聚合（余量跨库位合计、库位编码清单、SKU 联查），每行携带后端算好的 `daysLeft`（UTC 日期差，null = 未登记）与 `level` 五层分级：`expired`（< 今天）/ `critical`（≤7 天）/ `warning`（≤30 天）/ `safe`（>30 天）/ `unknown`（效期 null，含 DEFAULT 虚拟批次）——**「今天」判定与 M13 拦截同界**（今天到期 = 临期未过期）；零余量桶不上板（出清批次无预警意义）；排序效期升序（最紧急在上、未登记殿后）。分层阈值是 server 展示常量（7/30 天）而非 settings 键——阈值配置化是生长点。
  - **写 = 全部经工具总线**（人与 AI 走同一条命令通道，护栏 + 审计免费）：`POST /api/skus` body `{ skuCode, name, extData? }` → `wms.sku.create`；`POST /api/orders` body `{ direction, lines, orderNo?, note? }` → `wms.order.create`；`POST /api/orders/:orderNo/transition` body `{ to }` → `wms.order.transition`；`POST /api/inventory/adjust` body `{ skuCode, delta, reason?, orderNo? }` → `wms.inventory.adjust`。actor 固定 `user:local@{nodeId}`（同步通道节点唯一，见 @one/core「同步回合」决策 5；与 confirm 默认值一致：人类本地界面操作，审计可辨）。
  - 工具返回值原样透传为 2xx 响应体；`WMS_*` 领域错误经映射表统一 400 + code（前端按 code 分支提示）。
- **错误映射表**：`PROPOSAL_NOT_FOUND` → 404；`PROPOSAL_STALE` / `PROPOSAL_STATE` → 409；`PROFILE_VALIDATION` → 422；`TOOL_*` / 领域错误 → 400（快通道护栏语义：错误回传前端展示，不落事件）。前端按 `code` 分支提示文案，不 parse message。
- **确认权在 HTTP 侧同样成立**：confirm/reject 是普通 REST 端点（宿主进程即「人操作的界面」），**永不注册为工具**——AI 经 chat 走工具总线，拿不到这两个端点（§4.1 确认权不可委托的传输层落实）。
- **AI 会话与 ui.ask 挂起/唤醒（M12）**：
  - **会话生命周期**：server 内存 Map（sessionId → `{ history, status, pendingAsk? }`，2 小时空闲清理；进程重启即弃——会话是交互态不是事实，事件账本才是）。`status: idle|streaming`；streaming 期间新消息 → 409 `CHAT_SESSION_BUSY`（单在途流）；仅 `turn-done` 后才把本轮 messages 提交进 history（失败轮不落，下一条消息从上一轮重来）。
  - **ui.ask 的审计豁免**：ui.ask 是「模型向用户提问」的挂起工具——agent 层拦截（不进工具总线、不落 oplog），只附加在会话通道的 stream() 工具清单里（run() 不提供）。挂起语义用生成器实现：`streamAgent` yield `ask` 事件后暂停，server 侧登记 pendingAsk（5 分钟超时按 declined 结算），`answer` 端点收到回答经 `next(reply)` 注入续流；回答随下一轮请求回传模型。
  - **UI 消费**：ask 事件在前端渲染回答输入卡（AskCard），回答走 answer 端点，终态 tool-result 沿原 SSE 连接回来回填。
- **AI 可选性**（§9.2）：env 未配置 AI 时 server 照常启动，仅 chat 端点返回 503——表单/确认界面不受影响。
- **Tauri 接缝（终态预留，本次不实现）**：context.ts 不感知自己被谁托管；Tauri 壳将来 spawn `node packages/server/dist/index.js`（sidecar）+ 内嵌 app/dist 即成桌面节点，零代码改动。
- **单工作区 v1**：env `ONE_WORKSPACE`（默认 `default`）；多工作区切换是后续演进。
- **同步 API（M5，拉模型——协议与决策见 @one/core「同步回合」章节）**：
  - `GET /api/sync/hello` → `{ nodeId, workspaceId, profileVersion, watermarks, eventCount }`（水位 = 各 actor 的 seq 高位，watermarks 各项含通道指纹 checksum；同步组 = 同 workspaceId）；
  - `GET /api/sync/events/:actor?fromSeq=0&limit=500` → `{ actor, events, nextFromSeq, hasMore }`（limit 上限 1000；fromSeq/limit 非法 → 400）；
  - `POST /api/sync/run` body `{ peers?: string[] }` → `{ rounds: SyncRoundResult[] }`（peers 缺省取 env `ONE_SYNC_PEERS` 逗号分隔；两者皆空 → 400 提示配置）；
  - **定时轮询**：start() 里 `ONE_SYNC_PEERS` 非空时按 `ONE_SYNC_INTERVAL_MS`（默认 30000）周期跑回合，关闭时清定时器；
  - **v1 安全边界**：局域网明文、无鉴权（个人可信网段定位）；跨互联网同步走 M7 中继密文通道（payload E2E 加密，中继只见密文）——节点直连上公网仍不安全，属使用纪律。
- **M7 API（密钥 / 迁移 / 中继——协议与决策见「云中继与迁移导出」章节）**：
  - `POST /api/keys` → `{ key?, fingerprint, createdAt }`（生成 256-bit 工作区密钥；已存在 → 409 `KEY_EXISTS`）；
  - `GET /api/keys` → `{ exists, fingerprint?, createdAt? }`（不回密钥本体）；
  - `GET /api/keys/export` → `{ key }`（明文本体，人工交给新节点——本地可信域）；
  - `POST /api/keys/import` body `{ key }`（64 位 hex；已有 → 409）；
  - `GET /api/migration/export` → `MigrationBundle`（全量事件 + 元信息，明文 JSON 文件）；
  - `POST /api/migration/import` body `{ bundle }` → `{ accepted, skipped, replayed, missingManifests: [{ id, version }] }`；
  - `POST /api/relay/run` body `{ relay?: string }` → push+pull 一轮结果（缺省 env `ONE_RELAY_URL`；皆空 → 400；无密钥 → 400 `RELAY_NO_KEY`）；
  - **中继定时**：start() 里 `ONE_RELAY_URL` 非空时按 `ONE_RELAY_INTERVAL_MS`（默认 60000）周期跑中继回合；
  - **中继独立部署**：`npm run start:relay`（env `ONE_RELAY_PORT` 默认 3900）——VPS 零状态进程，内存暂存密文。

## 测试策略（server）——不起端口、不碰真实 LLM

- **路由级直测**：`createApp(ctx).request(url, init)` 走 hono 内建测试口——内存库 + mock provider（脚本化 LlmProvider，同 @one/ai 测试手法）。
- 覆盖：proposals 全流程（propose 经真工具总线 → list → confirm → 409 新鲜度）、chat SSE 流式（事件序、多轮历史回传、error 事件后会话可继续、并发 409 CHAT_SESSION_BUSY）与 ui.ask 挂起/唤醒（SseReader 增量读流：ask 事件 → answer 注入续流 → 回答回传模型、挂起期间新消息 409、ui.ask 不落 oplog 的审计豁免断言、5 分钟超时按 declined 结算、404/409 分支）、错误映射表逐 code 断言、AI 未配置 503、管理端点（建 SKU → 列表含 extData、建单 → 明细联查、流转 → 状态变化、库存调整 → 清单更新、`WMS_SKU_EXISTS` / `WMS_INVALID_TRANSITION` / `WMS_INSUFFICIENT_STOCK` 护栏 400）、效期看板（M14：SKU×批次聚合、跨库位余量合计与库位清单、五层分级与边界天数（-3/0/7/30/31）、零余量桶过滤、效期升序未登记殿后、空库存空板）、同步端点（vi.stubGlobal 转发 fetch 到对端 app.request，双 AppContext 模拟双节点零网络：双向互拉收敛、参数非法 400、同步组不一致 error、自拉防护 skipped-self、无 peers 400）。
- **中继与迁移测试**（relay.test.ts / migration.test.ts，M7）：中继 app 直测（push 幂等 skipped、异 eventId 冲突 conflicted、hello 水位与通道指纹、events 分页与参数校验、directory 心跳刷新、workspaceId 缺失 400）；**三方零网络集成**（双 AppContext + createRelayApp，fetch 转发）：A 生成密钥 → export → B import 密钥 → A 经中继 push → B 经中继 pull 收敛（水位/计数/投影一致、密文往返无感）、**中继存储无明文断言**（序列化中继状态不含业务字符串）、错钥节点拉取 → CRYPTO_ERROR 400；迁移端点（export → 新节点 import → replay → SKU/库存/配置一致、重复导入幂等、manifest 在场性报告、无密钥 relay/run 400）。

---

# @one/app 前端包架构（UI 里程碑）

> React 18 + Vite + TS + Ant Design 5 + TanStack Query。v1 范围 = 管理界面四页（SKU 动态列表 / 出入库单 / 库存 / 效期看板，DESIGN §2.2「无 AI 也能用」的落地）+ 慢通道闭环（AI 对话面板 + 提议列表 + 影响报告渲染 + 确认/拒绝，§7.3 确认 UI 的落地）+ 设置页（M8：节点名片 / 局域网同步 / 云中继 / 工作区密钥 / 迁移——M5/M7 全部运维能力的用户面收口）。

## 分层地图

```
┌─ 入口 ────────────────────────────────────────────────┐
│  main.tsx / App.tsx   AntD ConfigProvider(zhCN) +     │
│                       布局（侧导航：对话/配置确认）+    │
│                       QueryClientProvider              │
├─ 会话层（M12）────────────────────────────────────────┤
│  app-nav.tsx           七页导航 context + 跳转携带     │
│                        一次性 initialFilter           │
│  chat/ChatProvider.tsx AI 对话状态（App 级 context，  │
│                        切页不丢）+ SSE 事件归约       │
├─ 页面层 ──────────────────────────────────────────────┤
│  pages/SkusPage.tsx       SKU 列表（动态列）+ 新建表单  │
│  pages/OrdersPage.tsx     单据列表 + 建单 + 状态流转    │
│  pages/InventoryPage.tsx  库存清单 + 过滤 + 手工调整   │
│  pages/ExpiryPage.tsx     效期看板（M14：分层统计卡 + │
│                            着色表格 + 层/关键词过滤）  │
│  pages/ChatPage.tsx        对话面板（消息流 + 输入 +   │
│                            工具调用过程卡片）           │
│  pages/ProposalsPage.tsx   pending 提议列表 + 详情抽屉 │
│  pages/SettingsPage.tsx    设置（节点/同步/中继/密钥/ │
│                            迁移，M8）                  │
├─ 组件层 ──────────────────────────────────────────────┤
│  components/ImpactReportView.tsx   影响报告渲染        │
│  components/ToolInvocationCard.tsx 工具调用过程展示    │
│                        （流式回填 + 结果表格 + 后置    │
│                         动作跳转按钮）                  │
│  components/ToolResultView.tsx    查询结果按形态成表  │
│  components/AskCard.tsx            ui.ask 回答输入卡  │
│  components/ProposalDetail.tsx     提议详情 + 确认/拒绝│
│  components/SkuFormModal.tsx       新建 SKU（动态表单）│
│  components/OrderFormModal.tsx     建单表单（明细行）    │
├─ 数据层 ──────────────────────────────────────────────┤
│  api/client.ts        fetch 封装（错误 code 透传）+    │
│                        SSE 流消费（M12 事件契约镜像）  │
│  api/hooks.ts         TanStack Query hooks            │
│                        （useSkus/useOrders/…）          │
└───────────────────────────────────────────────────────┘
```

## 依赖规则（本包特有护栏）

- **`@one/app → @one/core` 只允许 type-only import**（ImpactReport / ProposalSummary / ProfileSnapshot / EventEnvelope 等契约类型）。实现手段：package.json **不声明** `@one/core` 依赖（避免 better-sqlite3 等原生模块进前端依赖树），tsconfig `paths` + vite `resolve.alias` 指向 `../core/src`；`import type` 编译期擦除，vite 不打包——**误引运行时值会在构建期立即报错**（天然护栏，错误早暴露）。
- `@one/app → @one/server`：仅 HTTP 契约（fetch），无 npm 依赖、无类型依赖（server 的 API 类型由 core 契约类型 + 本包 api/client.ts 手写响应类型构成）。
- dev 流：`vite dev`（5173）proxy `/api` → `localhost:3000`；生产流：server 托管 app/dist 同源（零 CORS 配置）。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `App.tsx` | 布局壳 + 路由（v1 七页，AntD Menu 切换：管理四页 + AI 两页 + 设置页）+ 中文 locale；AppNavProvider 包壳（M12 步骤4：AI 后置动作可跳任意页） | 不含业务组件 |
| `app-nav.tsx` | 导航 context（M12 步骤4）：`navigate(page, filter?)` 切页 + 携带一次性 initialFilter（目标页挂载时 `takeInitialFilter` 消费，取后即清） | 不渲染页面（App.tsx 消费 page 渲染） |
| `chat/ChatProvider.tsx` | AI 对话状态壳（M12）：sessionId 前端生命周期唯一、`send()` 消费 SSE 流并归约事件到 turn、`answerAsk()` 提交 ui.ask 应答；App 级 context——切页不丢对话 | 不渲染对话 UI（ChatPage 的事）、不直接碰 fetch 细节（client.ts 封装） |
| `pages/SkusPage.tsx` | SKU 列表（动态列，见关键机制）+ 新建入口 | 不做字段元数据管理（那是慢通道提议的事） |
| `pages/OrdersPage.tsx` | 单据列表（方向筛选 + 单号过滤——AI 跳转预填）+ 建单表单（明细行）+ 状态流转按钮（候选目标状态由 Profile workflows 计算） | 不做转移合法性裁决（工具 handler 的 400 是兜底） |
| `pages/InventoryPage.tsx` | 库存清单（联查 SKU 信息 + 编码/名称过滤——AI 跳转预填）+ 手工调整表单（delta 正负 + 原因；行内预填 / 顶部自选 SKU 两种入口——空库存可录期初） | 不展示流水明细（审计走事件账本，v2 接缝） |
| `pages/ExpiryPage.tsx` | 效期看板（M14）：五层统计卡（已过期/紧急/预警/安全/未登记效期——前端 reduce 计数）+ 着色表格（分层 Tag、剩余天数分形渲染、库位合并展示）+ 层下拉与关键词过滤；消费后端算好的 daysLeft/level，纯展示零计算 | 不做分层/日期计算（server 的职责——单一真相）；不提供改阈值入口（常量在 server，配置化是生长点） |
| `components/SkuFormModal.tsx` | 新建 SKU 表单：固定字段（skuCode/name）+ 可见扩展字段按 type 动态渲染输入控件 | 不解释字段语义（只按 type 映射控件） |
| `components/OrderFormModal.tsx` | 建单表单：方向 + 明细行（SKU 下拉来自投影 + 数量）+ 备注 | 不做明细校验（工具 handler 的职责） |
| `pages/ChatPage.tsx` | 对话面板（M12）：消息流渲染、发送（isStreaming 串行）、工具卡 + AskCard + 后置动作按钮（onAnswer/onNavigate 注入） | 不管理会话状态与 SSE 消费（ChatProvider 的事） |
| `pages/ProposalsPage.tsx` | pending 列表 + 轮询刷新（Query refetchInterval）+ 详情抽屉 | 不做确认逻辑（在 ProposalDetail） |
| `components/ImpactReportView.tsx` | 影响报告渲染：summary 统计 + items 按 severity 分色（warning 黄 / info 蓝）+ 中文 description 直出 | 不做裁决（人确认） |
| `components/ProposalDetail.tsx` | note/patch 摘要 + ImpactReportView + 确认/拒绝按钮（409/422 按 code 提示） | 不直接调 ProfileService（只走 HTTP） |
| `components/ToolInvocationCard.tsx` | 工具调用过程卡（M12）：流式落卡/回填终态、参数与结果摘要、ui.ask 分流（AskCard / 问答回显）、成功工具的后置动作按钮（如「去确认提议」「去库存页查看」） | 不执行工具、不直接跳页（onNavigate 回调注入） |
| `components/ToolResultView.tsx` | 查询结果按 toolId + payload 形态渲染表格（inventory.query 三形态 / expiring / location.list，超 50 行截断），其余 JSON 兜底 | 不做数据拉取（渲染传入的 payload 快照） |
| `components/AskCard.tsx` | ui.ask 挂起态的回答输入（提交/跳过，提交后锁定） | 不提交请求（onAnswer 回调注入） |
| `pages/SettingsPage.tsx` | 设置五分区（M8）：节点名片（只读）/ 局域网同步（peers + 手动回合）/ 云中继（URL + 手动回合）/ 工作区密钥（生成/导入/导出指纹）/ 迁移（导出下载 + 导入上传） | 不持久化任何配置（peers/relay 每次随请求发送，服务端 env 是唯一持久位）；不展示中继侧目录（那是中继进程的视角） |
| `api/client.ts` | fetch 封装：JSON 序列化、非 2xx 抛 `ApiError{code,message}`；chat 事件契约手写镜像（不依赖 @one/ai）+ SSE 流消费（streamChatMessage）+ ui.ask 应答（answerChatAsk）+ 效期看板契约（ExpiryBoard/ExpiryBatchRow/ExpiryLevel 镜像 + expiryBoard()，M14） | 不缓存（Query 的职责） |
| `api/hooks.ts` | useSkus / useCreateSku / useOrders / useCreateOrder / useTransitionOrder / useInventory / useAdjustInventory / useProfileSnapshot / useProposals / useConfirmProposal / useRejectProposal + useExpiryBoard（M14）+ M8 设置页组（useNodeHello / useSyncRun / useRelayRun / useKeyStatus / useGenerateKey / useImportKey / useExportKey / useMigrationExport / useMigrationImport）；adjust 与单据流转的 onSuccess 一并失效 expiry-board（桶余量变化 → 看板随之新鲜） | 不做 UI 判断 |

## 关键机制

- **SKU 动态列（Profile 配置的第一个真实消费闭环）**：`useProfileSnapshot()` 读 `schema.entities.sku.extensions`，AntD Table 的 columns = 固定列（编码/名称/更新时间）+ `visible !== false` 的扩展列（`dataIndex: ['extData', key]`，title = label）。新建表单（SkuFormModal）的扩展输入项同源生成，type → 控件映射：string→Input、number→InputNumber、boolean→Switch、date→Input（v1 不引日期库）、json→TextArea（提交时 JSON.parse 校验）。**隐藏字段的语义 = 列与输入项同时消失，数据保留**（软删除的界面投影）；在配置确认页确认「隐藏字段」提议后 invalidate snapshot → 切回 SKU 页列即消失——AI 改配置 → 界面变化的端到端闭环。
- **单据流转按钮由 Profile workflows 驱动**：候选目标状态 = `workflows[inbound|outbound].transitions.filter(t => t.from === 当前列)`（方向映射：in→inbound、out→outbound）——UI 消费配置面。M8 起行为权威也是配置面（工具 handler 从同一 workflows 校验），前后端单一数据源，按钮所见即校验所得；非法转移仍被 400 `WMS_INVALID_TRANSITION` 兜底（两窗口间的配置变化）。
- **影响报告 = 确认界面的核心**（§7.3）：报告条目直出（后端已生成中文 description），前端只负责分级着色与排版——不在前端重新计算 diff（单一真相：报告所见即应用所得由后端新鲜度检查保证，前端不掺和）。
- **提议确认的乐观刷新**：confirm 成功后 invalidate `['proposals']` + 弹出成功结果（newVersion）；409 时提示重新提议并刷新列表。
- **对话面板的工具过程可见**：invocations 渲染为过程卡（工具名、参数摘要、成败、查询结果表格），让「AI 经工具总线操作」对用户可见可审计（§9.3 透明度）。
- **AI 聊天 = SSE 流式 + 会话化（M12）**：ChatProvider（App 级 context，切页不丢对话）消费 `/api/chat/sessions/:id/message` 的 SSE 流，事件归约到 turn——工具卡先落「执行中」、tool-result 回填终态、助手文本逐 delta 增长；ui.ask 挂起渲染 AskCard（回答走 answer 端点，终态沿原流回填）；多轮历史由 server 会话持有（见 @one/server「AI 会话与 ui.ask」）。
- **跳转后置动作（M12 步骤4）**：成功的工具卡带「去对应管理页」按钮（profile.propose → 配置确认；SKU/单据/库存操作 → 对应页，携单号或 SKU 过滤）。经 app-nav 的 `navigate(page, filter?)` 跳转——目标页挂载时 `takeInitialFilter` 一次性消费预填过滤框（库存页按编码/名称、单据页按单号）；`inventory.query` 平铺/全量清单形态不出按钮（结果已在卡内成表，无单一落点）。
- **效期看板 = 后端算好、前端纯展示（M14）**：`useExpiryBoard()` 消费 `GET /api/inventory/expiry` 的 `{ today, rows }`——daysLeft/level 由 server 算（与 M13 拦截同界：今天到期 = 临期未过期），页面只做三件事：五层统计卡（reduce 计数 + 语义色）、着色表格（分层 Tag、剩余天数分形渲染——负数「已过期 N 天」/ 0「今天到期」/ null 弱化 —、库位清单合并）、层下拉 + 关键词过滤（编码/名称/批次）。数据新鲜度靠 mutation 失效联动：adjust 与单据流转的 onSuccess 一并 invalidate `['expiry-board']`（桶余量变化 → 聚合与分层随之刷新）。让 M11（效期登记）/ M12（批次分配）/ M13（过期拦截）沉淀的效期数据在管理界面可见——「AI 经 wms.inventory.expiring 工具查询」之外的常驻用户面。
- **设置页 = 触发器 + 状态显示器，不引入新服务端状态**（M8）：五个分区全部消费既有端点——节点名片（GET /api/sync/hello：nodeId/workspaceId/profileVersion/eventCount）、局域网同步（peers 表单 → POST /api/sync/run）、云中继（URL 表单 → POST /api/relay/run，回合结果直出）、密钥（GET /api/keys 状态 + POST /api/keys 生成（**明文只展示一次**）+ /export 导出 + /import 导入，409 KEY_EXISTS 按 code 提示）、迁移（/export 下载 JSON 文件 + /import 上传，accepted/skipped/missingManifests 直出）。peers 与 relay URL 不持久化在前端——每次随请求体发送，服务端 env（ONE_SYNC_PEERS / ONE_RELAY_URL）仍是唯一持久位；密钥生成后的明文仅一次性展示（指纹才是常态展示物，M7 安全边界的前端配合）。
- **v2+ 接缝（本次不做）**：编辑 SKU（改名/改扩展字段）、库存流水展示页、扫码界面、冲突队列页。

## 测试策略（app）——jsdom + @testing-library/react

- **组件级**：ImpactReportView（severity 分色、items 直出）、ProposalDetail（确认按钮 → mock client 成功/409 两分支）、ToolInvocationCard（过程三态、查询结果三形态表格、ui.ask 挂起/回填、后置动作按钮——失败/执行中/无 onNavigate 不出按钮）、SkuFormModal（type→控件映射、json 校验）。
- **页面 smoke**：ChatPage 走真实 ChatProvider + mock streamChatMessage（SSE 事件脚本化：工具卡回填、流式文本、error 落卡、ui.ask 挂起→回答/跳过 gate 时序、propose 后置按钮）；app-nav（navigate 切页、initialFilter 一次性消费）；ProposalsPage 列表 → 详情 → 确认后列表清空；SkusPage **动态列核心机制**（snapshot 含可见 spec + 隐藏 category → 表头有「规格」无「分类」）；OrdersPage / InventoryPage 列表渲染 + 提交 + 过滤框（关键字命中 + AI 跳转预填）；ExpiryPage（M14）mock useExpiryBoard——五层统计卡计数、剩余天数分形渲染（已过期 N 天 / 今天到期 / —）、库位合并、层过滤收敛、关键词过滤与空表；SettingsPage（M8）mock 五组端点——节点名片渲染、同步回合结果、密钥生成（明文一次性展示）与导入 409 提示、迁移导入结果。
- 不测 AntD 内部行为；不断言样式细节（只断语义角色与文本）。
