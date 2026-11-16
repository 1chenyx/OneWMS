# 平台端交接（③）

> 读者是**另起的平台项目**。本文件是交接，按它写服务。
> 本仓库继续只做 ① 单机和 ② 私有部署。平台服务不进 `packages/server`。
> 决策日期：2026-11-16。前提已锁定，见 §1。身份模型见 §6。

引用格式为 `文件路径 :: 符号名`。行号会漂移，以符号名为准。

---

## 1. 已锁定的决定

**接受断网停工。** 平台是 `docs/DESIGN.md` §8.7 的模式 C：客户端不存业务库，数据与计算都在平台。仓库现场断网就不能出入库。

由此直接得出：

- 平台客户端不跑 oplog，不建本地 SQLite，不做离线队列。
- 不把 ③ 收编成「本仓库 + 多租户 + 对等同步」。`docs/EXTENSIBILITY.md` §8 的另一条路作废。
- 浏览器或壳只是登录后的 HTTP 客户端。多开一台电脑、多开一个浏览器，不发生账本同步。
- 登录、用户、角色做在平台自己的目录库里。不写进工作区账本，也不写入 Profile 的 `roles`。

---

## 2. 事件变多以后，新加设备会不会慢

**不会。** 平台上的「新设备」是一次登录，读的是平台上已经算好的投影（库存、单据、配置）。耗时与账本条数无关。

事件条数会变长的是平台进程自己的这几条路径，都发生在服务端：

| 路径 | 现在的做法 | 事件变多以后 |
|---|---|---|
| 日常一次出入库 | 追加一条事件，投影只应用这一条 | 不重放历史。条数上去仍然是追加 |
| 进程里第一次打开某个工作区 | `WmsWorkspace` 构造期 `sync()`，内存游标从 -1 起，把该工作区事件逐条幂等应用一遍。同进程再打开走缓存，不再扫 | 冷启动一次，耗时随条数涨。万级可忽略。进程活着的时候，后续请求不付这笔钱 |
| 投影版本戳变了（代码里的派生规则比库里新） | `ensureProjectionVersion` 清表再全量重放 | 该工作区一次变慢。发版时按工作区懒打开，不要在启动时把全部租户扫一遍 |
| 从单机迁入 | 迁移包是全量事件；导入后重放一次 | 一次性。账本到十万、百万时这次会明显变长 |
| 修复 | `WmsWorkspace.replayAll` 清投影、按全序重放 | 与迁入同量级，不是日常路径 |

①② 的对等同步是另一回事，平台客户端不走：新节点按 actor 从 seq 0 分页拉完全部事件（`SyncService.PAGE_SIZE = 500`），拉完只要有新事件就 `replayAll()` 整本重放。已有节点平时只拉差额，但只要吃进一条，投影仍是整本重放。这是 `packages/server/src/sync/sync-client.ts :: runSyncRound` 的现状。个人万级够用；公司级百万事件时，①② 的新节点加入会慢。快照引导在 `docs/DESIGN.md` §8.6 有设计，代码没做。平台模式 C 不需要它。

平台第一版要守住的性能纪律：

- **一个工作区在一个进程里只构造一次** `WmsWorkspace` / `MemoryWorkspace`，缓存到进程退出。按请求 new 一次就会按请求扫整本账。
- 发版或重启后懒打开：请求落到哪个租户，才付那一次冷扫描。不要启动时遍历全部租户。
- 账本到大约十万条、冷启动从「一秒内」变成「等人」之前，再做持久化的 lamport 游标或快照。第一版不做。checkpoint 在 `docs/DESIGN.md` 里程碑风险里写明 v1 可暂缓，平台把这条记成规模门槛，不记成开工项。

---

## 3. 两个仓库各做什么

