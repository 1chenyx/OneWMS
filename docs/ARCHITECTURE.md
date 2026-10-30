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
│  bus/tool-bus.ts             工具注册与分发                │
├─ 基础层 ─────────────────────────────────────────────┤
│  oplog/envelope.ts           事件信封（纯类型 + 构造）      │
│  registry/key-naming.ts      字段键命名（纯函数）           │
│  bus/schema-validator.ts     参数校验（纯函数）             │
│  db/migrations.ts            表结构（schema 唯一定义点）    │
│  errors.ts                   错误类型（纯类型）             │
└──────────────────────────────────────────────────────┘
```

## 依赖方向规则（白名单制）

1. **只能向下**：出口层 → 组合层 → 服务层 → 基础层。任何反向 import 禁止。
2. **服务层之间**：唯一许可的横向依赖是 `field-registry → oplog-store`——因为注册表是事件投影（§8 唯一真相纪律的代码化）。新增横向依赖必须在此登记理由。
3. **基础层互相无依赖**（errors.ts 不 import 任何东西，其余基础文件不互相 import）。
4. **领域隔离**：本包不得出现仓储词汇（SKU/库存/单据）——那是 `@one/wms` 的领地（§13.5 平台化口子）。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `core.ts` | 进程生命周期：open（建库/迁移/nodeId）、close、workspace() 工厂、领域装配口（exposeDb/exposeToolBus，§13.5 口子 1 的落点） | 不含任何业务逻辑 |
| `workspace/workspace.ts` | WorkspaceFacade：持有三个 View 实例 + replay() | 只组合与委托，不实现能力 |
| `workspace/events-view.ts` | 账本的工作区绑定视图：append/ingest/forEach/byActor/watermarks/count | 不做事件语义校验之外的任何业务判断 |
| `workspace/fields-view.ts` | 注册表的工作区绑定视图：provide/require/setVisibility/unregisterModule/list/get | 只绑定 wsId 并委托 FieldRegistry |
| `workspace/tools-view.ts` | 工具总线的工作区绑定视图 + 向 handler 注入 ToolContext（含 appendEvent 受控入口） | 不做业务校验（那是 handler 的事，§7 规则即护栏） |
| `oplog/oplog-store.ts` | 事件账本：事务内分配双时钟、幂等 ingest、(lamport,actor) 全序遍历、水位 | 不解释事件内容（对 payload 透明） |
| `registry/field-registry.ts` | 字段注册：命令侧冲突校验 → 落事件 → applyEvent 投影；卸载移交/软删除语义 | 不存储业务数据本身（只管字段元数据） |
| `bus/tool-bus.ts` | 工具注册表（进程内存态）+ invoke 三步：存在性→参数校验→handler | 不做业务校验、不落事件（事件由 handler 经 ctx 写） |
| `oplog/envelope.ts` | EventEnvelope 类型 + buildEnvelope 构造（uuid/时间戳/命名空间校验） | 不碰数据库 |
| `registry/key-naming.ts` | privatePrefix / qualifyKey：private 字段前缀化（§7.2 消撞名） | 无状态 |
| `bus/schema-validator.ts` | JSON Schema 子集校验（type/required/enum/min/max/items） | 无状态 |
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

服务层方法的第一参数恒为 `workspaceId`（§13.5 口子 2 的纪律）。View 在构造时绑定 workspaceId，调用方 thereafter 不再传——**纪律由类型系统代管，不靠开发者自觉**。三个 View 均为构造期创建的实例属性（非 getter），避免重复分配。

## 测试策略

- **服务层测试**（oplog.test.ts / fields.test.ts / tools.test.ts）：经 facade 走公共 API，验证内核行为契约。
- **集成测试**（workspace.test.ts）：多工作区并存、replay 重建、端到端链路。
- **稳定性守则**：公共 API 变更 = index.ts 导出变更 = 必须同步更新 DESIGN.md 对应章节。

## 未来生长点（与 DESIGN.md 对齐）

| 生长点 | 落点 | 备注 |
|---|---|---|
| 同步协议（里程碑 5） | 新建 `sync/` 服务层目录 | 消费 OplogStore 的 byActor/watermarks |
| 模块系统（里程碑 6） | 新建 `modules/` 服务层目录 | manifest 校验 → 驱动 FieldRegistry/ToolBus |
| 权限中间件 | ToolsView.invoke 的 handler 前插一层 | ctx.actor 已备（§10 预留） |

---

# @one/wms 领域包架构（里程碑 2）

> 领域包只准 import `@one/core` 的 index.ts（公共 API + 领域装配口）。

## 分层地图

```
┌─ 出口层 ─────────────────────────────────────────────┐
│  index.ts              公共 API 唯一出口              │
├─ 组合层 ─────────────────────────────────────────────┤
│  wms.ts               WmsDomain（装配）/ WmsWorkspace │
│                       （门面：追账 sync / 重放 replay）│
├─ 服务层 ─────────────────────────────────────────────┤
│  views/sku-view.ts         SKU 投影 + 查询            │
│  views/order-view.ts       单据投影（含冲突检测）+ 查询 │
│  views/inventory-view.ts   库存流水 + 汇总投影 + 查询  │
│  tools/wms-tools.ts        六个 wms.* 工具（护栏在此） │
├─ 基础层 ─────────────────────────────────────────────┤
│  events/catalog.ts         事件目录（类型 + 常量）     │
│  state/order-state-machine.ts  转移表 + 纯函数校验     │
│  db/migrations.ts          领域表（wms_ 前缀，uuid）   │
│  errors.ts                 领域错误族（继承 CoreError）│
└──────────────────────────────────────────────────────┘
```

## 关键机制

- **追账模型（投影是缓存）**：`WmsWorkspace` 持内存游标（已应用 lamport 高水位）。`sync()` 增量应用游标之后的 wms.* 事件；`replay()` 清空投影全量重建——两者走同一条 `applyEvent` 路径（迁移/修复/自检 = 同一动作）。构造期即全量追账一次，新进程打开旧库直接可读。
- **write 工具三步护栏**（缺一不可）：`ws.sync()`（校验前投影新鲜）→ 业务校验（编码唯一/SKU 存在/状态机合法/库存不为负）→ `ctx.appendEvent` + `ws.sync()`（返回新状态）。校验失败绝不落事件。
- **只有流水事件**（§8.2）：`wms_inventory` 汇总表的唯一写路径是 `InventoryView.applyEvent`；库存永远是「期初 + Σ流水」的派生视图。
- **并发冲突**（§8.3 唯一真冲突）：state_changed 的 from 与投影当前态不符 → v1 抛 `OrderStateConflictError` 停下；冲突队列 + 人工裁决是里程碑 5 的实现项。
- **依赖登记**：基础层内唯一许可的依赖是 `events/catalog.ts → state/order-state-machine.ts`（单向，纯类型——领域词汇表同源）。

## 每个文件的职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `wms.ts` | WmsDomain：attach 建领域表 + 注册工具 + workspace 工厂（同 id 缓存实例）；WmsWorkspace：六视图门面 + sync/replay | 不含业务校验（在工具 handler） |
| `views/sku-view.ts` | wms_sku 投影：applyEvent 幂等（id 查重早退，code 冲突显式炸）+ 查询 | 不解释非 wms.sku.* 事件 |
| `views/order-view.ts` | wms_order/order_line 投影：state_changed 的 from 一致性检查（冲突即抛）+ 查询 | 不做命令侧校验（那是工具的事） |
| `views/inventory-view.ts` | 流水（event_id 主键幂等）+ 汇总 UPSERT + 查询 | 无任何「直接改库存」入口 |
| `tools/wms-tools.ts` | 六工具：sku.create/update、order.create/transition、inventory.adjust/query；`def()` 包装器集中处理 handler 参数逆变 | schema 之外不碰总线内部 |
| `events/catalog.ts` | 事件名常量 + payload 类型 + isWmsEventType 分发过滤 | 无状态 |
| `state/order-state-machine.ts` | 转移表（in/out 两张）+ canTransition/assertTransition/transitionsFrom | 不落库、不读库 |
| `db/migrations.ts` | 五张 wms_ 表，IF NOT EXISTS 幂等建表 | 唯一允许领域 `CREATE TABLE` 的文件 |
| `errors.ts` | 七个领域错误（code 前缀 WMS_），继承 CoreError | 无状态 |

## 与内核的接缝

| 口子 | 方向 | 说明 |
|---|---|---|
| `@one/core` index.ts | wms → core | 全部内核能力消费 |
| `OneCore.exposeDb()` | core → wms | 建领域表 + 投影句柄（仅领域包装配期） |
| `OneCore.exposeToolBus()` | core → wms | 注册 wms.* 工具 |
| `ToolContext.appendEvent` | 工具 → 账本 | 工具写业务事件的唯一受控入口 |

## 测试策略（wms）

- **领域测试**（sku/orders/inventory.test.ts）：经工具总线走公共 API，逐条验证护栏（非法转移/负库存/重复编码均拒绝且零事件）。
- **端到端**（end-to-end.test.ts）：字段注册 → AI 工具链 → replay 重建一致；投影篡改被 replay 修正；多工作区隔离；文件库重开身份保持。
