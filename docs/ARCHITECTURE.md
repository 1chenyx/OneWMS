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
   - 现存单向边：`validate → patch`（校验器在虚拟快照上工作，内聚地调用应用器）、`validate → profile-types`（PATCH_ROOTS 常量）、`schema-validator → errors`、`patch/impact/proposal-store → profile-types|impact`（type-only）、`manifest-validate → manifest-types|schema-validator`（类型与词表常量 + ParameterSchema 结构复用）；
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
- **同步组 = 同 workspaceId**：客户端校验 hello 返回的 workspaceId 与本地一致，不等则拒绝交换（同步组即数据交换边界）。
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
| 端到端加密 | 局域网明文 HTTP | v1 定位可信网段；跨互联网由 VPN 组网承接（Tailscale/WireGuard 虚拟局域网，隧道层加密）——中继与密钥体系已移除（见「迁移导出」章节变更记录） |
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

## 迁移导出（里程碑 7）

> DESIGN §6.4 迁移闭环的 v1 落地：**让事件流离开本机**——一次性全量带走。与同步共用同一批原语（全量事件 + 幂等摄入 + 全量重放）。

> **架构变更记录（移除云中继与工作区密钥）**：M7 原实现的云中继（relay/ 四端点 + VPS 独立进程）与工作区密钥体系（seal/unseal + KeyService + /api/keys）已整体移除。决策依据：跨互联网同步的可达性由 VPN 承接更简（Tailscale/WireGuard 组虚拟局域网后直接走局域网同步，隧道本身加密）；规模化多仓场景的终局形态是服务器模式（锚点节点 + 瘦客户端，属未来演进），中继在两条路径上均无不可替代角色；密钥体系的唯一消费者是中继密文通道，随之失去存在理由。迁移导出因此保持明文形态（本地可信域，与既有定位一致）。

**v1 形态：全量事件包 + 重放**（§1.1「配置包 + 事件重放」、§8.5「迁移和同步是同一个动作的两种节奏」）。

- `MigrationBundle` = `{ kind, bundleVersion, nodeId, workspaceId, profileVersion, eventCount, createdAt, events }`——events 为账本全量、按 (lamport, actor) 全序。**Profile 不单独打包**：快照是事件投影，重放自动恢复；快照引导（§8.6）是部分副本的优化，v1 全量节点不需要（同 M5 决策 2 的裁剪）。
- `exportBundle(workspaceId)`：全量事件 + 元信息；`importBundle(workspaceId, bundle)`：结构校验（kind/bundleVersion/信封合法性）→ **workspaceId 一致性**（迁移 = 同工作区搬家；跨工作区 v1 拒绝并提示）→ 幂等 ingest（重复导入零事件，eventId 查重）。
- **迁移包明文**：迁移包是用户本地文件（可信域——U 盘/网盘人工搬运），v1 不加密、不做口令。
- **manifest 在场性报告**（宿主层组装）：导入后扫描 `module.installed` 事件引用的模块 id，对照本进程 manifest 目录（`listManifests`）；缺失 → 响应报告清单，**不阻塞**——账本是事实全收；缺代码的模块在 manifest 注册前只是「已安装记录」，不提供运行时行为。v1 无插件仓库/无签名（§10 冻结），「按 id+version 拉代码包」留待插件市场（未来生长点）。

### 端点契约（server，M7）

- 迁移：`GET /api/migration/export` → MigrationBundle；`POST /api/migration/import` body `{ bundle }` → `{ accepted, skipped, replayed, missingManifests }`。
- 错误映射：`MIGRATION_ERROR` → 400。

### 组件协作（谁调谁）

```
server/routes/migration.ts   → core.migration（exportBundle/importBundle）
                               + core.exposeModuleRegistry().listManifests（在场性报告）
                               + ws.replayAll()
```

## 测试策略

- **服务层测试**（oplog.test.ts / fields.test.ts / tools.test.ts / profile.test.ts + patch/validate/impact 纯函数测试）：经 facade 走公共 API，验证内核行为契约；纯函数（patch/校验/报告）直接单测。
- **模块系统测试**（modules.test.ts）：manifest 校验纯函数直测（合法全景 + 逐项非法）；install 全流程（字段/modules 段/settings 默认值/审计事件/贡献合并）；幂等（同版本重装零事件）；依赖缺失/slot 冲突/状态冲突/贡献目标不存在/requires 缺失/异版本/工具不在场逐项拒绝；uninstall 逆操作（字段移交与隐藏、workflows 摘除、modules 移除）；replay 重建一致；**老库收敛**（先手写种子再 install——字段 DO NOTHING + base 守卫 + modules 登记，行为与 M4 库升级一致）。
- **同步测试**（sync.test.ts）：computePullPlan 纯函数直测（含「水位持平 + 指纹不同 → 全量区间」）；双 OneCore 实例互拉收敛（水位/计数/全序序列一致、幂等重拉零 accepted、分页、profileVersion 随握手可见、ingest 后 replay 投影一致）；actor 节点唯一防线（双实例同 actor 落账 → UNIQUE 约束拒绝摄入）。
- **迁移测试**（migration.test.ts）：exportBundle 元信息（nodeId/profileVersion/eventCount/全序）；importBundle 全量恢复（重放后注册表 + profile_state 投影与源一致）；幂等（重复导入 accepted=0）；workspaceId 不一致拒绝；坏 bundle（kind/bundleVersion/非数组 events）拒绝；空账本导出导入（元信息照常、零事件）。
- **集成测试**（workspace.test.ts）：多工作区并存、replay 重建（含 profile_state）、端到端链路。
- **稳定性守则**：公共 API 变更 = index.ts 导出变更 = 必须同步更新 DESIGN.md 对应章节。

## 未来生长点（与 DESIGN.md 对齐）

| 生长点 | 落点 | 备注 |
|---|---|---|
| 同步投影增量追账（M5 遗留优化） | sync/ + 各投影持有方 | 复合游标 (lamport,actor) + registry.* 增量投影路径，替代回合后全量重放；量级变大时再做 |
| 同步传输增强 | server/sync/ | mDNS 发现、WebSocket 推送（§8.8 消息目录）；跨互联网 = VPN 组网（v1 使用纪律）或锚点节点公网暴露（需 TLS+鉴权，随服务器模式演进） |
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
| 前端批次维度展示 | app + server/routes/wms.ts | 临期看板已随 M14 落地（GET /api/inventory/expiry + ExpiryPage 五层预警），M15 起看板行可展开库位×余量明细；生长点：库存页分桶明细界面与移库操作面板（/api/inventory 仍按 SKU 求和） |
| 效期看板进阶 | server/routes/wms.ts + app | M15 已落地：分层阈值进 core.wms settings（expiryCriticalDays / expiryWarningDays，readWmsSettings 同源读取 + 联动兜底 7/30，慢通道改值即时生效）+ 行展开库位明细 + AI 临期查询后跳转看板（单 SKU 结果预填过滤）；生长点：按层导出 CSV、看板内嵌阈值编辑表单（当前改值走慢通道提议确认） |
| AI 模块目录上下文（§6.4 闭环 ② 完整版） | ai/system-prompt.ts + modules 目录 | 已装模块的 description/settings.schema/tools 注入 System Prompt，支撑「自然语言 ↔ 模块匹配」；第二个模块出现时做 |
| 外部插件包与运行时沙箱 | modules/ + manifest 的 entry | 动态 import / WASM（Extism）、signature 校验链、capabilities 运行时供给；v1 模块全部是编译期静态装载 |
| 模块运行时管理端点 | server/routes | GET /api/modules、install/uninstall 端点（当前唯一模块 core.wms 由领域包装配期自动安装，无运行时装卸消费方） |
| 权限中间件 | ToolsView.invoke 的 handler 前插一层 | ctx.actor 已备（§10 预留） |
| 预演关增强 | profile/impact.ts | 字段隐藏时统计受影响业务行数（需领域消费方提供计数回调） |
| AI 工具集分级（AgentScope） | M16 已以更强形态落地：AgentDefinition（见 @one/ai「多实例助手」）——per-agent 工具授权清单取代三档枚举 | 详见下文 |

### AI 工具集分级（AgentScope）——M16 已演进为多实例助手

**原设想**（v2 接缝）：`createWmsAgent` 加 scope 参数，按入口裁剪三档工具集（readonly / standard / proposable），actor 携带等级。**M16 落地了更强形态**：助手定义化（AgentDefinition）+ Profile 配置层存储（core.ai settings.agents，慢通道可写）+ 每条消息现场装配——内置三件套 general/readonly/config 即原三档（且 general 移除了 profile.propose：「改配置」成为独立助手而非默认权限），自定义助手可按需勾选工具。actor = `ai:{agentId}@{nodeId}`（助手为单位可审计）。**仍预留的生长点**：多 AI 协作（`tools` 元素的 `agent:<id>` 委托形态——v1 装配抛错）、按角色分配助手（`allowedRoles` 字段 v1 仅透传，消费方是 server/routes/agents.ts 的权限收敛点与前端切换器过滤）。

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
│  views/inventory-view.ts   库存流水 + 汇总投影 + 冻结  │
│                            投影 + 查询（M19）          │
│  views/stocktake-view.ts   盘点投影 + 账面快照 + 查询  │
│  tools/wms-tools.ts        二十个 wms.* 工具（护栏在此）│
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
- **replayAll（M5）**：全量重建「内核投影（facade.replay：注册表 + profile_state）+ 领域投影（wms 九表）」——同步回合与「修复同步」按钮的统一落点（§8.5 全量为真）。
- **manifest 驱动装配（M6）**：core.wms 是第一个模块——attach 期从工具定义派生 manifest.tools（声明面与事实面零重复）并 registerManifest；工作区构造期 `modules.install()` 完成受管种子（详见 @one/core「模块系统」章节的 wms 迁移小节）。
- **单据 → 库存联动（M9）**：见下节。
- **库位管理（M10）**：见下文专节。
- **批次/效期管理（M11）**：见下文专节。
- **批次分配策略（M12）**：见下文专节。
- **分配策略与过期拦截配置化（M13）**：见下文专节。
- **盘点单执行（业务补齐里程碑 17）**：见下文专节。
- **条码管理（业务补齐里程碑 18）**：见下文专节。
- **冻结管理（业务补齐里程碑 19）**：见下文专节。
- **安全库存与低库存预警（业务补齐里程碑 20）**：见下文专节。

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

## 效期看板阈值配置化（里程碑 15）

> M14 的效期看板分层阈值（critical ≤7 / warning ≤30 天）是 server 展示常量。M15 把两键接进 **core.wms 模块设置**：`expiryCriticalDays`（integer，default 7）+ `expiryWarningDays`（default 30）——与 M13 两键同管道（manifest 声明 → install 种子 → 慢通道改值 → 读取方兜底），缺省值 = M14 现状，**未配置 = 零行为变化**。

- **读取单一真相（D1）**：M13 的模块私有 `readSettings` 升为包级 API `readWmsSettings`（index.ts 导出），server 端点与 AI 工具层消费**同一实现**——阈值语义在两处消费方之间不可能漂移。工具层自身的分配/拦截逻辑不读这两键（与阈值无关）。
- **联动兜底（D2）**：阈值是**一对**语义（critical 必须 ≥1 且严格小于 warning）——任一键缺失/脏值/次序不合法，两键**一起**回落缺省 7/30。宁可整体回落，不出「warning < critical」的交叉边界（分层语义成立的前提）。
- **边界不动（D3）**：`wms.inventory.expiring` 工具的 days 参数（AI 查询参数）与 M13 过期拦截判定（< 今天）均不看这两键——它们是**看板展示阈值**，不是业务拦截参数。
- **版本不 bump（与 M13 同决策）**：老库（0.1.0 已装，install 幂等短路）不补种子，靠 readWmsSettings 兜底。

## 盘点单执行（业务补齐里程碑 17）

> 成熟仓库业务缺口补齐的第一项：盘点单从创建（账面快照）→ 实盘录入 → 关单差异收敛的全流程闭环。**独立实体而非单据方向**：盘点不是出入库单据，不进 Profile workflows——生命周期词汇固定 `created → closed / canceled`（盘点生命周期不因配置而变）。三个新事件 + 两张新投影表 + 五个新工具；差异调整复用既有 `wms.inventory.adjusted`（与单据联动同一条流水通道）。注：业务补齐里程碑与 UI 里程碑编号空间独立（本节的 17 与 AI 模型配置页的 M17 仅编号巧合，后者见 @one/server 章节）。

- **三事件（D1）**：`wms.stocktake.created`（locationIds: string[] | null——null = 全场盘点）/ `wms.stocktake.counted`（实盘录入）/ `wms.stocktake.state_changed`（from→to 终态收敛）。payload 禁冗余快照铁律不破例——事件只带身份与实盘数。
- **账面快照不进事件（D2）**：期望行由 StocktakeView 在应用 created 事件时查 `wms_inventory` 现值生成（范围内余量 > 0 的桶——零余量桶无盘点意义，货架上真有货而账面为零走盘盈补行）；counted 遇账面无行（创建后入库 / 当时账面为零）补行，expected 取应用时点现值。全序重放保证同一位置的库存状态与原运行时一致——**快照可逐字节重建**（测试验证，「投影可丢」性质的再次兑现）。
- **构造序保证快照时点**：同一追账循环里 inventory 先应用、stocktake 后应用——created 快照永远看到本事件之前全部库存流水的效果。
- **行 id 四段派生（D3）**：`stocktakeId:skuId:locationId:batchNo`——同单同桶唯一（重放幂等键 + 同桶重盘覆盖键，ON CONFLICT 只更新 counted_qty，后到者胜）。
- **差异按关单时点收敛（D4）**：delta = countedQty − 关单时点现值（非创建快照——盘点期间发生的出入库以关单账面为准，差异如实反映两次动作的净效果）；跳过零差行（不落流水）；盘盈补库存、盘亏扣减（扣减后余量 = 实盘数，恒不为负）；close 用 runAtomic 包状态事件 + 逐桶调整事件（同生共死，M9 机制复用）；调整流水 reason=`stocktake:{单号}`——审计可追溯。
- **守卫链（D5）**：create 库位范围解析去重；count 录入库位不在范围 → `WMS_STOCKTAKE_SCOPE_VIOLATION`；未盘完关单 → `WMS_STOCKTAKE_LINES_UNCOUNTED`（不需要的行录 0）；终态单拒一切操作 → `WMS_STOCKTAKE_NOT_OPEN`；cancel 零调整纯终态收敛。
- **混合版本同步兼容**：旧节点收到盘点事件被 `isWmsEventType` 过滤忽略（事件目录不含盘点）——账本不炸不挡同步；新节点两表 IF NOT EXISTS 幂等建表，随构造期 sync() 从账本重建，无需老库收敛检测（新表无旧结构问题）。