| | 本仓库 OneWMS | 新项目（平台） |
|---|---|---|
| 进程 | `@one/server`：启动时绑死一个 `ONE_WORKSPACE`，一个 `ctx` | 网关按请求解析租户。不复用 `createServer()` |
| 库 | 每节点一个 SQLite | 目录库 `platform.db` + 每个工作区一个 SQLite。Postgres 等到 Phase P |
| 身份 | 无登录，`user:local@{nodeId}` | 账号、会话、成员、四档角色。见 §6 |
| 客户端 | `packages/app` 与后端同源，没有登录页 | 复用 `packages/app`。登录页第一版由平台提供，或用 HTTP 客户端把服务跑通 |
| 领域 | `@one/core`、`@one/wms`、`@one/ai`、`@one/memory` | **依赖这些包，不复制业务规则** |

平台不拷贝的东西：`packages/server` 的 Hono 路由闭包、对等同步（`/api/sync`）、局域网地址、`peers.json`、Tauri 壳、sidecar 打包、单机文件备份（`/api/backups`）。

平台新增、本仓库故意没有的东西：TLS、注册登录、成员与角色、订阅计费的配额挂钩、按工作区把请求钉到持有该文件的进程。

`packages/app` 今天不会带会话。服务按 §6、§7 的 HTTP 实现，并用 curl 或测试验。等本仓库做完 API base URL（`docs/EXTENSIBILITY.md` A.1）后，前端再补三件事：登录页、`fetch` 带上 cookie、工作区切换。不要为了迁就「现在的前端没登录」而把仓储接口改成匿名。

---

## 4. 第一版怎么接内核

`@one/core` 今天直接使用 better-sqlite3，存储接口还没抽出来。Phase P（`docs/EXTENSIBILITY.md` §6）抽 `EventStore` / `ProjectionStore` / `RegistryStore` 之后，平台才能换 Postgres。那是后话，不挡住第一版。

两套库，不要混：

| 库 | 路径 | 放什么 |
|---|---|---|
| 目录库 | `{dataDir}/platform.db` | 用户、会话、工作区登记、成员、聊天触发审计。一个平台进程一份 |
| 工作区库 | `{dataDir}/workspaces/{workspaceId}/onewms.db` | 该租户的 oplog 与投影。`workspaceId` 就是信封里的那个 id |

第一版可以是**一个 Node 进程**同时打开目录库和多个工作区文件。约束是「一个工作区文件只被一个进程打开」，不是「一个进程只能打开一个文件」。

扩到多进程时：目录库只由网关写；工作区文件仍只由一个工作进程打开；网关把该工作区的请求（含聊天 SSE）钉到那个进程。工作进程不接受来自公网的身份头。网关校验完会话后，用内网令牌 `ONE_INTERNAL_TOKEN` 带上已经解析好的 `userId`、`role`、`workspaceId`。公网请求里如果自己写了这些头，网关丢掉。

请求在进领域之前按这个顺序处理：

1. 公开路由（§6.4、健康检查、入站 webhook）直接进。
2. 校验会话。没有或过期 → `401 UNAUTHENTICATED`。
3. 定工作区（§6.5）。定不了 → `409 WORKSPACE_REQUIRED`。不是成员 → `404 WORKSPACE_NOT_FOUND`。
4. 按角色看这一个动作允不允许（§6.6）。不允许 → `403 FORBIDDEN`。
5. 配额（§9）。超限 → `429 QUOTA_EXCEEDED`。
6. 取出缓存的工作区门面，调领域。人的写操作走工具总线。actor 用 §5 的格式，从会话里的 `userId` 拼，不从客户端要。

写确认令牌今天在进程内存（`packages/server/src/tool-confirm.ts`，TTL 5 分钟，绑定 workspaceId + toolId）。一工作区一进程时可以沿用内存。令牌还要绑定 `userId`：确认请求的人和申请的人必须是同一个。拆成多进程共享同一工作区之前，先把令牌放进该工作区的库。

Postgres 立项时（Phase P，做在本仓库）：本仓库留 `SqliteEventStore`，平台写 `PostgresEventStore`。seq / lamport 必须在数据库事务里对计数行 `SELECT … FOR UPDATE` 再加一，不能放进程内存。领域逻辑继续不写 SQL 方言。`dyn_index` 已是普通表，不要用生成列。

---

## 5. 账本纪律（跨仓库，改了就不能对账）

