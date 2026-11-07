# OneWMS 0 基础用户可用性改进方案

## Context

以"0 基础个人仓库管理用户"视角评审发现五大痛点，用户已确认全部修复：

1. **README 快速开始是坏的**：`npm install` → `dev:server` 报 `ERR_MODULE_NOT_FOUND @one/memory`（server-err.log 实锤，workspace 包 exports 指向 dist/，须先 build）
2. **AI 未配置无引导**：ChatPage 仅红字提示，无跳转
3. **无自动备份**：唯一手段是手动导出 JSON 事件包，且不含 ai-config.json；桌面版硬杀 node 进程
4. **组网门槛高**：peers 不持久化（env 唯一持久位）、手填 URL、workspaceId 不一致报错难懂
5. **无发布渠道**：无 tag、无 CI、无 Release，0 基础用户拿不到免构建安装包

用户决策：全部五项；备份=定时滚动（默认每天、保留 7 份、含 ai-config）；发布=GitHub Actions 推 tag 自动构建。

已核实的关键事实：
- 服务端 `serve({fetch, port})` 无 hostname（默认 0.0.0.0），LAN 同步网络层可达
- `@one/server` 已有 `pretest`/`pretypecheck` 先构建依赖的先例（package.json L13-14）
- 前端无路由库，跳转 = `useAppNav().navigate(page)` state 切页；`Page` 类型含 `'ai-config'`
- `useAiConfig()` hook 已存在；antd 5.29.3 自带 `<QRCode/>` 零新增依赖
- `ai-config-store.ts`（resolveAiConfigPath/parseAiConfigInput/写文件，`:memory:` → null）是 C/D 两个新 store 的模式范本
- 恢复管线现成：`importBundle`（幂等，eventId 查重）+ `ws.replayAll()` + `memory.replay()`；`applyAiConfig`（context.ts:91）支持热更 provider
- relay 已在 v0.2 移除，`.env.example` L21-22 为残留
- better-sqlite3 12.11.1 带 prebuild-install，CI Node 22 免编译
- **补充发现**：`.gitignore` 只忽略 `*.db*`，`data/ai-config.json`（含明文 apiKey）会被误提交 → 加 `data/`

约束：Windows/PowerShell 环境，脚本与文档禁用 `&&`。

---

## A. 修 README 快速开始（P0）

| 文件 | 操作 |
|---|---|
| `packages/server/package.json` | scripts 加 `"predev": "npm run build -w @one/core -w @one/wms -w @one/memory -w @one/ai"`（与 pretest 同构，npm 自动跑 workspace 包 pre 钩子，根脚本 dev:server 无需改） |
| `README.md` | 快速开始加 `npm run build` 一步（与 predev 幂等兼容）；"约 15MB" → "约 46MB（内嵌 Node.js 运行时）" |
| `.env.example` | 删 ONE_RELAY_URL/ONE_RELAY_INTERVAL_MS 两行残留，标题改"多节点同步（可选）" |
| `.gitignore` | 加一行 `data/` |

## B. AI 首次引导（P0，纯前端，不建新页面）

| 文件 | 操作 |
|---|---|
| `packages/app/src/chat/ChatProvider.tsx` | `ChatTurn` 加可选 `failedCode?: string`；catch `ApiError` 时在 patchLast 带上 `e.code` |
| `packages/app/src/pages/ChatPage.tsx` | ① `useAiConfig()` 加载完成且 `configured === false` 时顶部渲染 `<Alert>` 引导卡 + 「去配置」按钮（`navigate('ai-config')`）；② `turn.failed` 红字旁，`failedCode === 'AI_NOT_CONFIGURED'` 时加「去配置」Typography.Link。AiConfigPage 保存后已有缓存失效，返回自动消失 |
| `packages/app/test/pages.test.tsx` | 新用例：mock useAiConfig 未配置 → 引导卡可见；已配置 → 不渲染 |

## C. 自动备份：定时滚动（P0，最大块）

| 文件 | 操作 |
|---|---|
| `packages/server/src/backup/backup-service.ts` | **新增**：核心逻辑 |
| `packages/server/src/routes/backups.ts` | **新增**：API 路由 |
| `packages/server/src/context.ts` | options 加 `backupDir?: string \| null`，缺省由 `resolveBackupDir(dbPath)` 推导；字段 `backupDir: string \| null` |
| `packages/server/src/index.ts` | 注册路由 + 启动备份定时器 + shutdown 清理 |
| `packages/server/test/backups.test.ts` | **新增** |
| `packages/app/src/api/settings-api.ts` / `hooks.ts` | backup API 客户端 + useBackups/useCreateBackup/useRestoreBackup/useDeleteBackup |
| `packages/app/src/pages/SettingsPage.tsx` | Tabs 加「备份」Tab |
| `packages/app/test/settings.test.tsx` | 新用例 |

