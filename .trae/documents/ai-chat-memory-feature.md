# AI 聊天记忆功能实施计划

## Context

AI 聊天目前是无状态会话（server 内存 Session，关闭即失），每个新会话都要重新了解用户。本次引入**自动记忆**：对话结束后自动提取关键信息分层存储（personal = 用户个人偏好/习惯，project = 本仓库业务事实/约定），下次对话注入 System Prompt，让 AI 越用越懂用户。

**方案要点**（已按项目铁律设计）：
- 记忆是小型事件账本域：`memory.item.saved` / `memory.item.forgotten` 走 oplog（复用同步/重放/审计全链路），投影表 `memory_item`
- 新包 `@one/memory`（领域功能独立模块包铁律；`@one/ai` 保持纯编排层不碰 db/oplog）
- 工具走总线（人与 AI 共用通道）：`memory.list`(read) / `memory.save`(write) / `memory.forget`(write)
- 自动提取 = out-of-band：chat 路由 turn-done 后 fire-and-forget 后台 LLM 调用（不阻塞 SSE、失败静默）；同时 general 助手也拿到 save/forget 工具，用户说"记住 X"时可当场落账
- 设置：`core.memory` 模块 settings `{ autoMemory: true, maxMemoryItems: 200 }`，修改走慢通道 propose→confirm
- `source` 字段由 handler 从 actor 推导（`ai:memory-auto@nodeId`→auto、其他 `ai:*`→ai、其余→manual），防伪标

## 步骤 1：新包 packages/memory（照抄 WmsDomain 骨架）