信封是 `packages/core/src/oplog/envelope.ts :: EventEnvelope`：

- `eventId`：uuid。幂等键。
- `workspaceId`：租户边界。跨工作区事件拒绝写入。
- `actor` + `seq`：唯一约束 `(workspace_id, actor, seq)`。每条 actor 通道只有一个写者。
- `lamport`：全序是 `(lamport, actor)`。单权威下它就是该工作区的单调计数，仍然要写进信封，重放顺序靠它。
- `type`：`领域.实体.动作`，过去时。事件是事实，重放不再做业务裁决。
- `payload`、`createdAt`。`appVersion` 只用于排查，不参与校验，也不进通道指纹。

纪律：

- 只有追加。不提供改事件、删事件的 API。订正 = 再追加一条补偿事件。改历史事件会让通道指纹全变。
- 业务主键用 uuid 或业务编码，不用数据库自增整数。
- 人写成 `user:{userId}@{nodeId}`。`userId` 与 `nodeId` 都是 uuid，中间恰好一个 `@`。`nodeId` 存在工作区登记上，创建工作区时生成一次，进程重启不换。它不是浏览器，也不是用户。
- 模块种子保持 `module:{manifestId}@{nodeId}`。对话里模型调用工具保持 `ai:{agentId}@{nodeId}`。人点按钮、人确认配置，用 `user:{userId}@{nodeId}`。
- 外部系统入站 webhook 的 actor 保持现有字符串 `integration:{connectorId}`，不要改成用户，也不要加 `@nodeId`。`connectorId` 匹配 `packages/wms/src/integration/ids.ts :: CONNECTOR_ID_PATTERN`，里面没有 `@`。
- 从单机迁入的旧事件永远是 `user:local@{旧nodeId}`。原样保留。迁入之后的新事件才用平台用户。

哪个用户让助手调了工具：账本里仍然是 `ai:{agentId}@{nodeId}`（与本仓库对话通道一致）。平台在目录库另记一行审计，列是 `user_id`、`workspace_id`、`agent_id`、`tool_id`、`created_at`。这行不进 oplog。第一版聊天路由在工具真正执行前写下这一行即可，不要求事后回填 eventId。

---

## 6. 账号、成员、角色

SaaS 的「用户」和「角色」是平台目录里的成员关系，不是仓库配置。

内核里的 `ConfigState.roles` 类型是 `Record<string, never>`，`packages/core/src/profile/validate.ts` 对任何非空 `roles`、任何打到 `/roles` 的补丁返回 `ROLES_FROZEN`。助手上的 `allowedRoles`（`packages/ai/src/agent-defs.ts :: AgentDefinition`）只透传，服务端不消费。字段按角色可见、流程条件里的 `permission:`，都还没做。

所以第一版：

- 不解冻 `profile.roles`，不往账本里写角色事件。
- 不把角色做成客户可配的 JSON。四档固定角色，网关在调用工具总线之前拒绝。
- 助手定义继续由管理员在配置里改工具清单。角色决定这个人能不能用写工具、能不能确认配置；不靠 `allowedRoles`。

以后若要「某个扩展字段只给某角色看」，那是本仓库解冻 `roles` / 新增 `visibleV2` 的事，单独立项。平台第一版不要提前做。

### 6.1 三个对象

| 对象 | 存在哪 | 含义 |
|---|---|---|
| 用户 `user` | `platform.db` | 登录身份。一个邮箱一个用户，可加入多个工作区 |
| 工作区 `workspace` | 登记在 `platform.db`，账在自己的 `onewms.db` | 一个租户。id 等于信封 `workspaceId` |
| 成员 `membership` | `platform.db` | 某个用户在某个工作区的一档角色。同一对只一行 |

用户表：`id` uuid 主键，`email` 小写唯一，`password_hash`，`display_name`，`created_at`。密码用 argon2id。库里不存明文。邮箱去掉首尾空白再转小写。显示名 1～40 字。密码 8～72 字符。

工作区表：`id` uuid，`name` 1～40 字，`node_id` uuid（actor 后缀，创建后不变），`status` = `active` | `deleted`，`created_at`。