设计决策：
1. **备份格式**：单 JSON 信封 `{ kind:'onewms-backup', backupVersion:1, createdAt, bundle: MigrationBundle, aiConfig?: AiProviderConfig }`——bundle 原样内嵌，恢复零转换；aiConfig 备份时未配置则无字段（恢复时不动现有 AI 配置，防"恢复数据顺带关 AI"）
2. **文件名编码事件数**：`onewms-backup-<compactISO>-e<eventCount>.json`——列表接口只 readdir+stat 不解析大 JSON；文件名字典序=时间序，滚动清理直接排序截断
3. **目录/开关**：`resolveBackupDir(dbPath, env)` 完全类比 resolveAiConfigPath：ONE_BACKUP_DIR 可覆盖、`:memory:` → null（禁用，GET 返回 `enabled:false`，POST 503 `BACKUP_DISABLED`）；`ONE_BACKUP_INTERVAL_MS` 默认 86400000（0=关闭）、`ONE_BACKUP_KEEP` 默认 7（最小 1）
4. **定时器（重启不重复备份）**：`lastBackupAtFromDir` 读目录内最大文件名解析时间戳；启动 `delay = last===0 ? interval : max(0, last+interval-now)` 先 setTimeout 再 setInterval——桌面版每天首开自动补备份、一天内重启不重复、空库等一个完整周期。写入用 temp+rename 原子落盘，prune 顺带清理 `.tmp-*` 孤儿（Tauri 硬杀最坏残留 tmp 不损坏备份）
5. **恢复（运行中不重启）**：`POST /api/backups/:name/restore`：文件名正则校验（防穿越）→ 读文件+kind 校验 → `importBundle` → accepted>0 时 replayAll+memory.replay → 若备份含 aiConfig 且 ctx.aiConfigPath 非 null：writeAiConfigFile + `applyAiConfig(cfg,'file')` 热更 → 返回 `{accepted,skipped,replayed,aiConfigRestored}`
6. **路由形状**：`GET /api/backups`（列表+enabled/intervalMs/keep，新到旧）、`POST /api/backups`（立即备份+滚动清理）、`POST /:name/restore`、`DELETE /:name`；错误码 BACKUP_DISABLED/BACKUP_NOT_FOUND/BACKUP_INVALID/BACKUP_NAME_INVALID
7. **BackupTab UI**：Table（时间/事件数/大小）+「立即备份」+ 行操作「恢复」（modal.confirm，文案说明幂等）/「删除」（Popconfirm）；enabled=false 显示说明文案。useRestoreBackup onSuccess 失效缓存集合抄 useMigrationImport

测试（照 ai-config.test.ts mkdtemp 模式 + migration.test.ts 双 app 断言）：创建后文件/命名/内容校验；伪造 9 个备份→只剩 keep 个；写数据→备份→restore→投影一致；重复 restore 幂等；:memory: 禁用分支；`:name` 穿越 400。

## D. 扫码组网（P1）

| 文件 | 操作 |
|---|---|
| `packages/server/src/sync/peer-store.ts` | **新增**：peers.json 持久化 |
| `packages/server/src/context.ts` | 加 `peersPath: string \| null`、`listeningPort: number \| null` |
| `packages/server/src/routes/sync.ts` | peers CRUD + lan-address + /run 合并源 |
| `packages/server/src/index.ts` | sync loop 常驻 + 每轮动态合并 peers；serve 回调记 port |
| `packages/server/test/sync-peers.test.ts` | **新增** |
| `packages/app/src/api/settings-api.ts` / `hooks.ts` | useLanAddress/useSyncPeers/useAddPeer/useRemovePeer |
| `packages/app/src/pages/SettingsPage.tsx` | NodeTab 加二维码；SyncTab 重写 |
| `packages/app/test/settings.test.tsx` | 新用例 |