新建（模式源：[wms.ts](file:///d:/my_project/demo/OneWMS/packages/wms/src/wms.ts)）：
- `package.json` / `tsconfig.json` / `vitest.config.ts`：镜像 packages/wms（deps 仅 `@one/core`；paths/alias 指向 `../core/dist`；prebuild/pretest/pretypecheck 先 `-w @one/core`）
- `src/events/catalog.ts`：`MEMORY_EVENT_TYPES = { itemSaved: 'memory.item.saved', itemForgotten: 'memory.item.forgotten' }` + `isMemoryEventType` + payload 类型（saved: `{memoryId, scope:'personal'|'project', content, source}`；forgotten: `{memoryId}`）
- `src/db/migrations.ts`：`migrateMemory(db)` 建表 `memory_item(id PK, workspace_id, scope, content, source, user_key NULL 预留, created_at, updated_at)`
- `src/views/memory-view.ts`：`MemoryView`（applyEvent：saved 幂等 upsert / forgotten DELETE；`list(scope?)`、`byId(id)`）
- `src/config/memory-settings.ts`：`readMemorySettings(ws)` 窄化兜底（照抄 [wms-settings.ts](file:///d:/my_project/demo/OneWMS/packages/wms/src/config/wms-settings.ts)），缺省 true/200
- `src/tools/memory-tools.ts`：三工具，write 护栏照抄 wms-tools 三步模式（sync → 校验 → appendEvent → sync）：content trim 非空 ≤500 字、scope 枚举、总量 ≥ maxMemoryItems 拒、forget 校验存在性；save 时 source 由 actor 推导
- `src/memory.ts`：`MemoryDomain.attach(core)`（migrateMemory + 注册工具 + manifest 派生注册）+ `MemoryWorkspace`（五视图 + memory 视图；`#cursor`/`#consumeEvents`/`sync()`/`replay()` 照抄 wms.ts:142-176；构造期 `modules.install` 种子，actor `module:core.memory@{nodeId}`）；manifest 带 settings schema（autoMemory/maxMemoryItems 含 default）
- `src/index.ts` 导出；`test/`：工具护栏逐条、投影幂等、重开库追账、replay 一致性、设置兜底

## 步骤 2：@one/ai 纯编排扩展（零运行时新依赖）

- `src/types.ts`：`AgentMemoryRef { id; scope: 'personal'|'project'; content }`（结构化类型，不依赖 @one/memory）
- `src/prompts.ts`：`AI_BEHAVIOR_RULES` 追加一条记忆规则（据已有记忆个性化作答；用户明确要求记/忘时用 memory.save / memory.forget）；新增 `MEMORY_EXTRACT_SYSTEM`（严格 JSON `{"save":[{"scope","content"}],"forget":[{"memoryId"}]}`；宁缺勿滥；与现有清单去重/修正）；`MAX_PROMPT_MEMORIES = 50`
- 新建 `src/memory-extract.ts`：`extractMemoryPlan(provider, { userText, assistantText, memories }) → MemoryPlan | undefined`——`completeTurn({system, messages:[{role:'user', text:拼装}], tools:[]})`（空 ToolSet 可行已核），剥 ```json 围栏、窄化、forget 的 memoryId 必须在现有清单中、单轮 save ≤5 条；assistantText 为空直接 undefined
- `src/system-prompt.ts`：`buildSystemPrompt(ws, memories?)`——行为规则段之后、Profile 摘要之前插「记忆」段（每行带 id：`- [personal]（#id） 内容`）；超 50 条截断 + 提示用 memory.list
- `src/wms-agent.ts`：`CreateAgentFromDefOptions` 加 `memories?: readonly AgentMemoryRef[]` 透传
- `src/index.ts` 导出；`test/`：提取（合法/围栏/非法 JSON/未知 id/超 5 条）、prompt 段位置与截断、options 透传

## 步骤 3：server 装配 + 路由 + 提取钩子 + 同步/迁移补漏

- `src/context.ts`：`MemoryDomain.attach(core).workspace(workspaceId)`，AppContext 加 `readonly memory: MemoryWorkspace`；`core.exposeModuleRegistry().registerManifest` + `install`（照 core.ai 模式，context.ts:69-71）
- 新建 `src/routes/memory.ts`：
  - `GET /api/memory`（sync 后直查投影，query scope 过滤）
  - `POST /api/memory` → `ctx.ws.tools.invoke('memory.save', body, \`user:local@${ctx.core.nodeId}\`)`（actor 模式照 [wms.ts:26](file:///d:/my_project/demo/OneWMS/packages/server/src/routes/wms.ts)）
  - `POST /api/memory/:id/forget`
  - `POST /api/memory/settings/propose`（照 [agents.ts](file:///d:/my_project/demo/OneWMS/packages/server/src/routes/agents.ts) 的 propose 模式，replace `/modules/core.memory/settings/...`）
- `src/index.ts`：挂载 `app.route('/api/memory', memoryRoutes(ctx))`
- `src/routes/chat.ts`：turn-done 提交历史后（chat.ts:134 `session.history = value.messages` 之后）fire-and-forget：`readMemorySettings.autoMemory` 关则跳过 → 取本轮末条 user 文本 + 末条 assistant 文本 → `extractMemoryPlan` → 逐条 `tools.invoke('memory.save'|'memory.forget', ..., \`ai:memory-auto@${ctx.core.nodeId}\`)`；全链 try/catch 静默 `console.error`；模块级 promise 链串行化防并发轮次交错
- **同步/迁移补漏**（Plan 代理发现的关键缺口）：
  - `src/sync/sync-client.ts:100` `ws.replayAll()` 后补 `memory?.replay()`（runSyncRound 加可选参数）；调用点 `index.ts` syncAllPeers 与 `routes/sync.ts` /run 传 `ctx.memory`
  - `routes/migration.ts:32` `ctx.ws.replayAll()` 后补 `ctx.memory.replay()`
- `packages/server/package.json`：deps 加 `@one/memory`；pretest/pretypecheck 加 `-w @one/memory`
- `test/`：路由读写分治（写落 oplog 可审计 actor）、chat 提取端到端（mock provider 出计划→落账；非法输出静默不断流）、同步摄入后 memory 投影可见

## 步骤 4：前端「记忆」页

- `api/client.ts`：镜像类型 `MemoryItem` + `api.memories / createMemory / forgetMemory / proposeMemorySettings`（模式照 [client.ts:343](file:///d:/my_project/demo/OneWMS/packages/app/src/api/client.ts)）；`api/hooks.ts` 加 useMemories（invalidate `['memories']`）
- `app-nav.tsx`：Page 类型加 `'memory'`；`App.tsx`：AI 组菜单项「记忆」+ 路由分支
- 新建 `pages/MemoryPage.tsx`：列表（scope Segmented 筛选、source Tag、updatedAt）+ 新增/删除（走 POST 端点）+ 设置卡（autoMemory Switch、maxMemoryItems 输入，提交后提示「已生成提议——请到配置确认页确认生效」并跳转 proposals，照 [AgentsPage.tsx](file:///d:/my_project/demo/OneWMS/packages/app/src/pages/AgentsPage.tsx) 慢通道 UX）

## 步骤 5：打包与工作区接线

- 根 `package.json`：build/test/typecheck scripts 加 `-w @one/memory`（置于 @one/core 之后）
- `packages/desktop/stage.ps1`：**三处**名单加 'memory'——17 行 New-Item 目录、19 行拷贝循环（'core','wms','ai','server'）、32 行 node_modules/@one junction 替换循环（'core','wms','ai'）
- 跑全量 `npm run typecheck` + `npm run test`

## 已知边界（接受，不做）

- 老库已配置过 settings.agents 的助手清单是显式快照，不会自动拿到 memory 工具——需在助手管理页手动勾选（内置三件套自动获得）
- 老助手 systemPrompt 已含行为规则快照？否——行为规则是代码常量非配置，自动生效；仅工具清单受上述限制
- 提取质量依赖模型：去重靠提取器看现有清单，溢出靠 maxMemoryItems 拒绝 + 管理页人工清理
- 多用户 user_key 仅建表预留，v1 恒 NULL（权限机制 v1 不实现的兼容口子）

## 验证

1. `npm run test -w @one/memory -w @one/ai -w @one/server`：新增测试全绿 + 既有测试不回归
2. 手动端到端：`npm run dev:server` + `npm run dev:app` → 配置 AI（Ollama 或 API）→ 聊天中说"我们仓库主要做电子产品，A001 是易碎品"→ 聊天结束后「记忆」页出现 personal/project 两条（source=auto）→ 新开会话说"帮我注意易碎品" → AI 回复体现记忆已注入（或从 server 日志确认 system prompt 含记忆段）→ 管理页手动删一条 → 再对话确认不再引用
3. 同步验证（如有双节点环境）：节点 A 对话产生记忆 → sync run → 节点 B「记忆」页可见
4. 桌面打包：`npm run package:desktop:fast` 冒烟（stage.ps1 三处名单生效，payload 含 @one/memory）