成员表：`(workspace_id, user_id)` 主键，`role`，`created_at`。每个工作区恰好一名 `owner`。

会话表：`id` uuid，`user_id`，`token_hash`（sha256，不存原令牌），`workspace_id` 可空（当前工作区），`expires_at`，`created_at`。有效期 14 天，到期重新登录，不做滑动续期。

聊天触发审计表：`id`，`user_id`，`workspace_id`，`agent_id`，`tool_id`，`created_at`。

这些表的增删不产生 oplog 事件。「谁把货发出去」在账本里，「谁是管理员」在目录库里。

### 6.2 四档角色

| id | 名称 | 能做的事 |
|---|---|---|
| `owner` | 所有者 | 管理员的全部，加上转让所有权、停用工作区 |
| `admin` | 管理员 | 作业员的全部，加上成员（除所有者）、确认配置、AI 模型与密钥、对接密钥、迁入迁出 |
| `clerk` | 作业员 | 仓储业务的读和写：单据、库存、主数据、盘点、记忆正文。不能改系统配置，不能管人 |
| `viewer` | 只读 | 读投影、调用 `permission === 'read'` 的工具。不能写业务，不能确认配置 |

注册工作区的人是 `owner`。没有「没有角色的成员」。

权限高的人覆盖低的人：查允许时按 `owner > admin > clerk > viewer`。

### 6.3 动作分四类

网关先给请求分类，再套角色。分类规则就这一张，不要按每个 URL 再发明例外，除了表里点名的几条。

| 类 | 包含 | 最低角色 |
|---|---|---|
| 公开 | §6.4 的认证接口、`GET /api/health`、`POST /api/integrations/:connectorId/:routeId` | 无会话。webhook 走连接器自己的鉴权（`packages/wms/src/integration/auth.ts`），不走登录 |
| R 读 | 业务、档案、界面、记忆、助手清单、AI 配置状态的 GET；`permission === 'read'` 的 `POST /api/tools/:id/invoke`；`POST /api/reports/run` 与 `POST /api/reports/preview` | `viewer` |
| W 业务写 | `/api` 下仓储的 POST / PUT / PATCH / DELETE；`/api/dyn` 的 POST / PATCH / DELETE；记忆的 `POST /`、`/rewrite`、`/remove`、`/consolidate`；其余 `permission === 'write'` 且不属于 C 的工具 invoke 与 confirm | `clerk` |
| C 配置 | `profile.propose`；`POST /api/proposals/:id/confirm` 与 `reject`；`POST /api/agents/propose`；`/api/ai-config` 的 PUT / PATCH / POST / DELETE；`/api/memory/settings/propose`；`/api/integrations` 的 `/check`、`/secrets`；`/api/migration` 的 export 与 import；`POST /api/reports` 与 `DELETE /api/reports/:id`；成员接口 | `admin` |
| O 所有权 | 转让所有者、`DELETE /api/workspaces/current` | `owner` |

对话：按上面同一套过滤。只读用户的模型只能看见读工具；即使用户选了「通用助手」，服务端在把工具交给模型之前拿掉全部 `permission === 'write'`。作业员拿掉 `profile.propose`。确认配置的请求再查一次角色，不信任当时发给模型的清单。

`GET /api/ai-config` 只返回是否配了密钥（本仓库的 `apiKeySet`），任何成员可看。密钥的值任何角色的 HTTP 响应里都不出现。

### 6.4 认证接口

响应失败时正文是 `{ "code", "message" }`，用 HTTP 状态表示成败。成功时没有 `code`。

令牌是 32 字节随机数，base64url。响应里出现一次，库里只存 sha256。浏览器同时收 cookie `one_session`：`HttpOnly`、`Secure`、`Path=/`、`SameSite=Lax`（前端与 API 不同站时改为 `None`，且 CORS 允许该来源并带凭证）。非浏览器把同一令牌放在 `Authorization: Bearer`。两条都认。

