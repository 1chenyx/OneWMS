# OneWMS 常用命令速查

> 环境：Windows + PowerShell 5.1，Node.js **>= 22**，npm workspaces monorepo。
> **PowerShell 不支持 `&&`**，需要连着执行请用 `;` 分隔，或者分行执行。
> 除特别说明外，所有命令都在仓库根目录 `d:\my_project\demo\OneWMS` 下执行。

---

## 0. 环境准备

```powershell
node -v                    # 需要 >= 22
npm -v
rustc --version            # 仅打包桌面版需要（Tauri）
cargo --version

npm install                # 首次拉代码 / 依赖变更后安装
npm ci                     # 干净安装（严格按 package-lock，CI 用这个）
```

配置 AI（可选，不配也能跑，仅 `/api/chat` 返回 503）：

```powershell
Copy-Item .env.example .env
notepad .env               # 填 ONE_AI_KIND / ONE_AI_MODEL / ONE_AI_BASE_URL / ONE_AI_API_KEY
```

---

## 1. 编译 / 构建

```powershell
# 全量构建六个包（core → wms → memory → ai → server → app）
npm run build

# 只构建单个包（其 pre* 钩子会自动先构建它依赖的包）
npm run build -w @one/core
npm run build -w @one/wms
npm run build -w @one/memory
npm run build -w @one/ai
npm run build -w @one/server
npm run build -w @one/app          # tsc --noEmit + vite build，产物在 packages/app/dist

# 只做类型检查，不出产物
npm run typecheck
npm run typecheck -w @one/app
```

**注意**：`dev` 运行依赖各包的 `dist/` 产物。改了 core/wms/memory/ai 的源码后，
要么重跑 `npm run build`，要么重启 `dev:server`（它的 `predev` 会自动构建这四个包）。

---

## 2. 启动后端（@one/server）

```powershell
# 开发模式：tsx watch 热重载，自动读根目录 .env，自动先构建依赖包
npm run dev:server
```

启动成功日志形如：

```
[one-server] http://localhost:3000  workspace=default  db=data/onewms.db  ai=glm-4
[one-server] 局域网地址：http://192.168.x.x:3000  ← 另一台设备「添加节点」填这个
```

生产模式（跑已编译的 `dist/`，无热重载）：

```powershell
npm run build -w @one/server
npm run start -w @one/server
```

临时改端口 / 数据库路径（PowerShell 环境变量只对当前会话生效）：

```powershell
$env:ONE_PORT = 4000
$env:ONE_DB_PATH = "data/test.db"
npm run dev:server

Remove-Item Env:ONE_PORT           # 用完清掉
Remove-Item Env:ONE_DB_PATH
```

常用环境变量（完整清单见 [.env.example](../.env.example)）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ONE_PORT` | `3000` | HTTP / WebSocket 端口 |
| `ONE_DB_PATH` | `data/onewms.db` | SQLite 路径 |
| `ONE_WORKSPACE` | `default` | 工作区 ID |
| `ONE_AI_KIND` | — | `openai-compatible` 或 `ollama` |
| `ONE_AI_MODEL` | — | 缺省则 AI 入口关闭 |
| `ONE_BACKUP_KEEP` | `7` | 自动备份保留份数 |
| `ONE_SYNC_INTERVAL_MS` | `30000` | 多节点后台同步间隔 |

健康检查：

```powershell
Invoke-RestMethod http://localhost:3000/api/health
curl.exe http://localhost:3000/api/sync/lan-address     # 看本机局域网地址
```

---

## 3. 启动前端（@one/app）

**另开一个终端**（后端要在跑）：

```powershell
npm run dev:app
```

- Vite 开发服务器：<http://localhost:5173>
- `/api` 已代理到 `http://localhost:3000`，无需处理 CORS
- `@one/core` 走源码 alias（仅供 `import type`，前端不共享运行时）

只想用构建好的前端 + 后端同源访问（不起 Vite）：

```powershell
npm run build -w @one/app
npm run dev:server
# 然后浏览器打开 http://localhost:3000 —— server 会自动托管 packages/app/dist
```

---

## 4. 前后端一起起（开两个窗口）

```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','npm run dev:server'
Start-Process powershell -ArgumentList '-NoExit','-Command','npm run dev:app'
```

关掉占着端口的进程：

```powershell
Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess
Stop-Process -Id <上面查到的PID> -Force

# 或者一次性看两个端口
Get-NetTCPConnection -LocalPort 3000,5173 -State Listen
```

