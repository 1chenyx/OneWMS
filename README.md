# OneWMS · AI 驱动的个性化仓库管理系统

下载一个应用，用自然语言告诉 AI 你的仓储需求，AI 逐步把字段、流程、功能模块组装到位——形成一个完全属于你的 WMS。

## 核心特色

### 🗣️ 自然语言管理仓库
直接对话即可完成出入库、查询库存、盘点等操作。没有 AI 也能用：完整的表单/扫码界面开箱即用。

### 🤖 AI 是配置代理，不是"改代码的"
AI 永远拿不到 SQL 权限，它的所有操作分两条通道：
- **慢通道（改配置）**：AI 生成配置补丁 → 校验管线 → **人工确认** → 热应用，全程无需重启
- **快通道（改数据）**：Tool Calling 穿过工具总线，业务规则（库存不为负、状态机合法）是绕不过的墙

### 🧩 插件化内核，个性化是数据不是代码
模块（如保质期预警、拣货、批次）通过 manifest 声明自己提供的字段、工具与流程节点。个性化配置全部存为数据，可导出为迁移包，在设备间自由迁移。

### 📴 本地优先（Local-first）
每个节点都是完整系统，离线即普通软件。多节点通过事件账本（oplog）同步，局域网/VPN 组网内自动保持一致，无中心服务器依赖。

### 🖥️ 一套前端，多种形态
Tauri 桌面应用（约 46MB，内嵌 Node.js 运行时，无需安装环境）、浏览器访问本地服务，数据落在本地 SQLite。

## 功能一览

| 模块 | 说明 |
|---|---|
| 库存 / SKU / 往来单位 | 核心仓储能力 |
| 出库单 / 拣货 | 状态机驱动的流程引擎 |
| 盘点 | 库存核对 |
| 保质期预警 | 模块化扩展示例 |
| AI 对话 / 智能体 / 记忆 | 内置可配置的 AI 工作台 |

## 技术栈

TypeScript 单语言全栈 + Tauri（Rust 壳）：

- **内核 `@one/core`**：oplog 事件账本、字段注册表、工具总线、Profile 配置管线、模块系统、同步与迁移
- **领域 `@one/wms`**：仓储业务模块（以内核插件形式存在）
- **AI `@one/ai` + `@one/memory`**：Vercel AI SDK，云 API（OpenAI 兼容）与本地 Ollama 无缝切换
- **服务 `@one/server`**：Node.js HTTP + WebSocket
- **前端 `@one/app`**：React + JSON Schema 动态表单
- **桌面 `packages/desktop`**：Tauri 打包

## 只想用，不想装开发环境？

到 [Releases](../../releases) 页下载 Windows 版，二选一：

- `OneWMS-<版本>-setup-win-x64.exe`：双击安装（推荐）
- `OneWMS-<版本>-portable-win-x64.zip`：解压后双击 `OneWMS.exe` 即用，不改注册表

数据落在 `data/`（SQLite + JSON），自动备份在 `data/backups/`——默认每天一份、保留最近 7 份，含 AI 配置；设置页可随时手动备份/恢复。AI 需要在应用里「设置 → AI」填一次模型信息，不填也能正常用仓库功能（AI 入口关闭）。

多台设备共用一个仓库：在「设置 → 节点」页把自己的局域网地址给另一台设备（可直接扫二维码或抄地址），对方在「设置 → 局域网同步」里「添加节点」即可，配对关系保存在服务端，重启不丢。

## 快速开始

要求 Node.js >= 22。

```powershell
# 安装依赖
npm install

# 构建工作区包（dev 运行依赖 dist/ 产物；dev:server 的 predev 钩子也会自动执行）
npm run build

# 启动后端服务
npm run dev:server

# 另开终端，启动前端
npm run dev:app
```

配置 AI：复制 `.env.example` 为 `.env`，填入模型信息（支持智谱等 OpenAI 兼容云 API，或本地 Ollama）。不配置 AI 时系统照常运行，仅 AI 入口关闭。

打包桌面应用（本机）：

```powershell
npm run package:desktop
```

发布新版：把根 `package.json` 与 `packages/desktop/src-tauri/tauri.conf.json` 的 `version` 改成同一个新版本，提交后 `git tag v0.2.0` 并 `git push --tags`，GitHub Actions（`.github/workflows/release.yml`）会自动构建安装包 + 便携版并发布到 Release 页。push / PR 另有 `.github/workflows/ci.yml` 跑类型检查与全量单测。

## 更多文档

- [DESIGN.md](docs/DESIGN.md)：系统设计蓝图（架构、配置 DSL、AI 权限模型、同步机制）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：内核代码架构与依赖规则