| 方法与路径 | 谁能调 | 行为 |
|---|---|---|
| `POST /api/auth/register` | 公开。`ONE_OPEN_REGISTRATION=0` 时改为 `403 REGISTRATION_CLOSED` | 正文 `{ email, password, displayName, workspaceName }`。创建用户、工作区、owner 成员、会话，并把会话的当前工作区设为刚创建的。邮箱已存在 → `409 EMAIL_TAKEN` |
| `POST /api/auth/login` | 公开 | 正文 `{ email, password }`。密码不对或用户不存在都返回同一个 `401 UNAUTHENTICATED`，文案不区分。成功返回会话，当前工作区：若只有一个成员身份就选中它，否则为 null |
| `POST /api/auth/logout` | 有会话 | 删除这一条会话。没有会话也返回 204 |
| `GET /api/auth/me` | 有会话 | `{ user: { id, email, displayName }, workspace, memberships }`。`workspace` 是当前工作区 `{ id, name, role }` 或 null。`memberships` 是 `{ workspaceId, name, role }[]`，不含已停用的工作区 |
| `POST /api/auth/password` | 有会话 | 正文 `{ oldPassword, newPassword }`。旧密码不对 → `401 UNAUTHENTICATED`。成功后保留本条会话，删掉该用户的其他会话 |

`POST /api/auth/register` 与 login 成功时的正文：

```json
{
  "token": "<只此一次>",
  "user": { "id": "...", "email": "a@b.c", "displayName": "张三" },
  "workspace": { "id": "...", "name": "一号仓", "role": "owner" },
  "memberships": [{ "workspaceId": "...", "name": "一号仓", "role": "owner" }]
}
```

login 在用户有多个工作区且还没选定当前工作区时，`workspace` 为 null，`memberships` 仍给全。

第一版没有邮箱验证，也没有「忘记密码」邮件。管理员可以给本工作区里非所有者的成员直接设新密码（下一节）。这是已知取舍：管理员填了一个已经注册过的邮箱，就会把那个账号加进仓库。不要再做一个「试邮箱是否存在」的公开接口。

### 6.5 当前工作区

现有前端的路径是 `/api/...`，没有工作区 id。平台保持这些路径不变，工作区放在会话上。

- 请求头 `X-Workspace-Id` 若存在，必须是该用户的一个 active 成员身份，用它作为本请求的工作区，并写回会话。不是成员 → `404 WORKSPACE_NOT_FOUND`。
- 没有这个头：用会话里记住的 `workspace_id`。
- 两边都没有：用户恰好一个工作区就用它；否则 `409 WORKSPACE_REQUIRED`，正文附上 `memberships`，与 `/api/auth/me` 同形。
- `POST /api/session/workspace`，正文 `{ workspaceId }`，规则与请求头相同。成功 204。
- `GET /api/workspaces`：该用户的 `memberships`。
- `POST /api/workspaces`，正文 `{ name }`。任何已登录用户可再建一个工作区，自己成为 owner。受配额限制。

已停用的工作区：成员接口与业务接口都返回 `410 GONE`。

### 6.6 成员接口

都相对于当前工作区。调用者至少是 `admin`，所有者专属的在表里标出。

| 方法与路径 | 规则 |
|---|---|
| `GET /api/members` | 返回 `{ members: [{ userId, email, displayName, role, createdAt }] }`。不含密码哈希 |
| `POST /api/members` | 正文 `{ email, role, displayName?, password? }`。`role` 只能是 `admin`、`clerk`、`viewer`。邮箱已是用户：加上成员身份，忽略 `password`，不修改对方密码。邮箱还不是用户：`password` 与 `displayName` 必填，创建用户再加入。已是本工作区成员 → `409 ALREADY_MEMBER`。成员数达到配额 → `429 QUOTA_EXCEEDED` |
| `PATCH /api/members/:userId` | 正文 `{ role }`。不能把任何人改成或改离 `owner`。管理员不能改所有者的角色。目标不是本工作区成员 → `404 NOT_FOUND` |
| `DELETE /api/members/:userId` | 从本工作区移除。不能移除所有者。不能移除自己（用离开接口）。管理员不能移除另一名管理员；所有者可以。移除后删掉该用户会话里指向本工作区的 `workspace_id`（置空） |
| `POST /api/members/leave` | 任何成员退出本工作区。所有者在转让之前调用 → `409 LAST_OWNER` |
| `POST /api/members/:userId/password` | 正文 `{ newPassword }`。所有者可重置本区任何人。管理员可重置 `admin` / `clerk` / `viewer`，不能重置所有者。成功后删掉目标用户的全部会话 |
| `POST /api/members/transfer-owner` | 仅所有者。正文 `{ userId }`。对方必须已是本区成员。一个事务里：对方变成 `owner`，调用者变成 `admin`。工作区始终一名所有者 |
| `DELETE /api/workspaces/current` | 仅所有者。将 `status` 置为 `deleted`。不删除 `onewms.db` 文件。第一版不提供 HTTP 物理删除，清文件是运维操作 |