设计决策：
1. **不加 CORS，握手一律由本端 server 发起**——B 端浏览器直连 A 会被同源策略拦；加 hono/cors 要求两端同时升级（版本偏斜地狱）且放大 LAN 探测攻击面。前端只跟本端同源通信，跨节点信任收敛在既有 server↔server 通道
2. **peer-store**（类比 ai-config-store）：`{version:1, peers:[{url, nodeId?, addedAt}]}`；`normalizePeerUrl`（http(s) 校验、host 小写、去尾斜杠，失败给中文 message）；损坏/不存在 → `[]` 不阻断启动
3. **路由**：`GET /api/sync/peers`；`POST /api/sync/peers {url}`（normalize→server fetch 对端 hello：不可达 502 SYNC_PEER_UNREACHABLE / workspaceId 不一致 422 SYNC_PEER_MISMATCH（中文文案：本地 X 对端 Y）→ 通过则落盘+记录 nodeId+立即跑一轮 runSyncRound→200 返回 round 结果；重复 URL 幂等更新）；`DELETE /api/sync/peers?url=`；`GET /api/sync/lan-address`（os.networkInterfaces() 首个非内环 IPv4 + ctx.listeningPort + workspaceId/nodeId，url 拼好返回）；`/api/sync/run` 缺省 peers 改为 store∪env 合并去重
4. **sync loop 改造**：L85-91「env 非空才启动」改为**无条件常驻**，每 tick 合并读取、空则跳过——否则运行中添加首个 peer 循环起不来
5. **前端**：NodeTab 二维码 `<QRCode value={JSON.stringify({v:1,ws,url})}/>` + 明文 URL；SyncTab = 已配对节点 Table（地址/nodeId/时间/移除）+ 立即同步 + 「添加节点」输入框（扫码枪是键盘设备直接可用；**不做摄像头扫码**——LAN http 非 secure context getUserMedia 被禁，二维码供手机读/誊录）；删"地址不持久化"文案，改"保存在服务端 data/peers.json"
6. 测试：双 app + `vi.stubGlobal('fetch')` 按 host 分发：添加成功落盘+round 结果；mismatch 422 不落盘；不可达 502；重复幂等；DELETE；normalize 各分支；/run 无 body 用合并源

## E. GitHub Actions 发布（P2）

| 文件 | 操作 |
|---|---|
| `.github/workflows/release.yml` | **新增** |
| `.github/workflows/ci.yml` | **新增**（顺带，push/PR 跑 typecheck+test） |

release.yml：`on: push: tags:['v*']`，`permissions: contents:write`，windows-latest：
checkout → setup-node@v4（node 22 + npm cache）→ dtolnay/rust-toolchain@stable → swatinem/rust-cache@v2（workspaces: packages/desktop/src-tauri）→ `npm ci` → 原样跑 `powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/build.ps1` → pwsh 生成 SHA256 到 dist/checksums.sha256 → softprops/action-gh-release@v2 上传 zip+exe+checksums。全部步骤 `shell: pwsh`。
说明：better-sqlite3 prebuild-install 免编译；NSIS 由 Tauri v2 bundler 自动下载；版本取自 package.json，发布前 bump 根 package.json 与 tauri.conf.json 再打 tag。

---

## 实现顺序

A（零风险先行，防 data/ 误提交）→ B（纯前端）→ C（最大块，context/index 改法为 D 铺路）→ D（复用 C 的 store 注入模式）→ E（独立，打包 A-D 成果）

## 验证

- 单测：`npm run test -w @one/server`、`npm run test -w @one/app`，最后根目录 `npm run test` 全绿
- 类型：`npm run typecheck`
- A 冒烟：删 packages/*/dist 后 `npm run dev:server` 应先构建再起服务
- B 冒烟：新 data 目录无 ai-config.json → ChatPage 见引导卡 → 跳转 → 保存 → 返回卡片消失
- C 冒烟：`$env:ONE_BACKUP_INTERVAL_MS='5000'; npm run dev:server`，观察 data/backups/ 每 5s 一个且只留 7 个；UI 备份/恢复/删除走通
- D 冒烟：两终端 ONE_PORT=3000/3001 同 workspace 各起一个 server → A 设置页二维码可见 → B 添加 A 地址 → 库存互见 → 重启 B peers 仍在
- E 冒烟：本地 `npm run package:desktop` 确认绿；推测试 tag 看 Actions 全链路与 Release 资产

## 风险与注意

- `:memory:` 库：backupDir/peersPath 沿用 null 语义；测试 mkdtemp 注入 + afterEach 清理
- PowerShell 无 `&&`；文档命令单行
- 桌面硬杀：temp+rename 保证原子性，WAL 不 checkpoint 不影响备份正确性（export 走同连接读一致状态）
- peers URL 必须 normalize 后再比较/落盘（防重复条目）
- E：npm ci 要求 lockfile 严格同步；tag 前 bump 两处 version