## 条码管理（业务补齐里程碑 18）

> 成熟仓库业务缺口补齐的第二项：SKU 条码——扫码枪识读的物理标识。**主数据属性而非库存维度**：barcode 是 wms_sku 的一列（同库唯一），不新增实体表、不新增事件类型——既有 `wms.sku.created` / `wms.sku.updated` payload 加可选 `barcode` 字段（与 M11 批次字段同一「可选扩展」手法，旧节点同步消费 graceful degrade）。一个新读工具 + 一条新 UNIQUE 约束 + 前端扫码输入组件。

- **同库唯一（D1）**：`UNIQUE (workspace_id, barcode)`——扫码识读不允许二义（一码必须解析出唯一 SKU）。SQLite 多行 NULL 不冲突——不设条码的 SKU 互不影响；工具层校验先于落事件（占用他人条码 → `WMS_SKU_BARCODE_EXISTS`，消息带占用者编码；声明自己的既有条码放行）。不约束格式（EAN-13 / Code128 / 自编码皆可）——唯一性才是业务不变量。
- **可选语义（D2）**：`sku.create` 条码可选；`sku.update` 显式传才改（COALESCE 语义，与 name/extData 同一 LWW 家族）、未传保持不变；两端 trim 规整（扫码枪可能带前缀/后缀符），空白串拒绝（TOOL_REJECTED）——不产生 `''` 假条码。
- **resolve 是纯读（D3）**：`wms.sku.resolve`（barcode → skuId/skuCode/name/barcode），幂等零事件，未登记条码抛 `WMS_SKU_NOT_FOUND`——「AI 组装」先经本工具把扫码值换算成编码再进单据/盘点工具，与「先查后写」的护栏纪律同构。
- **老库收敛（第二道检测）**：`wms_sku` 缺 `barcode` 列（= ≤M17 的库）→ **八张投影整组 DROP** 重建（与 M11 检测同一清单、同一「投影可丢」逻辑；两道检测覆盖三条升级路径）。老事件无条码字段 → 投影 barcode 收敛 NULL。
- **检索通道**：server `GET /api/skus` 加 `barcode=`（精确——扫码枪入口）与 `q=`（编码/名称/条码三字段 LIKE——页面搜索框）查询参数，内存过滤（组装不碰 SQL 惯例）。
- **扫码前端**：`ScanInput` 组件（USB 扫码枪 = 键盘设备——聚焦输入框收字符 + 回车触发；挂载自动聚焦、扫后清空续扫、条码优先编码兜底的匹配策略），接入三处——建单表单（扫一件 = 行追加 / 数量 +1）、库存页（扫 = 选中 SKU 开调整弹窗，无库存行照开余量 0）、盘点明细（扫 = 过滤定位该 SKU 的桶行，多桶全列供逐桶录数）。

## 冻结管理（业务补齐里程碑 19）

> 成熟仓库业务缺口补齐的第三项：库存冻结——把数量标记为不可出库（质检隔离 / 客订预留 / 促销占位）。**可用量占用而非库存维度**：冻结不改物理量、不落库存流水（wms_inventory_ledger 只记物理增减），真相在新事件对 `wms.inventory.held` / `wms.inventory.released`，投影是新表 `wms_inventory_hold`（活动冻结行——释放即删行，历史在事件）。两个新事件 + 一张新表 + 三个新工具 + 出库拦截。

- **SKU 级粒度（D1）**：冻结量按 SKU 汇总（跨库位跨批次合计），可用量 = `totalOf(sku) − heldOf(sku)`。不放库位/批次维度——冻结语义是「这个 SKU 的 N 个不能用」，桶级冻结是生长点。工具层挡「已冻结合计 + 本次 > 账面余量」（`WMS_HOLD_EXCEEDS_STOCK` fail-fast）。
- **只拦单据出库（D2，对齐 M13 过期拦截先例）**：出库单进 picking（预检）与 shipped（扣减硬守卫）时，同 SKU 多行**先聚合再校验**（逐行各自通过而合计超可用也拒）→ `WMS_STOCK_HELD`（消息带 余量/冻结/可用 三数）。库存调整（负 delta）/移库/盘点关单差异收敛**不拦**——它们是物理修正通道（盘亏是物理事实，冻结挡不住货架少货）；极端路径下可用量可为负（出库全拦直到释放），前端可用量负数红色展示。
- **release 整笔按 holdId（D3）**：释放 = 按 holdId 删一行 + 一条 released 事件（reason 可选，如 质检合格放行）；数量不进 released payload——数量在 held 事件里，事件不冗余。重复释放 / 未知 id → `WMS_HOLD_NOT_FOUND`。
- **投影幂等（D4）**：held INSERT OR IGNORE（主键 holdId）、released DELETE（天然 no-op 幂等）——乱序/重复重放自然收敛；replay() 清 hold 表全量重建。**迁移零重建**：新表纯新增（无列变更），IF NOT EXISTS 即收敛老库——dropAll 清单收录它（未来整组重建时一起丢）。
- **工具三件（D5）**：`wms.inventory.hold`（冻结，write）、`wms.inventory.release`（释放，write——先经查询拿 holdId）、`wms.inventory.holds`（活动冻结清单，read 纯读零事件，skuCode 可选过滤）；`wms.inventory.query` 分组形态扩 `held` / `available` 字段（AI 查库存直接看到冻结）。
- **HTTP 契约（D6）**：`GET /api/inventory` 行扩冻结三件套（quantity/held/available——与拦截同一口径）；`GET /api/holds?skuCode=`（读直查投影，未知编码空清单）、`POST /api/holds` → wms.inventory.hold、`POST /api/holds/:id/release` → wms.inventory.release（写全走工具通道）。
- **前端（D7）**：库存页加冻结量/可用量两列（冻结 >0 橙色、可用 <0 红色）+ 行内「冻结」按钮开 HoldModal——上半该 SKU 活动冻结清单（数量/原因/时间 + 逐笔 Popconfirm 释放），下半追加冻结表单（数量 + 原因）。
- **混合版本同步兼容**：旧节点收到 held/released 事件被 `isWmsEventType` 过滤忽略（事件目录不含冻结）——账本不炸不挡同步（与 M17 同构）；新节点建表 IF NOT EXISTS 幂等，无需老库收敛检测。

## 安全库存与低库存预警（业务补齐里程碑 20）

> 成熟仓库业务缺口补齐的第四项：**补货闭环的触发器**——SKU 声明安全库存（reorderPoint），可用量跌破阈值即预警。**主数据属性而非库存维度**（与 M18 条码同一手法）：reorderPoint 是 wms_sku 的一列（0 = 不预警），复用既有 `wms.sku.created` / `wms.sku.updated` payload 加可选字段——零新事件类型；一个新纯读工具 + 老库第三道检测 + 前端列与过滤。

- **预警口径 = 可用量（D1）**：低库存判定 `reorderPoint > 0 && available < reorderPoint`，其中 available = 全库位合计余量 − 冻结合计（M19 同一口径）——**冻结会吃掉可用量触发预警**（客订预留走冻结，货架明明有货也提示补货是错的：可售量才是补货依据）。
- **COALESCE 语义（D2）**：create 可选（缺省 0）；update 显式传才改，传 0 = 关闭该 SKU 的预警（与 barcode/name/extData 同一 LWW 家族）；schema 挡负数（minimum 0）。
- **lowstock 是纯读（D3）**：`wms.inventory.lowstock`（skuCode 可选过滤）列出全部预警项——每行含 total/held/available/reorderPoint/shortage（缺口 = 阈值 − 可用），按缺口降序（最缺的在前）。补货建议的入口数据源（AI：用户问「该补什么货」先调本工具）；幂等零事件。
- **老库收敛（第三道检测）**：`wms_sku` 缺 `reorder_point` 列（= ≤M19 的库）→ **九张投影整组 DROP** 重建（三道检测覆盖五条升级路径）；重建从事件恢复——事件里有值就不是收敛 0。
- **HTTP 契约（D4）**：`GET /api/skus` 行自动透传 reorderPoint（SkuRecord 直查）；`GET /api/inventory` 行附 reorderPoint（联 SKU 主数据——前端判定 low 用，判定式与工具同口径）。
- **前端（D5）**：SKU 页固定列「安全库存」（0 显 `-`）+ 新建表单输入（>0 才提交）；库存页「安全库存」列 + 可用量低于阈值（或为负）标红加粗 + 「只看低库存」Checkbox 过滤。

## P0 业务模块补齐（业务补齐里程碑 21）

> 对标成熟 WMS（GreaterWMS）覆盖缺口的四件套：上架（putaway）/ 往来单位（partner）/ 拣货单（picking）/ 运营看板（dashboard），外加「流程可配置」的关键补全——**when 条件运行时求值**。

- **when 条件运行时求值（流程配置的最后一环）**：`evalWhenCondition(when, modules)`（core 导出）——正则 `^(!?)(module\.{id})\.enabled$`，undefined/空串 → true（无条件语义），无法识别 → false（保守）。此前 when 只在 patch 时静态校验、运行时无人消费；现在 order-tools / picking close / OrdersPage 三处求值——**配置即权威**，停用模块 = 其贡献的转移运行时不可达（转移定义保留，patch 合法性不受影响）。app 不允许 runtime import @one/core（type-only 护栏），前端有本地等价实现。
- **上架 putaway（零语义破坏设计）**：`module.putaway` manifest contributes inbound——states 增 `putaway`（已上架），transitions 增 `received→putaway`（when=`module.putaway.enabled`）与 `putaway→done`（无条件——停用后滞留 putaway 的单仍可收尾）。收货落账不变；putaway 是 received 后的可选确认+归位步骤：无 targets = 纯确认（只落 order.state_changed）；带 targets = 每行一对 ± 流水（reason=`putaway:{orderNo}`，批次/效期保留）。**停用即回到「收货即完成」老流程**（received→done 直达不受影响），历史数据不动。工具 partition：putaway 工具注册上总线（AI/HTTP 可用）但不进 core.wms 的 tools 数组——由 module.putaway manifest 单独声明（启停与工具面一致）。装配期 `#installPutawayModule()` try/catch 降级——老库流程自定义冲突时 warn 不阻塞。
- **往来单位 partner（统一实体）**：kind 字段区分 supplier/customer（一码一档，不做两张表）；编辑只改名称/联系人/电话/地址/备注，kind 不可变。订单建单可选关联 partnerCode（方向过滤 kind——入库单选供应商、出库单选客户）。老库第四道检测：`wms_order` 缺 partner_id 列 → 十二张投影整组 DROP 重建。
- **拣货单 picking（固定生命周期 + 关单统一扣减）**：生命周期 `created → closed / canceled` 不进 Profile workflows（盘点先例——拣货是作业实体不是单据方向）；订单侧流程校验仍走 outbound workflow（when 过滤）。create：多选 picking 态出库单 → 逐单校验 → 建议桶（显式批次→该桶；DEFAULT 虚拟批次且非 strict → allocateFromBuckets 首个 part）；pick：定位行（orderNo+skuCode+suggestedBatchNo），pickedQty 累计后到者胜，可改实拣桶；**close = 全行拣满 + 逐单 assertTransition(→shipped, when 过滤) + assertOutboundBuckets(实拣桶) + runAtomic**（order.state_changed + 逐桶 inventory.adjusted（reason=`picking:{no}`）+ picking.state_changed 同生共死）；cancel 仅 open 可、审计保留。与直接 transition 的差别：先拣后扣（作业过程库存可见）、实拣桶可为异于建议桶。
- **守卫/分配提取（共用纯计算）**：`state/outbound-guards.ts`（过期拦截 M13 / 逐桶余量 M11 / SKU 冻结聚合 M19）从 order-tools 提取，order-tools 与 picking close 共用；`state/allocation.ts`（fefo 效期升序无期殿后 / fifo firstSeenAt 排序+装载）从 batch-allocation 提取，建单展开与拣货建议桶共用。行为不变由存量测试全绿兜底。
- **运营看板 dashboard（五维度独立架构）**：overview（总览卡片）/ flow-trend（出入库日流量，**排除 reason LIKE 'putaway:%'**——移库 ± 对不虚增流量）/ locations（库位 Top 8 + 其他）/ orders（单据统计）/ alerts（效期三级 + 冻结 + 负余量预警）——各自独立查询函数（wms/queries/dashboard-queries.ts）+ 独立端点（`/api/dashboard/*`）+ 独立 queryKey（`['dashboard', 维度]`）。**新增维度只加函数+路由+hook，不动既有**；写操作失效 `['dashboard']` 前缀匹配全失效。前端 Antd 原生 + 自写 SVG 迷你趋势图（不引图表依赖）。
- **设置页「流程与模块」Tab**：业务模块 Switch 启停走慢通道（propose → 影响报告 Modal → 人工 confirm 生效，与 AI 配置提议同一队列）；系统模块只读；流程只读视图含 providedBy 徽标与 when 列。server 增 `POST /api/profile/propose`（人通道 actor=`user:local@{nodeId}`）。