成员变更写目录库，不写 oplog。

---

## 7. 业务 HTTP 契约

OpenAPI 还没有（`docs/EXTENSIBILITY.md` A.3 暂缓）。契约就是本仓库这些路由文件的行为。平台按它们重新实现，并在外面套上 §6 的会话和角色。路径与状态码保持一致，前端按这些码分支。

挂载点在 `packages/server/src/index.ts`：

| 前缀 | 文件 | 平台 |
|---|---|---|
| `/api` | `routes/wms.ts` | 要。读是 R，写是 W。报表的保存与删除是 C，运行与预览是 R |
| `/api/dyn` | `routes/dyn.ts` | 要。读 R，写 W |
| `/api/tools` | `routes/tools.ts` | 要。读工具 R；业务写工具 W；`profile.propose` 是 C。写操作先 202 令牌，再 confirm，确认人必须是申请人 |
| `/api/ui` | `routes/ui.ts` | 要。R |
| `/api/profile` | `routes/profile.ts` | GET 是 R。`POST /propose` 是 C |
| `/api/proposals` | `routes/proposals.ts` | GET 是 R。confirm / reject 是 C。确认权在人，不交给 AI |
| `/api/chat` | `routes/chat.ts` | 要。按 §6.3 过滤工具。SSE 跨源要单独验。触发审计见 §5 |
| `/api/agents` | `routes/agents.ts` | GET 是 R。`POST /propose` 是 C |
| `/api/ai-config` | `routes/ai-config.ts` | GET 是 R。写是 C。存储换掉：今天是工作区旁边的 `ai-config.json`，不进账本。平台按工作区存，密钥不明文进迁移包，也不可进任何 GET 响应 |
| `/api/memory` | `routes/memory.ts` | GET 是 R。正文写与整理是 W。`settings/propose` 是 C。记忆事件在账本里，会随迁移包走 |
| `/api/integrations` | `routes/integrations.ts` | `/check` 与 `/secrets` 是 C。`POST /:connectorId/:routeId` 是公开 webhook，不套登录。对接调度按租户跑，并受配额限制。actor 见 §5 |
| `/api/migration` | `routes/migration.ts` | export 与 import 都是 C |
| `/api/auth`、`/api/session`、`/api/members`、`/api/workspaces` | 本仓库没有 | 平台新增，见 §6 |
| `GET /api/health` | 本仓库没有 | 平台新增。无会话，返回 `{ "ok": true }`。不碰工作区库 |
| `/api/sync` | `routes/sync.ts` | **不要。** hello / 拉事件 / peers / 局域网地址是 ①② 的对等协议 |
| `/api/backups` | `routes/backups.ts` | **不要。** 那是本机 SQLite 文件的滚动备份。平台用自己的库备份 |

本仓库还没做、平台一接现有前端就必须有的一项：`packages/app` 的 API base URL（`docs/EXTENSIBILITY.md` A.1）。今天全部 `fetch` 相对路径，默认与后端同源。平台侧同时要配 CORS，来源包括浏览器域名；若桌面壳直连平台，还包括 `tauri://localhost`。聊天 SSE 的跨源单独验，不要只验 JSON。

---

## 8. 迁入