---

## 5. 测试

```powershell
# 全量单测（六个包）
npm run test

# 单包
npm run test -w @one/core
npm run test -w @one/wms
npm run test -w @one/server
npm run test -w @one/app

# 单个文件 / 按名字过滤（-- 后面透传给 vitest）
npm run test -w @one/server -- test/api.test.ts
npm run test -w @one/core -- test/oplog.test.ts
npm run test -w @one/wms -- -t "出库单"          # 按用例名过滤

# watch 模式（改文件即重跑）
npm run test -w @one/core -- --watch
```

提交前跑一遍 CI 同款校验：

```powershell
npm run typecheck ; npm run test
```

---

## 6. 桌面版（Tauri）

```powershell
# 只组装服务端运行时载荷（不打包），产物：packages/desktop/src-tauri/resources/server
powershell -NoProfile -ExecutionPolicy Bypass -File packages\desktop\stage.ps1

# 全量打包：NSIS 安装包 + 便携版
npm run package:desktop

# 快速打包：仅便携版（跳过 NSIS，日常验证用这个）
npm run package:desktop:fast
```

产物在仓库根 `dist/`：

| 文件 | 说明 |
|---|---|
| `OneWMS-<版本>-portable-win-x64.zip` | 便携版压缩包，解压即用 |
| `OneWMS-portable\OneWMS.exe` | 便携版可直接双击运行 |
| `OneWMS-<版本>-setup-win-x64.exe` | NSIS 安装包 |
| `latest.json` | 自动更新清单（有签名私钥时才生成） |

调试桌面壳（Rust 侧改动）：

```powershell
cd packages\desktop\src-tauri
cargo run --release          # 或 cargo build
cd ..\..\..
```

---

## 7. 数据与备份

```powershell
# 数据库与运行时数据（开发态在仓库根 data/）
ls data
ls data\backups              # 自动备份，默认每天一份、保留 7 份

# 清空开发数据（不可恢复，先确认备份）
Remove-Item data -Recurse -Force

# 便携版的数据在 exe 同级 data/ 目录
ls dist\OneWMS-portable\data
```

手动备份 / 恢复也可以走页面：「设置 → 备份」。

---

## 8. 发布新版

先把三处 `version` 改成同一个新版本（漏改会被构建脚本的版本一致性断言拦下）：

- [package.json](../package.json)
- [packages/desktop/src-tauri/tauri.conf.json](../packages/desktop/src-tauri/tauri.conf.json)
- [packages/desktop/src-tauri/Cargo.toml](../packages/desktop/src-tauri/Cargo.toml)

```powershell
npm run package:desktop            # 本地先验一遍能打出包
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push
git push --tags                    # 推 tag 触发 GitHub Actions 自动发布
```

---

## 9. Git 常用

```powershell
git status
git diff
git log --oneline -15
git branch -a

git checkout -b feat/xxx
git add packages/wms
git commit -m "feat(wms): xxx"
git push -u origin feat/xxx
```

---

## 10. 排错

| 现象 | 处理 |
|---|---|
| `Cannot find module '@one/core'` 或类型报错 | 依赖包没构建：`npm run build` |
| `better-sqlite3` 报 ABI / NODE_MODULE_VERSION 不匹配 | Node 版本变了，重装原生模块：`npm rebuild better-sqlite3` |
| 端口 3000 / 5173 被占用 | 见第 4 节的 `Get-NetTCPConnection` + `Stop-Process` |
| 页面能开但 AI 对话报 503 | `.env` 没配 `ONE_AI_MODEL`，或页面「设置 → AI」里的配置覆盖了 env |
| 改了 `.env` 不生效 | 重启 `dev:server`（env 只在启动时读一次） |
| 前端改动没生效 | 确认访问的是 5173（Vite）而不是 3000（托管的是 `app/dist` 旧产物，需重新 `build -w @one/app`） |
| 打包报版本不一致 | 三处 version 对齐，见第 8 节 |
| `tauri build` 找不到 cargo | 把 `$env:USERPROFILE\.cargo\bin` 加进 PATH（`build.ps1` 已自动处理） |

---

## 附：最高频的几条

```powershell
npm install
npm run build
npm run dev:server          # 终端 1：后端 → http://localhost:3000
npm run dev:app             # 终端 2：前端 → http://localhost:5173
npm run typecheck ; npm run test
npm run package:desktop:fast
```