## 模块化种子（M4 手写 → M6 manifest 驱动）

WmsWorkspace 构造期的 `#seedDefaultProfile()` 已被 `modules.install(WMS_MANIFEST)` 替代——种子不再是领域包手写的两段动作，而是走内核受管管线（预检 → 双轨落事件 → 审计事件）：

1. **基础扩展字段**（sku.spec/category/unit）：manifest.fields.provides → registry.provide（轨道 A）。已存在且类型兼容 → DO NOTHING + usedBy 追加（老库 owner 保持 'core'，归属语义自洽）；新库 owner = 'core.wms'。
2. **基础流程骨架**（inbound/outbound，从 ORDER_TRANSITIONS 誊写）：manifest.workflows.base → 逐流程守卫（目标流程不存在才装）→ applyDirect（轨道 B，config.change version+1）。老库已 seedDefaults 过 → base 全部跳过，仅登记 modules 段。
3. **模块登记**：modules['core.wms'] = { enabled, version, settings }——后续文件库重开在 install 幂等短路处返回（同版本已装，零新事件）。

种子事件的 actor 仍带 @nodeId 后缀（M5 通道节点唯一）：install 的 opts.actor = `module:core.wms@{nodeId}`。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `wms.ts` | WmsDomain：attach 建领域表 + 注册工具 + 派生 core.wms manifest（registerManifest，settings 四键：defaultAllocation/blockExpiredOutbound（M13）+ expiryCriticalDays/expiryWarningDays（M15 效期看板阈值））+ workspace 工厂（同 id 缓存实例）；**M21 工具 partition：putaway 工具注册上总线但不进 core.wms 的 tools 数组（由 module.putaway manifest 单独声明）**；WmsWorkspace：五内核视图 + 领域投影（M10 增 locations，业务补齐 17 增 stocktakes、M21 增 partners/pickings——追账循环 inventory 先应用、stocktake 后应用，快照时点恒一致）+ sync/replay/replayAll + runAtomic 多事件原子落账（M9）+ 构造期 modules.install 种子（M6）+ **构造期 #installPutawayModule（M21，try/catch 降级——老库流程自定义冲突 warn 不阻塞）** | 不含业务校验（在工具 handler）、不手写字段/流程种子（manifest 驱动） |
| `views/sku-view.ts` | wms_sku 投影：applyEvent 幂等（id 查重早退，code/barcode 冲突显式炸）+ 查询（byCode/byId/byBarcode——M18 条码解析入口）；updated 的 barcode / reorderPoint 走 COALESCE（显式传才改——M20 安全库存） | 不解释非 wms.sku.* 事件 |
| `views/location-view.ts` | wms_location 投影（M10）：applyEvent 幂等 + byCode/byId/list 查询；DEFAULT 虚拟桶不落本表 | 不解释非 wms.location.* 事件 |
| `views/order-view.ts` | wms_order/order_line 投影：state_changed 的 from 一致性检查（冲突即抛）+ 查询；行 id 按 orderId:skuId:locationId:batchNo 四段派生（M11，重放幂等键） | 不做命令侧校验（那是工具的事） |
| `views/inventory-view.ts` | 流水（event_id 主键幂等，M11 起带批次/效期列）+ 汇总 UPSERT（主键 (workspace, sku, location, batch) 四列；效期 COALESCE 保首个非空）+ **冻结投影（M19：wms_inventory_hold 活动行——held INSERT OR IGNORE / released DELETE 天然幂等，释放即删行历史在事件）** + 查询（quantityOf 缺省查 DEFAULT 桶/DEFAULT 批次——M10 调用点语义等价；totalOf/heldOf SKU 级合计——M19 拦截与可用量口径；listHolds 活动冻结清单；expiryOfBatch 首个非空效期；listExpiring 临期清单；batchesOf 批次桶清单含 firstSeenAt——M12 分配排序数据源，联 ledger MIN(created_at)；**M21 增 dailyFlow（日流量聚合，排除 reason LIKE 'putaway:%'——移库 ± 对不虚增流量）与 quantityByLocation（库位分布）——运营看板数据源**） | 无任何「直接改库存」入口 |
| `views/stocktake-view.ts` | 盘点投影（业务补齐 17）：主表按业务 id 幂等早退 + 行表四段行 id ON CONFLICT 覆盖（同桶重盘后到者胜）；账面快照在应用 created 事件时查库存现值生成（事件禁冗余快照，重放全序保证逐字节重建）、counted 补行 expected 取应用时点现值；byNo/byId/list/lines/stats 查询（stats 供清单进度与 close 守卫） | 不做命令侧校验（范围/未盘完守卫在工具层）、不解释非 wms.stocktake.* 事件、无任何「直接改库存」入口（差异调整走 inventory.adjusted 流水） |
| `views/partner-view.ts` | 往来单位投影（M21）：wms_partner 主表幂等（id 查重早退，code 冲突显式炸）；updated 属性级 COALESCE（显式传才改）；byCode/byId/list（kind/q 过滤在查询层）查询 | 不解释非 wms.partner.* 事件、不做 kind 语义校验（工具层的事） |
| `views/picking-view.ts` | 拣货单投影（M21）：wms_picking / wms_picking_line 两表——主表按业务 id 幂等早退；picked 事件 picked_qty 累计后到者胜（ON CONFLICT 更新）、实拣桶缺省 = 建议桶、picker 改拣时记录实际桶；byNo/byId/list/lines 查询（stats 供 close 守卫——全行拣满判定） | 不做命令侧校验（拣满/订单流程守卫在工具层）、不解释非 wms.picking.* 事件、无任何「直接改库存」入口（扣减走 close 的 inventory.adjusted 流水） |
| `tools/wms-tools.ts` | 二十工具：sku.create/update/resolve（M18 增 resolve：条码 → SKU 幂等读；create/update 带可选 barcode——trim 规整 + assertBarcodeFree 同库唯一校验，占用者即自身放行；M20 起带可选 reorderPoint——update 显式传才改、传 0 关闭预警）、location.create/list、order.create/transition、inventory.adjust/move/query/expiring（M11 增一）+ **hold/release/holds（业务补齐 19：冻结 = held 事件 + 超量拒 WMS_HOLD_EXCEEDS_STOCK；释放 = released 事件按 holdId 整笔、未知/重复拒 WMS_HOLD_NOT_FOUND；holds 活动清单纯读零事件；query 分组形态带 held/available）** + **lowstock（业务补齐 20：低库存预警清单——可用量口径复用 totalOf−heldOf，按缺口降序，纯读零事件）**、stocktake.create/count/close/cancel/query（业务补齐 17 增五）；`def()` 包装器集中处理 handler 参数逆变；transition 从 Profile workflows 取流程定义校验（M8 行为闭环）+ 库存联动发射段 runAtomic 原子包裹（M9，move 双流水同此）；order.create 挡同单同 SKU 同库位同批次重复行（M9 守卫的 M11 精化）；locationCode/batchNo 统一解析护栏（未建库位拒绝、DEFAULT 直通；批次缺省归 DEFAULT、DEFAULT 拒效期）；assertExpiryConsistent 同批次效期一致性（M11，入库 fail-fast / adjust / move 权威校验）；expandAllocatedLines 批次分配（M12：order.create 出库 allocation strict/fifo/fefo——M13 扩加 strict，未指定批次的行按策略拆分为具体批次行，合计不足抛 AllocationInsufficientError）；readWmsSettings 模块设置窄化读取（M13 私有 readSettings，M15 升包级导出——四键：分配/拦截两键 + 效期阈值两键联动兜底 7/30，server 效期看板端点同源消费）+ isExpired 过期判定 + 出库守卫过期拦截（M13：defaultAllocation 全局缺省策略 / blockExpiredOutbound 开关，老库缺键与脏值一律兜底代码缺省）；盘点工具组（业务补齐 17）：create 范围解析去重 + 单号缺省生成（ST-日期-序）、count 范围守卫（范围外录盘拒 WMS_STOCKTAKE_SCOPE_VIOLATION）、close 差异按关单时点现值收敛（delta = 实盘 − 现值，跳过零差行；调整复用 inventory.adjusted，reason=`stocktake:{单号}` 审计可追溯）+ 未盘完拒关 + 状态与调整 runAtomic 原子包裹、cancel 零调整纯终态、query 双形态（单号 → 明细行，缺省 → 单据清单）；出库冻结拦截（业务补齐 19：transition 的 picking/shipped 守卫链尾部按 SKU 聚合校验 total − held ≥ 需求，不足抛 StockHeldError 零事件；adjust/move/盘点修正不拦——对齐 M13 物理修正通道先例）；**M21：transition 守卫段改调 state/outbound-guards 的 assertOutboundBuckets（提取重构，行为不变）+ 转移 when 条件经 evalWhenCondition 运行时求值** | schema 之外不碰总线内部 |
| `tools/partner-tools.ts` | 往来单位工具（M21）：partner.create/update/query——create 声明 kind（supplier/customer，不可改）+ 同库编码唯一；update 只改名称/联系人/电话/地址/备注（kind 语义校验在工具层，拒绝零事件）；建单关联（order.create 的 partnerCode 解析 + 方向 kind 匹配校验） | 不做投影查询组装（queries 层的事） |
| `tools/putaway-tools.ts` | 上架工具（M21）：`wms.order.putaway`——when 过滤断言 received→putaway（module.putaway 停用即拒）；无 targets 纯确认（只落 order.state_changed）；带 targets 每行一对 ± 流水（reason=`putaway:{orderNo}`，批次/效期保留）+ 源桶余量守卫 + runAtomic；**注册上总线但不进 core.wms tools 数组（module.putaway manifest 声明）** | 不改收货落账语义（received 的上架流水不变） |
| `tools/picking-tools.ts` | 拣货五工具（M21）：create（orderNos → 逐单 out+picking 态校验 → 建议桶——显式批次→该桶，DEFAULT 且非 strict→allocateFromBuckets 首个 part）、pick（定位行 orderNo+skuCode+suggestedBatchNo，pickedQty 累计后到者胜，可改实拣桶）、close（全行拣满 + 逐单 assertTransition(→shipped, when 过滤) + assertOutboundBuckets(实拣桶) + runAtomic：order.state_changed + 逐桶 inventory.adjusted（reason=`picking:{no}`）+ picking.state_changed）、cancel（open 才可，审计保留）、query（双形态） | 不直接改库存（close 走流水事件）、不做订单流程配置裁决（outbound workflow + when 是权威） |
| `putaway-manifest.ts` | module.putaway manifest（M21）：contributes inbound——states 增 putaway（已上架）、transitions 增 received→putaway（when=`module.putaway.enabled`）与 putaway→done（无条件）；工具声明 wms.order.putaway | 不创建流程（contributes 只贡献） |
| `events/catalog.ts` | 事件名常量 + payload 类型（M18 起 sku payload 带可选 barcode、M20 起带可选 reorderPoint；M11 起 adjusted/order 行 payload 带可选 batchNo/batchExpiryDate；业务补齐 17 起含盘点三事件 payload——created 携 locationIds: string[]|null（null=全场）、counted 双携带 id 与编码（skuId/skuCode、locationId/locationCode、batchNo、countedQty）、state_changed 携 from/to；业务补齐 19 起含冻结两事件 payload——held 携 holdId/skuId/skuCode/quantity/reason，released 携 holdId/skuId/skuCode/reason?（数量不冗余——在 held 里）；**M21 起含往来单位两事件（created/updated 携 partnerId/partnerCode/kind/name?/contact?/phone?/address?/note?）与拣货三事件（created 携 pickingNo/orderNos/lines 建议桶、picked 携行定位与 pickedQty/实拣桶、state_changed 携 from/to），order payload 增可选 partnerId**）+ isWmsEventType 分发过滤 + DEFAULT_LOCATION_ID / DEFAULT_BATCH_NO 保留词（migrations 插值的单一来源） | 无状态 |
| `state/order-state-machine.ts` | 转移纯函数校验（canTransition/assertTransition/transitionsFrom，M8 起接受调用方传入的 transitions）+ ORDER_TRANSITIONS 种子誊写源（仅供 defaultWorkflows 消费） | 不落库、不读库、不读任何全局配置 |
| `state/inventory-effect.ts` | 单据→库存联动纯策略（M9）：stockEffectOf（received +/shipped -）+ requiresAvailabilityCheck（out+picking 预检）；仅命令侧消费 | 不落库、不读库；投影层不消费（投影不埋业务策略） |
| `state/allocation.ts` | 批次分配纯计算（M21 从 batch-allocation 提取）：allocateFromBuckets（fefo 效期升序无期殿后 / fifo firstSeenAt）——建单展开（expandAllocatedLines）与拣货建议桶共用 | 不落库、不读库、不含策略读取（策略值由调用方传入） |
| `state/outbound-guards.ts` | 出库守卫聚合（M21 从 order-tools 提取）：assertOutboundBuckets——过期拦截（M13）+ 逐桶余量（M11）+ SKU 冻结聚合（M19，同 SKU 多行先聚合再校验）；order-tools 的 transition 与 picking close 共用 | 不落事件（守卫拒绝 = 零事件）、不读流程配置 |
| `queries/picking-queries.ts` | 拣货单查询组装（M21）：withPickingLines/listPickingsWithLines——行联查补 skuCode/skuName/建议与实拣库位编码 | 不做业务校验、不碰工具总线 |
| `queries/dashboard-queries.ts` | 运营看板五维度查询（M21）：getDashboardOverview / getFlowTrend（排除 putaway 移库流水）/ getLocationDistribution（Top 8 + 其他）/ getOrderStats / getAlertSummary（效期三级 + 冻结 + 负余量）——各自独立函数，新维度只加函数不动既有 | 不做写操作、不含展示层逻辑（前端的事） |
| `db/migrations.ts` | 十二张 wms_ 表（M10 增 wms_location、M11 全面带批次列、业务补齐 17 增 wms_stocktake / wms_stocktake_line、18 给 wms_sku 加 barcode 列 + UNIQUE(workspace_id, barcode)——多 NULL 不冲突、19 增 wms_inventory_hold 活动冻结表——纯新增无列变更，IF NOT EXISTS 即收敛老库零重建、20 给 wms_sku 加 reorder_point 列 DEFAULT 0、**M21 增 wms_partner / wms_picking / wms_picking_line 三表 + wms_order 加 partner_id 列**），IF NOT EXISTS 幂等建表 + 老库检测四道（ledger 缺 batch_no / wms_sku 缺 barcode / wms_sku 缺 reorder_point / **wms_order 缺 partner_id（M21）** → 十二张投影整组 DROP 重建——M9/M10、≤M17、≤M19、≤M20 老库全覆盖） | 唯一允许领域 `CREATE TABLE` 的文件 |
| `errors.ts` | 三十六个领域错误（code 前缀 WMS_，含 M8 的 WMS_WORKFLOW_NOT_FOUND、M10 的 WMS_LOCATION_EXISTS / WMS_LOCATION_NOT_FOUND、M11 的 WMS_BATCH_EXPIRY_MISMATCH、M12 的 WMS_ALLOCATION_INSUFFICIENT、M13 的 WMS_BATCH_EXPIRED、业务补齐 17 的 WMS_STOCKTAKE_NOT_FOUND / WMS_STOCKTAKE_EXISTS / WMS_STOCKTAKE_NOT_OPEN / WMS_STOCKTAKE_LINES_UNCOUNTED / WMS_STOCKTAKE_SCOPE_VIOLATION、18 的 WMS_SKU_BARCODE_EXISTS、19 的 WMS_STOCK_HELD / WMS_HOLD_EXCEEDS_STOCK / WMS_HOLD_NOT_FOUND、**M21 的 WMS_PARTNER_EXISTS / WMS_PARTNER_NOT_FOUND / WMS_PARTNER_KIND_MISMATCH / WMS_PUTAWAY_ONLY_INBOUND / WMS_PUTAWAY_LINE_NOT_FOUND / WMS_PUTAWAY_SOURCE_SHORT / WMS_PICKING_NOT_FOUND / WMS_PICKING_EXISTS / WMS_PICKING_NOT_OPEN / WMS_PICKING_INCOMPLETE / WMS_PICKING_OVER_PICK / WMS_PICKING_ORDER_STATE / WMS_PICKING_LINE_NOT_FOUND / WMS_PICKING_NO_ORDERS**），继承 CoreError | 无状态 |

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
- **分配/拦截设置（M13）**：allocation-settings.test.ts——新库种子四键缺省（M15 起含效期阈值 7/30）/ 老库空 settings（remove 模拟）兜底 strict / 脏值兜底（非法策略值回落 strict、非 true 回落 false）/ 全局 fefo 不传参按 fefo 拆行 / 参数 strict·fifo 覆盖全局 / 全局策略对入库单无感 / 慢通道改值即时生效 / 拦截全家桶（显式过期批次 picking 拒 WMS_BATCH_EXPIRED 零事件、今天到期边界可出、fefo 分配跳过过期桶、全过滤凑不齐走 WMS_ALLOCATION_INSUFFICIENT、picking 后开启拦截 shipped 仍拒且库存不动、缺省 false 过期照常出的 M12 回归、adjust/move 不拦）。阈值两键的行为级验证（慢通道改阈值分层变化 / 脏值与次序不合法联动回落）在 server 的 wms-routes.test.ts（端点消费同一 readWmsSettings）。
- **盘点单（业务补齐 17）**：stocktake.test.ts——账面快照确定性（created 快照 = 范围内余量>0 桶 + replay 后逐字节一致）/ 同桶重盘后到者胜 / 盘盈补行（范围外账面为零的桶）/ 范围外录盘拒 / 负实盘数 schema 拒 / 未盘完拒关 / 差异按关单时点收敛（盘点期间库存有动 → delta 按关单账面）+ 调整流水 reason 可追溯 / cancel 零调整纯终态 / 文件库重开重建 / query 双形态（单号 → 明细，缺省 → 清单）。
- **条码管理（M18）**：sku.test.ts——创建带码（trim 规整）/ 同库唯一（他人占用拒且零事件、update 抢码同拒）/ 多 NULL 共存 / update 显式传才改（未传保持、重复声明自码放行）/ 空白条码 TOOL_REJECTED / resolve 幂等读与未登记码 SkuNotFoundError / replay 后条码保留 / **老库收敛**（文件库跑流量 → 裸 SQL 整表重建为 M17 无码形态 → 重开断言八表整组 DROP 重建、老 SKU 条码 NULL、收敛后条码工具照常可用）。
- **冻结管理（业务补齐 19）**：hold.test.ts——hold 基础链路（held/available 返回值、恰一事件、不落库存流水）/ 多笔累加与跨 SKU 隔离 / 超量拒零事件（含冻到全额边界）/ 零库存拒与非正数量 schema 拒 / release 整笔解除 + 重复释放 WMS_HOLD_NOT_FOUND + 释放原因落事件 / holds 全量与过滤纯读零事件 / **出库拦截全家桶**（picking 预检拒且释放后同单放行、shipped 同拦、可用恰等需求边界放行、同 SKU 多行聚合拦截——逐桶各自过而合计超可用也拒、adjust/move 物理通道不拦）/ query 分组 held/available / replay 后冻结投影重建（事件审计 held×2 + released×1）。
- **安全库存（业务补齐 20）**：sku.test.ts——create 带 reorderPoint（缺省 0）/ update 显式传才改 + 传 0 关闭 / 负数 schema 拒 / lowstock 预警清单（缺口降序、0 不参与、充足不列、skuCode 过滤、纯读零事件）/ **冻结吃可用量触发预警**（余量充足但冻结后可用跌破阈值；补货解除）/ replay 重建保留 / **老库收敛**（文件库跑流量 → 裸 SQL 改表为 M19 形态（有 barcode 无 reorder_point）→ 重开断言第三道检测整组重建、事件携带值完整恢复）。
- **P0 业务模块（业务补齐 21）**：partner.test.ts——CRUD / kind 语义（不可改、方向过滤）/ 订单关联 / 拒绝零事件 / replay / **老库收敛**（裸 SQL 把 wms_order 重建为无 partner_id 形态 → 第四道检测整组重建，partnerId 完整恢复）；putaway.test.ts——模块安装与停用恢复（applyPatch 停用 → received→done 老流程原样）/ 纯确认 / 归位流水（± 对、批次效期保留）/ 守卫拒绝 / replay；picking.test.ts——建单建议桶 / 实拣与改拣 / 拣满校验 / close 统一扣减（订单自动推进 shipped + 实拣桶硬校验）/ cancel 审计保留 / replay / **when 联动**（转移挂 when + 停用模块 → close 被拒）；dashboard-queries.test.ts——五维度口径（总览计数、流量排除 putaway 移库、库位 Top 8 + 其他、单据统计、预警三级）；core when.test.ts——evalWhenCondition 求值语义（undefined/空串 → true、无法识别 → false、取反）。
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
│  agent-defs.ts         Agent 定义契约 + 内置三件套 +  │
│                        core.ai 模块 manifest（M16）   │
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
- **审计绑定**：`createAgentFromDef` 把 actor 固定为 `ai:{助手id}`（M16 起——助手 id 替代模型名，「谁干的」以助手为单位可审计）——AI 经工具总线的每次操作都落 oplog（`oplog.actor` 即审计日志）。
- **多实例助手（M16，「使用 AI」与「配置 AI」分离）**：`AgentDefinition = { id, name, description, systemPrompt, tools, model?, allowedRoles? }` 存 core.ai 模块 settings.agents（Profile 配置层，改动走慢通道 propose → confirm），`readAgentDefs` 读配置面 + 脏面窄化，未配置/清空/全非法回退内置三件套（general=全量−profile.propose / readonly=仅 read / config=read+propose——工具矩阵按总线现状展开，新工具自动进内置）。`createAgentFromDef` 按定义现场装配：tools 过滤总线在场项、system=人设前缀+全局纪律后缀（人设可定制、纪律不删减）。`tools` 元素预留 `agent:<id>` 委托形态（多 AI 协作 v2 生长点，v1 装配抛错）；`allowedRoles`（按角色分配助手）v1 仅透传。
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
| `wms-agent.ts` | 便利工厂 `createAgentFromDef`（M16）：按 AgentDefinition 装配——工具授权过滤总线在场项、actor=`ai:{助手id}`、system=人设前缀+buildSystemPrompt 后缀、每次 run/stream 重组；stream() 附加 ui.ask 工具（M12）；`agent:<id>` 委托形态抛错（v2 预留） | 不做编排逻辑（委托 runAgent/streamAgent）、不读配置（定义由调用方给） |
| `agent-defs.ts` | Agent 定义契约（M16）：`AgentDefinition` + 内置三件套（general/readonly/config，工具矩阵按总线现状展开）+ `readAgentDefs`（settings.agents 配置面读取 + 脏面窄化 + 内置兜底）+ `aiModuleManifest`（core.ai 模块 manifest，settings.agents 声明 default:[] 使慢通道 replace 路径可用） | 不装配 agent（wms-agent 的事）、不做 HTTP |
| `provider/vercel.ts` | 单轮 generateText + 消息/工具双向翻译（含 `error-json` 错误输出、不可序列化返回值降级） | 不做多步循环、不执行工具（无 execute） |
| `provider/config.ts` | AiProviderConfig → LanguageModel；Ollama 走原生 OpenAI 兼容端点（默认 `http://localhost:11434/v1`，`@ai-sdk/ollama` 已从 registry 移除） | 不读环境变量/配置文件（调用方给配置） |