单机导出 `GET /api/migration/export`，得到 `packages/core/src/migration/migration-service.ts :: MigrationBundle`。平台上这个接口是 C，只有管理员和所有者能调。

- `kind = onewms-migration-bundle`，`bundleVersion` 必须落在 `[MIGRATION_BUNDLE_MIN_VERSION, MIGRATION_BUNDLE_VERSION]`，当前都是 1。
- `events` 已按 `(lamport, actor)` 排好。
- 导入 = 校验包内 `workspaceId` 等于当前工作区 → `OplogStore.ingest`（eventId 已存在则跳过）→ 打开工作区触发重放。重复导入零新事件。包里的工作区 id 对不上 → `409 WORKSPACE_MISMATCH`，一行不写。

迁入带不走的东西（不在包里，平台当新数据）：

- `ai-config.json`（模型与密钥）
- `chat-threads.json`（对话存档）
- `peers.json`（对等节点，平台不需要）
- `integration_secret` 表（`packages/wms/src/integration/secrets.ts` 写明不进 oplog）
- 平台目录库里的用户、成员、会话。迁入不创建登录账号

迁入是一次性全量重放，账本很大时慢在这里。见 §2。旧事件的 actor 保持 `user:local@...`，见 §5。

---

## 9. 配额

租户提交的 JSON（实体、字段、流程、页面）会直接改变服务端行为。上限做在平台，不做在本仓库。超限在写入前拒绝，正文 `{ "code": "QUOTA_EXCEEDED", "message", "quota" }`，状态 429。不执行任何租户提交的代码。

第一版就卡这些数，默认值写死成常量，改常量即可，先不做计费表：

| 配额 | 默认 |
|---|---|
| 一个用户名下拥有的工作区（自己是 owner） | 3 |
| 一个工作区的成员数 | 50 |
| 单租户声明式实体数、每个实体的字段数、页面数 | 各 30 |
| 单次迁移包的事件条数 | 200000 |
| 事件追加 | 每个工作区每分钟 600 条 |
| 对接连接器数量 | 20 |

流程与条件 DSL 的复杂度上限先留名字，不实现：条件 DSL 尚未排期。订阅计费以后只改变这些数字，不改变 §6 的角色。

---

## 10. 平台第一版不做

- 客户端离线账本、发件箱、与平台对账后再入库
- 浏览器之间的对等同步，以及 `/api/sync`
- 在本仓库的 `@one/server` 里做多租户或登录
- 解冻 `profile.roles`，或让客户自定义角色、按角色隐藏字段
- 消费助手定义上的 `allowedRoles`
- 改已落盘事件的 actor 或 payload
- 邮箱验证、忘记密码邮件、验证码登录
- 为了平台去提前重写本仓库全部 SQL（Phase P 按 §4 的门槛再做）
- 零知识加密。迁移包和账本在平台侧是明文。工作区密钥体系已从本仓库移除
- 用 HTTP 把已停用工作区的 `onewms.db` 删掉

---

## 11. 开工顺序（新项目）

1. `platform.db`：注册、登录、退出、`/api/auth/me`、改自己的密码。用测试证明错密码与不存在的邮箱是同一个 401。
2. 创建工作区、成员四档、当前工作区、§6.6 的转让与「最后一名所有者不能退出」。
3. 一工作区一 SQLite，进程内缓存工作区门面。请求顺序按 §4。角色不够的写得到 403，工具总线没有被调用。
4. 按 §7 的「要」表实现业务 HTTP。只读用户调写工具被拒；作业员能入库但不能 confirm 配置；管理员能确认配置但不能转让所有权。
5. 迁入：管理员吃一份真实的 `onewms-migration-bundle`，重放后库存与单据和源节点一致；再迁一次，事件数不增加。作业员调迁入得到 403。
6. 配额按 §9。成员数、迁移包条数先做。
7. webhook：不带登录 cookie，连接器鉴权失败时不写账。
8. 等某个租户冷启动或并发写超出单文件，再回到本仓库做 Phase P，平台换 Postgres。在那之前不要在平台项目里复制一套仓储规则。