## 测试策略（ai）——绝不打真实 API

- **编排循环**（agent.test.ts）：脚本化 mock provider 驱动——多轮循环、同轮多工具、错误回传不中断、maxSteps、旁白保留；streamAgent 流式（事件序）与 ui.ask 挂起/唤醒（answer/declined 注入、非法应答兜底 declined、与普通工具混排时 ui.ask 不进 invoke）。
- **适配层**（vercel-provider.test.ts）：`MockLanguageModelV4`（ai/test）锁定行为契约——toolCalls 解析（input JSON 串 → args 对象）、消息/工具翻译、**无 execute 的工具被调用时 SDK 正常返回**。
- **端到端**（wms-agent.test.ts）：mock provider + 真实内核/wms——actor 落审计（`ai:{助手id}`）、护栏在 AI 通道照常生效（超量出库被拒 + 零事件 + 错误回传）、快照注入与 prompt 组合（人设前缀 + 全局纪律）、工具授权过滤与委托形态抛错。
- **定义契约**（agent-defs.test.ts）：内置三件套工具矩阵、readAgentDefs 配置面/脏面窄化/内置兜底、慢通道整体 replace 闭环（install 种子 default:[] 的意义验证）。

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
│                    core.ai 登记 + provider/aiConfig    │
│                    （进程级单例装配，M16 去固化 agent； │
│                    M17 起可热更新 applyAiConfig）      │
├─ 路由层（HTTP 边界）──────────────────────────────────┤
│  routes/profile.ts     GET  /api/profile/snapshot      │
│  routes/proposals.ts   GET  /api/proposals             │
│                        POST /api/proposals/:id/confirm │
│                        POST /api/proposals/:id/reject  │
│  routes/wms.ts         管理界面业务端点（读视图/写工具，│
│                        M14 效期看板读端点，M15 阈值      │
│                        settings 化 + 库位明细；盘点端点；│
│                        M18 SKU 检索参数 barcode/q）     │
│  routes/chat.ts        AI 会话 SSE（M12：消息流 +      │
│                        ui.ask 应答端点，见下；M16 按    │
│                        agentId 现场装配助手；对话存档   │
│                        chat-threads.json）              │
│  routes/agents.ts      助手目录 + 定义提议端点（M16，   │
│                        见下）                            │
│  routes/ai-config.ts   AI 模型配置端点（M17：状态/保存/ │
│                        关闭/连通测试，见下）             │
│  routes/sync.ts        同步三端点（M5，见下）            │
│  routes/migration.ts   迁移导出/导入两端点（M7，见下）   │
├─ 同步层（节点间传输编排，M5）────────────────────────────┤
│  sync/sync-client.ts   runSyncRound：hello → 拉取计划 → │
│                        分页拉取 → 摄入 → replayAll      │
├─ 支撑层 ──────────────────────────────────────────────┤
│  errors.ts         core 错误 code → HTTP 状态码映射    │
│  ai-config.ts      环境变量 → AiProviderConfig（启动    │
│                    env 面，M17 起为配置文件的兜底）      │
│  ai-config-store.ts 校验归一 + 配置文件持久化（M17）    │
│  static.ts         托管 app/dist（存在则挂载）          │
└───────────────────────────────────────────────────────┘
```

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `index.ts` | createApp(context) 组装 Hono 应用 + start() 监听端口（唯一进程入口） | 不含业务逻辑 |
| `context.ts` | AppContext 装配：OneCore.open(数据库路径) + WmsDomain.attach + **core.ai 模块登记**（registerManifest 进程目录 + install 落账，M16）+ provider/aiConfig 注入（不再启动时固化 agent——chat 路由按消息现场装配）；**M17：provider/aiConfig/aiConfigSource 可变**（页面保存后 applyAiConfig 现场重建 provider，无需重启）+ aiConfigPath/aiConfigEnv（配置文件持久位与 env 回落面） | 不认识 HTTP（可被任何宿主复用——含未来 Tauri sidecar） |
| `routes/*.ts` | HTTP 契约：参数提取 → 调用 workspace 视图/agent → JSON 序列化 | 不做业务校验（在工具 handler / ProfileService）、不碰 SQL |
| `routes/wms.ts` | 管理界面业务端点：读操作直查投影（skus/orders/inventory 视图，明细行联查经 `ws.skus.byId` 组装 skuCode/name；M18：GET /api/skus 支持 `barcode=` 精确与 `q=` 编码/名称/条码模糊查询参数——路由层内存过滤；M19：GET /api/inventory 行扩冻结三件套 quantity/held/available（联 listHolds 汇总）、GET /api/holds?skuCode= 活动冻结清单——未知编码空清单；M20：GET /api/inventory 行附 reorderPoint（联 SKU 主数据，前端判定低库存——与 lowstock 工具同口径）），写操作一律 `ws.tools.invoke('wms.*', body, actorOf(ctx))`（actor=`user:local@{nodeId}`）并透传工具返回值（M19：POST /api/holds → wms.inventory.hold、POST /api/holds/:id/release → wms.inventory.release）；效期看板读端点（M14，M15 进阶）`GET /api/inventory/expiry`——inventory.list() 桶行按 (SKU, 批次) 聚合（余量跨库位合计 + 库位×余量明细 buckets 按余量降序）+ daysLeft/level 五层分级（阈值读 readWmsSettings(ctx.ws)——core.wms settings 同源，缺省 7/30）+ 效期升序，全在路由层组装；盘点端点组（业务补齐 17）：GET /api/locations（库位清单，盘点范围勾选数据源）+ GET/POST /api/stocktakes（清单附带范围编码与进度 / 创建）+ GET /api/stocktakes/:no（明细行联查 SKU/库位编码 + 当前账面 bookQty + 差异 delta，按 (编码, 库位, 批次) 稳定排序——投影行序是 uuid 序不面向展示）+ POST /api/stocktakes/:no/count|close|cancel（路径参数注入 body 走工具总线）；**M21 增四组：partners 三端点（GET?kind=&q= 编码/名称模糊 / POST / PUT :partnerCode——写走 wms.partner.* 工具）、pickings 六端点（GET?state= / GET :no / POST / POST :no/pick|close|cancel）、putaway（POST /api/orders/:orderNo/putaway → wms.order.putaway）、dashboard 五端点（GET /api/dashboard/overview|flow-trend?days=|locations|orders|alerts——读直查 dashboard-queries，五维度各自独立）** | 不做业务校验（工具 handler 的职责）、不碰 SQL（联查走视图 API） |
| `routes/chat.ts` | AI 会话端点（M12）：内存会话 Map（生命周期/并发约束见「AI 会话与 ui.ask」）+ SSE 流式消息 + ui.ask 应答注入；M16：每条消息按 body.agentId 读定义现场装配（readAgentDefs + createAgentFromDef，缺省 general，未找到 404 AGENT_NOT_FOUND；def.model 异于进程配置时现场重建轻量 provider=模型覆盖）。成功的一轮写入 `chat-threads.json`（最近 50 段）：模型上下文可在刷新或重启后装回，界面气泡由客户端 PUT 写回 | 不做事件归约（前端的事）、不把导入文件的全文写入存档、不持有助手定义（Profile 配置层的事） |
| `routes/agents.ts` | 助手管理端点（M16）：`GET /api/agents`（readAgentDefs 清单 + 工具总线目录——管理页勾选授权的数据源）、`POST /api/agents/propose`（以 `user:local@{nodeId}` actor 走 profile.propose，整体 replace `/modules/core.ai/settings/agents`——仍是慢通道提议，确认在助手管理页自己的窗口，不进对话页的配置确认） | 不做确认界面（助手管理页的事）、不做权限收敛（v2 角色/多用户后在此按 actor 身份收敛——allowedRoles 的消费方） |
| `routes/ai-config.ts` | AI 模型配置端点（M17）：`GET`（脱敏状态——apiKey 只报 apiKeySet 不回传明文）、`PUT`（校验 → 写配置文件 → applyAiConfig 热生效，响应即新状态）、`DELETE`（删配置文件 → 回落启动 env 配置或彻底关闭）、`POST /test`（按 body 或当前配置打一轮最小补全，返回 ok/latencyMs 或失败原文；20s 超时兜底）。密钥复用约定：body 密钥留空且 kind 与 baseUrl 都未变 → 沿用已保存密钥 | 不做校验规则定义（ai-config-store 的 parseAiConfigInput 是唯一标准）、不落密钥明文到响应 |
| `errors.ts` | 错误映射中间件：CoreError.code → HTTP 状态 + `{ code, message }` 响应体 | 不吞错（未知错误 500 带原文） |
| `sync/sync-client.ts` | runSyncRound(peer)：hello 握手（校验 workspaceId 一致 + 自拉防护）→ computePullPlan → 分页拉取 → core.sync.applyRemote → accepted>0 时 ws.replayAll；fetchImpl 可注入（测试零网络） | 不解析事件内容（摄入幂等在 core）、不做发现/推送/加密（v1 裁剪） |
| `routes/sync.ts` | 同步 HTTP 契约：`GET /api/sync/hello`（握手）、`GET /api/sync/events/:actor?fromSeq=&limit=`（区间供事件 + 分页游标）、`POST /api/sync/run`（body `{ peers? }`，缺省 env `ONE_SYNC_PEERS`；逐 peer 跑回合，单 peer 失败不炸整轮） | 不做协议计算（在 core）、不持有状态 |
| `routes/migration.ts` | 迁移 HTTP 契约（M7）：`GET /api/migration/export`（全量事件包）、`POST /api/migration/import`（幂等导入 + replayAll + manifest 在场性报告——对照 exposeModuleRegistry().listManifests 扫描 module.installed 事件） | 不做包结构校验（在 core.migration）、不阻塞缺失 manifest（报告语义） |
| `ai-config.ts` | 读 env（`ONE_AI_*` / `OLLAMA_*`）→ AiProviderConfig（启动 env 面；M17 起为配置文件兜底——start() 优先读配置文件） | 不做 provider 构建以外的任何事、不感知配置文件 |
| `ai-config-store.ts` | AI 配置页面持久化位（M17）：parseAiConfigInput 校验归一（页面 PUT / 连通测试 / 文件读取同一标准——损坏文件按未配置处理不阻启动）+ 配置文件读写（dbPath 同目录 ai-config.json，`ONE_AI_CONFIG_PATH` 可覆盖；:memory: 宿主无落盘位 → null 仅进程内生效）；明文 JSON = 与迁移包同级的本地可信域假设 | 不做 provider 构建（resolveLanguageModel 的事）、不经 env |
| `static.ts` | SPA 静态托管：app/dist 存在则挂载 + history 回退到 index.html | dist 不存在时静默跳过（纯 API 模式可独立运行） |

## 关键机制

- **API 契约（v1）**：
  - `GET /api/health` → `{ nodeId, ok }`；
  - `GET /api/profile/snapshot` → ProfileSnapshot（确认界面的「现状」数据源）；
  - `GET /api/proposals` → `ProposalSummary[]`（仅 pending，确认/拒绝即从列表消失）；
  - `POST /api/proposals/:id/confirm` body `{ by? }`（缺省 `user:local@{nodeId}`，显式传可覆盖——预留多用户）→ `{ newVersion, appliedOps }`；`PROPOSAL_STALE` → 409（前端提示「配置已变化，请让 AI 重新提议」）；
  - `POST /api/chat/sessions/:id/message` body `{ message, agentId? }`（M16：agentId 选助手，缺省 `general`；未找到 → 404 `AGENT_NOT_FOUND`）→ **SSE 流式**（M12 会话化）：AgentStreamEvent 直译为 SSE 事件名（`text-delta` / `tool-call` / `ask` / `tool-result` / `turn-done` / `error`），前端逐事件渲染（工具卡先落「执行中」、结果回填、助手文本逐 delta 增长）；
  - `POST /api/chat/sessions/:id/answer` body `{ callId?, answer }`（或 `{ declined: true }`）→ ui.ask 挂起流的用户应答（M12 步骤3，见下「AI 会话与 ui.ask」）；
  - `GET /api/agents` → `{ agents: AgentDefinition[], tools: {id,label,description,permission}[] }`（M16：readAgentDefs 清单 + 工具总线目录——前端切换器与助手管理页的数据源）；
  - `POST /api/agents/propose` body `{ agents, note? }` → 提议整体替换 core.ai settings.agents（M16：人通道 actor=`user:local@{nodeId}`，确认走既有 `/api/proposals/:id/confirm`——「配置 AI」是高权限动作，与对话里的「使用 AI」分离）。
  - `GET /api/ai-config` → `{ configured, source: 'file'|'env'|'none', config?: { kind, model, baseUrl, apiKeySet } }`（M17：脱敏状态——密钥只报是否已设置，不回传明文）；
  - `PUT /api/ai-config` body `{ kind?, model, baseUrl?, apiKey? }` → 校验（`AI_CONFIG_INVALID` 400）→ 写配置文件 + 热生效（响应即新状态）；密钥留空且 kind/baseUrl 未变时沿用已保存密钥；
  - `DELETE /api/ai-config` → 删配置文件并回落启动 env 配置（有则 `source=env`，无则彻底关闭）；
  - `POST /api/ai-config/test` body 同 PUT（空 body = 测试当前生效配置）→ `{ ok, model, latencyMs?, reply? | message }`——**200 包结果**（测试失败不是请求失败，失败原文回传排障）。
- **管理界面业务 API（读写分治）**：
  - **读 = 直查投影视图**（投影是缓存，只读安全）：`GET /api/skus` → `SkuRecord[]`（M18 起支持查询参数：`barcode=` 精确匹配——扫码枪入口；`q=` 编码/名称/条码三字段模糊——页面搜索框；路由层内存过滤，不碰 SQL）；`GET /api/orders?direction=in|out`（query 可选）→ 订单数组，每单附 `lines`（`ws.orders.lines` + `ws.skus.byId` 联查补 skuCode/name——组装在路由层完成，不碰 SQL）；`GET /api/inventory` → 库存清单（`ws.inventory.list` 按 SKU 跨库位跨批次求和 + SKU 联查；M19 起行含冻结三件套 `held`（联 listHolds 汇总）/ `available = quantity − held`——与出库拦截同一口径；M20 起附 `reorderPoint`（联 SKU 主数据——前端低库存判定与 wms.inventory.lowstock 同口径）；分桶明细走 `wms.inventory.query` 工具）；`GET /api/holds?skuCode=` → 活动冻结清单（业务补齐 19：读直查 hold 投影 + SKU 联查，skuCode 可选过滤、未知编码空清单；已释放的不在列——历史在事件账本）；`GET /api/inventory/expiry` → **效期看板**（M14，M15 进阶）`{ today, rows }`——rows 按 (SKU, 批次) 聚合（余量跨库位合计、`buckets` 库位×余量明细按余量降序、SKU 联查），每行携带后端算好的 `daysLeft`（UTC 日期差，null = 未登记）与 `level` 五层分级：`expired`（< 今天）/ `critical`（≤ 阈值）/ `warning`（≤ 阈值）/ `safe` / `unknown`（效期 null，含 DEFAULT 虚拟批次）——**「今天」判定与 M13 拦截同界**（今天到期 = 临期未过期）；零余量桶不上板（出清批次无预警意义）；排序效期升序（最紧急在上、未登记殿后）。**分层阈值读 core.wms settings**（M15：`readWmsSettings(ctx.ws)`，键 expiryCriticalDays / expiryWarningDays，缺省 7/30，与 AI 工具层同一读取实现——改值走慢通道即对看板生效，脏值/次序不合法联动回落缺省）。`GET /api/locations` → `LocationRecord[]`（业务补齐 17：盘点范围勾选数据源）；`GET /api/stocktakes` → 盘点单清单（附 `scope` 库位编码展示 / `'全场'` 与 `lineCount`/`countedCount` 进度）；`GET /api/stocktakes/:no` → 单据信息 + 明细行（联查 skuCode/name/locationCode，携带 expectedQty 账面快照、countedQty、bookQty 当前账面、delta 差异）；**M21 增：`GET /api/partners?kind=&q=`（往来单位清单——kind 过滤 + 编码/名称模糊）、`GET /api/pickings?state=` / `GET /api/pickings/:no`（拣货单清单与明细——行联查 skuCode/skuName/建议与实拣库位）、`GET /api/dashboard/overview|flow-trend?days=|locations|orders|alerts`（运营看板五维度——各自独立端点独立 queryKey，新维度只加端点不动既有）**。
  - **写 = 全部经工具总线**（人与 AI 走同一条命令通道，护栏 + 审计免费）：`POST /api/skus` body `{ skuCode, name, barcode?, reorderPoint?, extData? }` → `wms.sku.create`（M18 起带可选条码、M20 起带可选安全库存）；`POST /api/orders` body `{ direction, lines, orderNo?, note? }` → `wms.order.create`；`POST /api/orders/:orderNo/transition` body `{ to }` → `wms.order.transition`；`POST /api/inventory/adjust` body `{ skuCode, delta, reason?, orderNo? }` → `wms.inventory.adjust`；`POST /api/holds` body `{ skuCode, quantity, reason? }` → `wms.inventory.hold`、`POST /api/holds/:id/release` → `wms.inventory.release`（业务补齐 19，路径参数注入 body）；`POST /api/stocktakes` body `{ locationCodes?, stocktakeNo?, note? }` → `wms.stocktake.create`、`POST /api/stocktakes/:no/count` body `{ skuCode, countedQty, locationCode?, batchNo? }` → `wms.stocktake.count`、`POST /api/stocktakes/:no/close` → `wms.stocktake.close`、`POST /api/stocktakes/:no/cancel` → `wms.stocktake.cancel`（业务补齐 17，路径参数注入 body）；**M21 增：`POST /api/orders` body 加可选 `partnerCode`（往来单位关联，方向 kind 校验在工具层）、`POST /api/orders/:orderNo/putaway` body `{ targets? }` → `wms.order.putaway`（上架确认/归位）、`POST /api/partners` / `PUT /api/partners/:partnerCode` → `wms.partner.create/update`、`POST /api/pickings` body `{ orderNos, pickingNo?, note? }` → `wms.picking.create`、`POST /api/pickings/:no/pick|close|cancel` → `wms.picking.pick/close/cancel`（路径参数注入 body）；另 `POST /api/profile/propose` body `{ patch, note? }` → 经 `profile.propose` 工具提议配置变更（M21 设置页「流程与模块」入口——人通道 actor=`user:local@{nodeId}`，与 AI 同一慢通道同一确认队列，201 返回影响报告）**。actor 固定 `user:local@{nodeId}`（同步通道节点唯一，见 @one/core「同步回合」决策 5；与 confirm 默认值一致：人类本地界面操作，审计可辨）。
  - 工具返回值原样透传为 2xx 响应体；`WMS_*` 领域错误经映射表统一 400 + code（前端按 code 分支提示）。
- **错误映射表**：`PROPOSAL_NOT_FOUND` → 404；`PROPOSAL_STALE` / `PROPOSAL_STATE` → 409；`PROFILE_VALIDATION` → 422；`TOOL_*` / 领域错误 → 400（快通道护栏语义：错误回传前端展示，不落事件）。前端按 `code` 分支提示文案，不 parse message。
- **确认权在 HTTP 侧同样成立**：confirm/reject 是普通 REST 端点（宿主进程即「人操作的界面」），**永不注册为工具**——AI 经 chat 走工具总线，拿不到这两个端点（§4.1 确认权不可委托的传输层落实）。
- **AI 会话与 ui.ask 挂起/唤醒（M12）**：
  - **会话生命周期**：进行中的一轮在 server 内存 Map（sessionId → `{ history, status, pendingAsk? }`，2 小时空闲清理）。`status: idle|streaming`；streaming 期间新消息 → 409 `CHAT_SESSION_BUSY`（单在途流）；仅 `turn-done` 后才把本轮 messages 提交进 history（失败轮不进模型上下文，下一条消息从上一轮重来）。提交后写入本机 `chat-threads.json`（db 同目录，`ONE_CHAT_THREADS_PATH` 可覆盖；`:memory:` 只在进程内）。最近 50 段。`GET /api/chat/threads` 列标题，`POST /api/chat/sessions/:id/resume` 把模型上下文装回内存并返回气泡，`PUT /api/chat/threads/:id` 写回界面气泡，`DELETE` 删一条，`POST /api/chat/threads/clear` 可留 `exceptId`。导入文件的全文不进存档。
  - **ui.ask 的审计豁免**：ui.ask 是「模型向用户提问」的挂起工具——agent 层拦截（不进工具总线、不落 oplog），只附加在会话通道的 stream() 工具清单里（run() 不提供）。挂起语义用生成器实现：`streamAgent` yield `ask` 事件后暂停，server 侧登记 pendingAsk（5 分钟超时按 declined 结算），`answer` 端点收到回答经 `next(reply)` 注入续流；回答随下一轮请求回传模型。
  - **UI 消费**：ask 事件在前端渲染回答输入卡（AskCard），回答走 answer 端点，终态 tool-result 沿原 SSE 连接回来回填。
- **AI 可选性**（§9.2）：env 未配置 AI 时 server 照常启动，仅 chat 端点返回 503——表单/确认界面不受影响。M17 起配置优先级 = **配置页文件 > 启动 env**（两者皆无 = 关闭）；桌面宿主不注入 AI env，「AI 模型」页面是其唯一配置入口，保存即热生效（applyAiConfig 重建 provider，无需重启进程）。
- **多助手装配（M16，「使用 AI」与「配置 AI」分离）**：chat 路由每条消息按 agentId 现场装配（`readAgentDefs` → `createAgentFromDef`）——定义经慢通道确认后下一轮对话即生效（快照新鲜度以消息为粒度）；定义的 actor 语义：AI 通道 `ai:{agentId}@{nodeId}`（谁干的以助手为单位可审计），人通道 `user:local@{nodeId}`（管理页提议）。切换助手由前端负责（当前段先收进存档，再换新 sessionId——历史按助手隔离）。
- **Tauri 接缝（终态预留，本次不实现）**：context.ts 不感知自己被谁托管；Tauri 壳将来 spawn `node packages/server/dist/index.js`（sidecar）+ 内嵌 app/dist 即成桌面节点，零代码改动。
- **单工作区 v1**：env `ONE_WORKSPACE`（默认 `default`）；多工作区切换是后续演进。
- **同步 API（M5，拉模型——协议与决策见 @one/core「同步回合」章节）**：
  - `GET /api/sync/hello` → `{ nodeId, workspaceId, profileVersion, watermarks, eventCount }`（水位 = 各 actor 的 seq 高位，watermarks 各项含通道指纹 checksum；同步组 = 同 workspaceId）；
  - `GET /api/sync/events/:actor?fromSeq=0&limit=500` → `{ actor, events, nextFromSeq, hasMore }`（limit 上限 1000；fromSeq/limit 非法 → 400）；
  - `POST /api/sync/run` body `{ peers?: string[] }` → `{ rounds: SyncRoundResult[] }`（peers 缺省取 env `ONE_SYNC_PEERS` 逗号分隔；两者皆空 → 400 提示配置）；
  - **定时轮询**：start() 里 `ONE_SYNC_PEERS` 非空时按 `ONE_SYNC_INTERVAL_MS`（默认 30000）周期跑回合，关闭时清定时器；
  - **v1 安全边界**：局域网明文、无鉴权（个人可信网段定位）；跨互联网同步 = 先用 VPN 组虚拟局域网（Tailscale/WireGuard，隧道层加密）再走既有同步通道——节点直连上公网不安全，属使用纪律（中继已移除，见「迁移导出」章节变更记录）。
- **M7 API（迁移——协议与决策见「迁移导出」章节）**：
  - `GET /api/migration/export` → `MigrationBundle`（全量事件 + 元信息，明文 JSON 文件）；
  - `POST /api/migration/import` body `{ bundle }` → `{ accepted, skipped, replayed, missingManifests: [{ id, version }] }`。

## 测试策略（server）——不起端口、不碰真实 LLM

- **路由级直测**：`createApp(ctx).request(url, init)` 走 hono 内建测试口——内存库 + mock provider（脚本化 LlmProvider，同 @one/ai 测试手法）。
- 覆盖：proposals 全流程（propose 经真工具总线 → list → confirm → 409 新鲜度）、chat SSE 流式（事件序、多轮历史回传、error 事件后会话可继续、并发 409 CHAT_SESSION_BUSY）与 ui.ask 挂起/唤醒（SseReader 增量读流：ask 事件 → answer 注入续流 → 回答回传模型、挂起期间新消息 409、ui.ask 不落 oplog 的审计豁免断言、5 分钟超时按 declined 结算、404/409 分支）、错误映射表逐 code 断言、AI 未配置 503、管理端点（建 SKU → 列表含 extData、条码（M18）：建带码 SKU → `?barcode=` 精确命中 + `?q=` 三字段模糊、条码冲突 400 `WMS_SKU_BARCODE_EXISTS`、建单 → 明细联查、流转 → 状态变化、库存调整 → 清单更新、`WMS_SKU_EXISTS` / `WMS_INVALID_TRANSITION` / `WMS_INSUFFICIENT_STOCK` 护栏 400、盘点全家桶（业务补齐 17）——创建→清单→库位勾选数据源、明细联查与范围外 400、录实盘→关单→库存收敛、取消零调整、终态拒操作、404）、冻结端点（业务补齐 19）——POST /api/holds → 清单三件套 + /api/holds?skuCode= 过滤与未知编码空清单、释放 → held 归零 + 重复释放 400 WMS_HOLD_NOT_FOUND、超量 400 WMS_HOLD_EXCEEDS_STOCK、出库单撞冻结 400 WMS_STOCK_HELD、安全库存（业务补齐 20）——建 SKU 带 reorderPoint → /api/skus 透传 + /api/inventory 行携带（低库存判定数据源））、效期看板（M14：SKU×批次聚合、跨库位余量合计、五层分级与边界天数（-3/0/7/30/31）、零余量桶过滤、效期升序未登记殿后、空库存空板；M15：库位×余量明细 buckets 按余量降序、慢通道改阈值分层即时变化、脏值/次序不合法联动回落缺省 7/30）、同步端点（vi.stubGlobal 转发 fetch 到对端 app.request，双 AppContext 模拟双节点零网络：双向互拉收敛、参数非法 400、同步组不一致 error、自拉防护 skipped-self、无 peers 400）。
- **迁移测试**（migration.test.ts，M7）：迁移端点（export → 新节点 import → replay → SKU/库存/配置一致、重复导入幂等、manifest 在场性报告）。
- **AI 配置测试**（ai-config.test.ts，M17）：配置端点（GET 默认态/env 来源、PUT 热生效 + 配置文件落盘 + 密钥复用门槛（kind/baseUrl 未变才沿用）、校验 400 分支、DELETE 关闭与 env 回落、GET 脱敏不回传明文、/test 空配置 400）。连通测试的失败面用**本地一次性 HTTP 服务器恒回 401**构造——401 是 AI SDK 的不可重试错误，首轮即失败（不可达端点会触发 SDK 默认重试退避 ~6s 且依赖网络环境，不适合进测试）。

---

# @one/app 前端包架构（UI 里程碑）

> React 18 + Vite + TS + Ant Design 5 + TanStack Query。v1 范围 = 管理界面四页（SKU 动态列表 / 出入库单 / 库存 / 效期看板，DESIGN §2.2「无 AI 也能用」的落地）+ 慢通道闭环（确认收敛在 AI 对话页：待确认提议面板 + 影响报告渲染 + 确认/拒绝，§7.3 确认 UI 的落地）+ 设置页（M8：节点名片 / 局域网同步 / 迁移——M5/M7 运维能力的用户面收口）。

## 分层地图

```
┌─ 入口 ────────────────────────────────────────────────┐
│  main.tsx / App.tsx   AntD ConfigProvider(zhCN) +     │
│                       布局（侧导航十三页五组——看板  │
│                       组含运营/效期看板、档案组含往  │
│                       来单位与拣货单归作业组，M21）+  │
│                       QueryClientProvider              │
├─ 会话层（M12）────────────────────────────────────────┤
│  app-nav.tsx           页面导航 context + 跳转携带     │
│                        一次性 initialFilter           │
│  chat/ChatProvider.tsx AI 对话状态（App 级 context，  │
│                        切页不丢）+ SSE 事件归约 +     │
│                        agentId 助手切换（M16）        │
├─ 页面层 ──────────────────────────────────────────────┤
│  pages/SkusPage.tsx       SKU 列表（动态列 + 条码列 +│
│                            安全库存列 + 搜索框）+      │
│                            新建表单                    │
│  pages/OrdersPage.tsx     单据列表 + 建单 + 状态流转    │
│  pages/InventoryPage.tsx  库存清单 + 过滤 + 手工调整   │
│                            （M18：扫码选中开调整弹窗； │
│                            19 冻结量/可用量列 + 冻结   │
│                            管理弹窗；20 安全库存列 +  │
│                            低库存标红与过滤）           │
│  pages/StocktakePage.tsx  盘点（补齐 17：清单 + 创建/ │
│                            明细/关单弹窗；18 明细扫码  │
│                            定位行）                     │
│  pages/ExpiryPage.tsx     效期看板（M14 分层统计卡 +   │
│                            着色表格 + 层/关键词过滤；  │
│                            M15 行展开库位明细 + 跳转    │
│                            预填）                       │
│  pages/ChatPage.tsx        对话面板（消息流 + 输入 +   │
│                            工具调用过程卡片 + 助手      │
│                            Segmented 切换器，M16；     │
│                            顶部待确认提议面板——慢通道  │
│                            拍板收敛在本页，不另设页）   │
│  pages/AgentsPage.tsx      助手管理（左清单，右详情；   │
│                            点开一块业务再改，释义悬停） │
│  pages/AiConfigPage.tsx    AI 模型配置（M17：状态卡 +  │
│                            表单 + 测试连接/保存/关闭） │
│  pages/SettingsPage.tsx    设置（节点/同步/迁移，M8；  │
│                            M21 增流程与模块 Tab）       │
│  pages/DashboardPage.tsx   运营看板（M21：Segmented    │
│                            五维——总览/流量/库位/单据/  │
│                            预警，自写 SVG 趋势图）      │
│  pages/PartnersPage.tsx    往来单位（M21：kind 分段 +  │
│                            搜索 + 新建/编辑）           │
│  pages/PickingsPage.tsx    拣货单（M21：清单 + 展开行  │
│                            内实拣录入 + 关单/取消）     │
├─ 组件层 ──────────────────────────────────────────────┤
│  components/ImpactReportView.tsx   影响报告渲染        │
│  components/ToolInvocationCard.tsx 工具调用过程展示    │
│                        （流式回填 + 结果表格 + 后置    │
│                         动作跳转按钮）                  │
│  components/ToolResultView.tsx    查询结果按形态成表  │
│  components/AskCard.tsx            ui.ask 回答输入卡  │
│  components/ProposalDetail.tsx     提议详情 + 确认/拒绝│
│  components/SkuFormModal.tsx       新建 SKU（动态表单）│
│  components/OrderFormModal.tsx     建单表单（明细行 +   │
│                        M18 扫码录入：扫一件 = 追加行/  │
│                        数量 +1）                       │
│  components/ScanInput.tsx          扫码枪输入框（M18：  │
│                        自动聚焦 + 回车触发 + 清空续扫）│
│  components/PartnerFormModal.tsx   往来单位表单（M21：  │
│                        kind 新建时定不可改；编辑只改    │
│                        属性）                          │
│  components/PutawayModal.tsx       上架弹窗（M21：行级 │
│                        目标库位 Select，不选=纯确认）  │
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
| `App.tsx` | 布局壳 + 路由（M21 起十三页五组，AntD Menu 切换：看板两页 + 作业四页 + 档案两页 + 智能助手四页 + 设置页）+ 中文 locale；AppNavProvider 包壳（M12 步骤4：AI 后置动作可跳任意页） | 不含业务组件 |
| `app-nav.tsx` | 导航 context（M12 步骤4）：`navigate(page, filter?)` 切页 + 携带一次性 initialFilter（目标页挂载时 `takeInitialFilter` 消费，取后即清） | 不渲染页面（App.tsx 消费 page 渲染） |
| `chat/ChatProvider.tsx` | AI 对话状态壳（M12）：`send()` 消费 SSE 流并归约事件到 turn、`answerAsk()` 提交 ui.ask 应答；每一段在服务端存档，刷新后打开上次那一段（`onewms.chat.openThreadId` 记下打开的 id，空字符串表示留在空白新对话）。M16：`agentId` + `setAgentId`（切换 = 当前段先存档，再换新 sessionId 并清空画面，流式中锁定）；`newChat` / `openThread` / `deleteThread` / `clearThreads`。App 级 context——切页不丢对话 | 不渲染对话 UI（ChatPage 的事）、不直接碰 fetch 细节（client.ts 封装） |
| `pages/SkusPage.tsx` | SKU 列表（动态列，见关键机制；固定列含条码——M18，无码显 `-`；安全库存——M20，0 显 `-`）+ 搜索框（`?q=` 编码/名称/条码模糊——M18）+ 新建入口 | 不做字段元数据管理（那是慢通道提议的事） |
| `pages/OrdersPage.tsx` | 单据列表（方向筛选 + 单号过滤——AI 跳转预填）+ 建单表单（明细行；M21 加往来单位 Select——按方向过滤 kind，切换方向清空选择）+ 状态流转按钮（候选目标状态由 Profile workflows 计算 + **M21 when 条件本地求值过滤——停用模块的转移不显示**；入库单 received 态且 module.putaway 活跃时显「上架」按钮开 PutawayModal）；M21 加往来单位列、展开行批次/目标库位列 | 不做转移合法性裁决（工具 handler 的 400 是兜底） |
| `pages/InventoryPage.tsx` | 库存清单（联查 SKU 信息 + 编码/名称过滤——AI 跳转预填）+ 手工调整表单（delta 正负 + 原因；行内预填 / 顶部自选 SKU 两种入口——空库存可录期初）+ 扫码入口（M18：扫条码/编码 = 选中 SKU 开调整弹窗，无库存行照开余量 0）+ 冻结管理（M19：冻结量/可用量列——冻结 >0 橙色、可用 <0 红色；行内「冻结」按钮开 HoldModal——上半该 SKU 活动冻结清单（数量/原因/时间 + 逐笔 Popconfirm 释放）、下半追加冻结表单（数量 + 原因）；可用量负值是物理修正通道的合法态，出库全拦直到释放）+ 低库存预警（M20：安全库存列 0 显 `-`；可用量低于阈值标红加粗；「只看低库存」Checkbox 过滤——判定式与 wms.inventory.lowstock 工具同口径） | 不展示流水明细（审计走事件账本，v2 接缝） |
| `pages/StocktakePage.tsx` | 盘点页（业务补齐 17）：盘点单清单（状态 Tag + 已盘/总行进度 + 操作按钮——终态单只留明细）+ 创建弹窗（全场/指定库位 Radio + 库位 Checkbox.Group，数据源 GET /api/locations 含 DEFAULT）+ 明细弹窗（逐行实盘数 InputNumber 失焦/回车提交、行携带账面/实盘/差异、关单带确认；录入草稿按「单号:桶」本地暂存——重开弹窗不丢未提交值；M18 扫码定位——扫条码/编码过滤到该 SKU 的桶行，多桶全列供逐桶录数，Tag 可清除） | 不做范围/进度校验（工具 handler 的 400 兜底）、不直接写库存（差异收敛全经 wms.stocktake.close） |
| `pages/ExpiryPage.tsx` | 效期看板（M14，M15 进阶）：五层统计卡（已过期/紧急/预警/安全/未登记效期——前端 reduce 计数）+ 着色表格（分层 Tag、剩余天数分形渲染、库位列显「N 库位」）+ **行展开库位×余量明细**（消费后端 buckets，余量降序直出）+ 层下拉与关键词过滤（AI 跳转 skuCode 预填——M15）；消费后端算好的 daysLeft/level/buckets，纯展示零计算 | 不做分层/日期计算（server 的职责——单一真相）；不提供改阈值入口（settings 改值走慢通道提议确认，v1 不在看板内嵌表单） |
| `components/SkuFormModal.tsx` | 新建 SKU 表单：固定字段（skuCode/name + 条码可选——M18 + 安全库存可选——M20，>0 才提交）+ 可见扩展字段按 type 动态渲染输入控件 | 不解释字段语义（只按 type 映射控件） |
| `components/OrderFormModal.tsx` | 建单表单：方向 + 明细行（SKU 下拉来自投影 + 数量）+ 备注 + 扫码录入（M18：扫条码/编码 = 已在单的行数量 +1，未在单追加一行数量 1——逐件累加） | 不做明细校验（工具 handler 的职责） |
| `components/ScanInput.tsx` | 扫码枪输入（M18）：USB 扫码枪 = 键盘设备——挂载自动聚焦、回车触发 `onScan(trim 值)`、空值不触发、扫后清空续扫；手工键入同样有效 | 不做条码→SKU 解析（调用方用 useSkus 数据自行匹配——条码优先编码兜底） |
| `pages/ChatPage.tsx` | 对话面板（M12）：消息流渲染、发送（isStreaming 串行）、工具卡 + AskCard + 后置动作按钮（onAnswer/onNavigate 注入）；M16：输入区下方 Segmented 助手切换器（选项来自 GET /api/agents，流式中锁定）+「管理助手」入口；**顶部待确认提议面板**（useProposals 5s 轮询 + 对话内 profile.propose 成功即刷）——慢通道拍板收敛在本页，展开 ProposalDetail 直接确认/拒绝（配置确认页已并入） | 不管理会话状态与 SSE 消费（ChatProvider 的事）、不做助手定义管理（AgentsPage 的事） |
| `pages/AgentsPage.tsx` | 助手管理页（M16，「配置 AI」的界面）：整页左右。左侧助手清单，右侧是当前助手的详情（id/名称/职责；人设和模型在弹出层；已载入助手的 id 不可改）。详情里按业务显示现状（不开放 / 只能查询 / 可以修改 / 单独调整；配置类是只能查看 / 可以提议）。点开一块，用大按钮定整档；需要时再逐项调整，再回到业务一览。具体工具在感叹号上，悬停才出现。新建/删除改本地草稿，删除要确认。保存把整份清单 POST /api/agents/propose，本页弹出「确认助手改动」（AgentApplyConfirm，和对话页的 ProposalDetail 不是同一个窗口）：确认才写入，放弃则保持原配置。清单清空后保存会恢复内置三件套 | 不使用对话页的配置确认窗、不直接写 Profile（经 server 慢通道端点，确认也走 proposals confirm） |
| `pages/AiConfigPage.tsx` | AI 模型配置页（M17，接入层面板）：状态卡（GET 真相面——configured/source/脱敏配置）+ 配置表单（接入方式 Radio / 模型名 / Base URL 按条件必填 / 密钥 Input.Password；速填预设 OpenAI/DeepSeek/本地 Ollama）+ 测试连接（POST /test 结果内联渲染：成功耗时/失败原文）/ 保存并生效（PUT）/ 关闭 AI（DELETE，Popconfirm 二次确认）。密钥编辑约定：已保存密钥不回显，留空且接入方式与 Base URL 未变 = 服务端沿用 | 不做配置校验与持久化（server 的事——页面是触发器 + 状态显示器）、不缓存密钥明文（GET 不回传，表单不留存） |
| `components/ImpactReportView.tsx` | 影响报告渲染：summary 统计 + items 按 severity 分色（warning 黄 / info 蓝）+ 中文 description 直出 | 不做裁决（人确认） |
| `components/ProposalDetail.tsx` | note/patch 摘要 + ImpactReportView + 确认/拒绝按钮（409/422 按 code 提示） | 不直接调 ProfileService（只走 HTTP） |
| `components/ToolInvocationCard.tsx` | 工具调用过程卡（M12）：流式落卡/回填终态、参数与结果摘要、ui.ask 分流（AskCard / 问答回显）、成功工具的后置动作按钮（如「去库存页查看」「去效期看板」（M15）；profile.propose 不出——确认收敛在 ChatPage 待确认面板） | 不执行工具、不直接跳页（onNavigate 回调注入） |
| `components/ToolResultView.tsx` | 查询结果按 toolId + payload 形态渲染表格（inventory.query 三形态 / expiring / location.list，超 50 行截断），其余 JSON 兜底 | 不做数据拉取（渲染传入的 payload 快照） |
| `components/AskCard.tsx` | ui.ask 挂起态的回答输入（提交/跳过，提交后锁定） | 不提交请求（onAnswer 回调注入） |
| `pages/SettingsPage.tsx` | 设置四分区（M8 三区 + M21 流程与模块）：节点名片（只读）/ 局域网同步（peers + 手动回合）/ 迁移（导出下载 + 导入上传）/ **流程与模块（M21：FlowModulesPanel——业务模块 Switch 启停走慢通道 propose → 影响报告 Modal → confirm 生效，系统模块只读；WorkflowCard 流程只读视图含 providedBy 徽标与 when 列）** | 不持久化任何配置（peers 每次随请求发送，服务端 env 是唯一持久位）、不直接改 Profile（全走慢通道确认） |
| `pages/DashboardPage.tsx` | 运营看板（M21）：Segmented 五维切换——总览（指标卡）/ 流量趋势（自写 SVG 双向柱，天数可选）/ 库位分布（横条 Top 8 + 其他）/ 单据统计（状态分布）/ 预警（效期三级 + 冻结 + 负余量 Alert）；五维度各自独立 hook（`['dashboard', 维度]` queryKey），本地 stateLabel/evalWhen 等价实现 | 不做统计计算（server 算好直出）、不引图表库（Antd 原生 + 自写 SVG） |
| `pages/PartnersPage.tsx` | 往来单位（M21）：Segmented（全部/供应商/客户）+ 编码/名称搜索 + 新建/编辑（PartnerFormModal 复用——kind 只在新建时定） | 不做 kind 语义校验（工具 handler 的 400 兜底） |
| `pages/PickingsPage.tsx` | 拣货单（M21）：清单（状态 Tag + 进度）+ 展开行内实拣录入（InputNumber + 改实拣库位/批次）+ 新建（多选 picking 态出库单）+ 关单（后端统一扣减）/ 取消 | 不做拣满/守卫校验（工具 handler 的 400 兜底）、不直接写库存 |
| `components/PartnerFormModal.tsx` | 往来单位表单（M21）：新建（编码/kind/名称/联系人/电话/地址/备注）与编辑（只改属性）复用 | 不做唯一性校验（工具层的事） |
| `components/PutawayModal.tsx` | 上架弹窗（M21）：订单行级目标库位 Select（不选 = 纯确认上架）；提交体 targets[{skuCode, fromLocationCode?, batchNo?, toLocationCode}] | 不做源桶守卫（工具层的事） |
| `api/client.ts` | fetch 封装：JSON 序列化、非 2xx 抛 `ApiError{code,message}`；chat 事件契约手写镜像（不依赖 @one/ai）+ SSE 流消费（streamChatMessage，M16 起带 agentId）+ ui.ask 应答（answerChatAsk）+ 助手契约（AgentDef/AgentCatalog 镜像 + agents()/proposeAgents()，M16）+ AI 配置契约（AiConfigStatus/AiTestResult 镜像 + aiConfig()/saveAiConfig()/clearAiConfig()/testAiConfig()，M17）+ 效期看板契约（ExpiryBoard/ExpiryBatchRow/ExpiryLevel 镜像 + expiryBoard()，M14；M15 起 ExpiryBatchRow 携带 buckets 库位×余量明细）+ 盘点契约（业务补齐 17：Location/Stocktake/StocktakeDetail/StocktakeCloseResult 镜像 + locations()/stocktakes()/stocktakeDetail()/createStocktake()/countStocktake()/closeStocktake()/cancelStocktake()）+ 条码契约（M18：Sku 携带 barcode: string \| null；skus() 接受 `{q?, barcode?}` 查询参数，createSku() 接受可选 barcode）+ 冻结契约（M19：InventoryRow 携带 held/available 三件套；Hold 镜像 + holds()/createHold()/releaseHold()）+ 安全库存契约（M20：Sku/InventoryRow 携带 reorderPoint，createSku() 接受可选 reorderPoint）+ **M21 契约组（Partner/Picking/PickingLine 镜像 + partners()/createPartner()/updatePartner()/pickings()/createPicking()/pickPickingLine()/closePicking()/cancelPicking()/putawayOrder()；Dashboard 五类型 + dashboardOverview()/dashboardFlowTrend()/dashboardLocations()/dashboardOrders()/dashboardAlerts()；OrderLine 加可选 locationCode/batchNo、Order 加 partnerCode/partnerName、createOrder body 加可选 partnerCode；proposeProfile() 慢通道提议）** | 不缓存（Query 的职责） |
| `api/hooks.ts` | useSkus（M18 起接受可选 q 模糊参数——queryKey 带 q，invalidate 前缀匹配仍全失效）/ useCreateSku / useOrders / useCreateOrder / useTransitionOrder / useInventory / useAdjustInventory / useProfileSnapshot / useProposals / useConfirmProposal / useRejectProposal + useExpiryBoard（M14）+ M8 设置页组（useNodeHello / useSyncRun / useMigrationExport / useMigrationImport）+ M17 AI 配置组（useAiConfig / useSaveAiConfig / useClearAiConfig / useTestAiConfig——保存/关闭后失效 ['ai-config'] 重取状态卡；测试不失效——无状态变化）；adjust 与单据流转的 onSuccess 一并失效 expiry-board（桶余量变化 → 看板随之新鲜）；盘点组（业务补齐 17：useLocations/useStocktakes/useStocktakeDetail/useCreateStocktake/useCountStocktake/useCloseStocktake/useCancelStocktake——count 失效 stocktakes+stocktake，close/cancel 加失效 inventory+expiry-board：差异收敛 → 库存与看板随之新鲜）+ 冻结组（业务补齐 19：useHolds（queryKey 带 skuCode 防串缓存，invalidate 前缀全失效）/useCreateHold/useReleaseHold——冻结/释放只失效 inventory+holds：物理库存与效期看板不受影响）+ **M21 组（usePartners/useCreatePartner/useUpdatePartner——queryKey 带 kind/q；拣货组 usePickings/useCreatePicking/usePickPickingLine/useClosePicking/useCancelPicking——关单失效 orders+inventory+expiry-board+dashboard：订单推进与统一扣减联动；usePutawayOrder——失效 orders+inventory+expiry-board+dashboard；看板五 hook useDashboardOverview/useDashboardFlowTrend/useDashboardLocations/useDashboardOrders/useDashboardAlerts——queryKey ['dashboard', 维度] 独立，写操作 invalidate ['dashboard'] 前缀全失效；useProposeProfile——设置页模块启停提议）** | 不做 UI 判断 |

## 关键机制

- **SKU 动态列（Profile 配置的第一个真实消费闭环）**：`useProfileSnapshot()` 读 `schema.entities.sku.extensions`，AntD Table 的 columns = 固定列（编码/名称/条码（M18，无码显 `-`）/安全库存（M20，0 显 `-`）/更新时间）+ `visible !== false` 的扩展列（`dataIndex: ['extData', key]`，title = label）。新建表单（SkuFormModal）的扩展输入项同源生成，type → 控件映射：string→Input、number→InputNumber、boolean→Switch、date→Input（v1 不引日期库）、json→TextArea（提交时 JSON.parse 校验）。**隐藏字段的语义 = 列与输入项同时消失，数据保留**（软删除的界面投影）；在 AI 对话页确认「隐藏字段」提议后 invalidate snapshot → 切回 SKU 页列即消失——AI 改配置 → 界面变化的端到端闭环。
- **单据流转按钮由 Profile workflows 驱动**：候选目标状态 = `workflows[inbound|outbound].transitions.filter(t => t.from === 当前列)`（方向映射：in→inbound、out→outbound）——UI 消费配置面。M8 起行为权威也是配置面（工具 handler 从同一 workflows 校验），前后端单一数据源，按钮所见即校验所得；非法转移仍被 400 `WMS_INVALID_TRANSITION` 兜底（两窗口间的配置变化）。**M21：候选状态再做 when 条件本地求值过滤（evalWhen 等价实现——停用模块贡献的转移不显示按钮），与工具层运行时求值同一语义**。
- **运营看板 = 五维度独立架构（M21）**：overview/flow-trend/locations/orders/alerts 各自独立端点 + 独立 queryKey（`['dashboard', 维度]`）+ 独立 hook——**新增查看维度只加函数+路由+hook，不动既有**；写操作（出入库/上架/拣货/调整）失效 `['dashboard']` 前缀匹配全失效。图表不引依赖：Antd 原生组件 + 自写 SVG 迷你趋势图（双向柱：出库向上/入库向下）。
- **设置页「流程与模块」= 慢通道的运营入口（M21）**：业务模块 Switch 启停 → POST /api/profile/propose（人通道，与 AI 的 profile.propose 同一工具同一队列）→ 影响报告 Modal（summary + items）→ 人工确认生效；系统模块（core.*）只读；流程只读视图展示 states（含模块贡献 providedBy 徽标）与 transitions（含 when 列）——「流程可配置」对用户可见可操作。
- **影响报告 = 确认界面的核心**（§7.3）：报告条目直出（后端已生成中文 description），前端只负责分级着色与排版——不在前端重新计算 diff（单一真相：报告所见即应用所得由后端新鲜度检查保证，前端不掺和）。
- **提议确认的乐观刷新**：confirm 成功后 invalidate `['proposals']` + 弹出成功结果（newVersion）；409 时提示重新提议并刷新列表。
- **对话面板的工具过程可见**：invocations 渲染为过程卡（工具名、参数摘要、成败、查询结果表格），让「AI 经工具总线操作」对用户可见可审计（§9.3 透明度）。
- **AI 聊天 = SSE 流式 + 会话化（M12）**：ChatProvider（App 级 context，切页不丢对话）消费 `/api/chat/sessions/:id/message` 的 SSE 流，事件归约到 turn——工具卡先落「执行中」、tool-result 回填终态、助手文本逐 delta 增长；ui.ask 挂起渲染 AskCard（回答走 answer 端点，终态沿原流回填）。成功的一轮把气泡 `PUT` 进存档；模型上下文由 server 在 turn-done 时写入。刷新后按本地记下的 id `resume`，没有记录就打开最近一段。对话页标题右侧和浮窗底栏有「历史」「新对话」：历史按标题搜索，点开接着聊；新对话先把当前段收进存档；清空历史时正在看的这一段留下。
- **助手切换 = 前端换会话（M16）**：ChatPage 的助手下拉来自 GET /api/agents（目录加载失败静默降级为无切换器）；`setAgentId` = 当前段先存档，再换新 sessionId 并清空画面（server 每条消息按定义现场装配，历史按助手隔离）；`AGENT_NOT_FOUND` 落友好提示（定义可能已被慢通道修改）。**「使用 AI」（对话里切换）与「配置 AI」（助手管理页自己的确认窗）分离**——改助手是高权限动作，管理页保存生成提议后在本页确认才写入。
- **AI 模型配置页 = 接入层面板，保存即热生效（M17）**：三层分离的最后一层——助手管理管「谁」（agent 定义，慢通道）、AI 对话管「用」（快照装配）、AI 模型管「通到哪」（kind/model/baseUrl/apiKey，PUT 后 server 现场重建 provider，无需重启，下一轮对话即用新模型）。页面是触发器 + 状态显示器：配置真相在服务端配置文件（随数据走——桌面版在 app data），GET 只回脱敏状态（密钥不回传明文，编辑场景留空沿用）；测试连接打真实最小补全——成功报耗时、失败原文回传排障。`AI_NOT_CONFIGURED` 的 chat 503 与对话错误提示均指向本页。
- **配置确认在 AI 对话页，助手定义另有确认窗**：ChatPage 消费 `GET /api/proposals`（5s 轮询 + 对话内 profile.propose 成功即刷）。配置类和 AI 记忆的 pending 提议用 ProposalDetail 弹窗确认/拒绝；整份都是 `/modules/core.ai/settings/agents` 的提议不进这个窗口。助手管理保存后留在本页，用 AgentApplyConfirm 确认或放弃。AI 记忆保存仍跳到对话页确认。
- **跳转后置动作（M12 步骤4）**：成功的工具卡带「去对应管理页」按钮（SKU/单据/库存操作 → 对应页，携单号或 SKU 过滤；临期查询 → 效期看板（M15）——结果全部同一 SKU 时携 SKU 过滤预填，多 SKU 清单不带；profile.propose 不出按钮——确认在本页待确认面板）。经 app-nav 的 `navigate(page, filter?)` 跳转——目标页挂载时 `takeInitialFilter` 一次性消费预填过滤框（库存页/效期页按编码/名称、单据页按单号）；`inventory.query` 平铺/全量清单形态不出按钮（结果已在卡内成表，无单一落点）。
- **效期看板 = 后端算好、前端纯展示（M14；M15 行展开下钻 + 跳转预填）**：`useExpiryBoard()` 消费 `GET /api/inventory/expiry` 的 `{ today, rows }`——daysLeft/level/buckets 由 server 算（与 M13 拦截同界：今天到期 = 临期未过期；阈值读 core.wms settings，见 @one/server），页面只做四件事：五层统计卡（reduce 计数 + 语义色）、着色表格（分层 Tag、剩余天数分形渲染——负数「已过期 N 天」/ 0「今天到期」/ null 弱化 —、库位列显「N 库位」）、**行展开库位×余量明细**（Table expandable 嵌套小表，消费 buckets 余量降序）、层下拉 + 关键词过滤（编码/名称/批次——AI 跳转 skuCode 预填）。数据新鲜度靠 mutation 失效联动：adjust 与单据流转的 onSuccess 一并 invalidate `['expiry-board']`（桶余量变化 → 聚合与分层随之刷新）。让 M11（效期登记）/ M12（批次分配）/ M13（过期拦截）沉淀的效期数据在管理界面可见——「AI 经 wms.inventory.expiring 工具查询」之外的常驻用户面。
- **盘点页 = 逐行录入 + 关单收敛（业务补齐 17）**：三弹窗闭环——创建（全场/指定库位勾选）、明细（逐行实盘数失焦/回车提交，草稿按「单号:桶」本地暂存——重开弹窗不丢已录未提交值；同桶重盘后到者胜，行内差异实时可见）、关单（后端 runAtomic 收敛差异并落 reason=`stocktake:{单号}` 流水，前端 invalidate 库存与效期看板）。差异列消费后端算好的 bookQty/delta——前端零计算，与效期看板同一纪律；盘点全流程亦经 `wms.stocktake.*` 工具可被 AI 执行（护栏与审计免费）。
- **扫码 = 键盘设备，前端只做焦点与回车协议（M18）**：USB 扫码枪对页面表现为「往聚焦的输入框打一串字符 + 回车」——`ScanInput` 组件挂载自动聚焦、`onPressEnter` 触发 `onScan(trim 值)` 后清空续扫（扫码是无鼠标动作，焦点不出框；用户主动点别处时焦点自然离开，不抢焦点）。条码 → SKU 解析在调用方（useSkus 全量数据本地匹配，条码优先、编码兜底——扫码可能扫出商品条码，手工键入的可能是编码）：建单扫一件 = 行追加/数量 +1、库存页扫 = 选中开调整弹窗、盘点明细扫 = 过滤定位桶行。唯一性护栏在工具层（`WMS_SKU_BARCODE_EXISTS`），前端匹配只是便捷层——扫出多结果在数据上不可能（同库条码唯一）。
- **设置页 = 触发器 + 状态显示器，不引入新服务端状态**（M8）：三个分区全部消费既有端点——节点名片（GET /api/sync/hello：nodeId/workspaceId/profileVersion/eventCount）、局域网同步（peers 表单 → POST /api/sync/run）、迁移（/export 下载 JSON 文件 + /import 上传，accepted/skipped/missingManifests 直出）。peers 不持久化在前端——每次随请求体发送，服务端 env（ONE_SYNC_PEERS）仍是唯一持久位。
- **v2+ 接缝（本次不做）**：编辑 SKU（改名/改扩展字段——改条码已有 AI 工具，缺界面）、库存流水展示页、冲突队列页。（M18 已落地：条码管理与扫码输入组件。）

## 测试策略（app）——jsdom + @testing-library/react

- **组件级**：ImpactReportView（severity 分色、items 直出）、ProposalDetail（确认按钮 → mock client 成功/409 两分支）、ToolInvocationCard（过程三态、查询结果三形态表格、ui.ask 挂起/回填、后置动作按钮——失败/执行中/无 onNavigate 不出按钮；profile.propose 成功不出按钮——确认收敛对话页面板）、SkuFormModal（type→控件映射、json 校验）、ScanInput（M18——空回车不触发、trim 规整、扫后清空续扫）。
- **页面 smoke**：ChatPage 走真实 ChatProvider + mock streamChatMessage（SSE 事件脚本化：工具卡回填、流式文本、error 落卡、ui.ask 挂起→回答/跳过 gate 时序、propose 成功 → 顶部待确认面板出现提议并可展开确认——配置确认页已并入对话页）；app-nav（navigate 切页、initialFilter 一次性消费）；SkusPage **动态列核心机制**（snapshot 含可见 spec + 隐藏 category → 表头有「规格」无「分类」；M18 加：条码列有码显码、无码行内显 `-`、新建表单收集条码（trim 后提交）；M20 加：安全库存列有值显值、0 显 `-`、表单收集 reorderPoint（>0 才提交））；OrdersPage / InventoryPage 列表渲染 + 提交 + 过滤框（关键字命中 + AI 跳转预填；M19 加：冻结三件套列渲染 + HoldModal——活动冻结可见（原因与分隔符同节点 → 子串匹配）、追加冻结提交体、Popconfirm 释放调 holdId；M20 加：安全库存列 + 「只看低库存」Checkbox 过滤掉充足 SKU）；ExpiryPage（M14，M15 进阶）mock useExpiryBoard——五层统计卡计数、剩余天数分形渲染（已过期 N 天 / 今天到期 / —）、库位列计数「N 库位」、行展开库位×余量明细（余量降序）、层过滤收敛、关键词过滤与空表、AI 跳转 skuCode 预填；SettingsPage（M8）mock 三组端点——节点名片渲染、同步回合结果、迁移导入结果；StocktakePage（业务补齐 17）mock 盘点组 hooks——清单渲染（状态 Tag/进度）、创建弹窗（全场/勾选库位提交体）、明细行录入提交与差异列渲染、关单确认与失效断言；AiConfigPage（M17）mock 配置组 hooks——状态卡三分支（未配置/已配置/来源）、必填校验不提交、保存提交体（ollama 无密钥字段且 baseUrl 选填）、测试连接成功/失败结果渲染、关闭 AI 二次确认。
- 不测 AntD 内部行为；不断言样式细节（只断语义角色与文本）。
