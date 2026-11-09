# OneWMS · AI 驱动的个性化仓库管理系统

> 下载一个应用，用自然语言告诉 AI 你的仓储需求，AI 逐步把字段、流程、功能模块组装到位——形成一个完全属于你的 WMS。

## 这是什么

一个**本地优先（Local-first）**的仓库管理系统：

- **离线即完整软件**：每个节点都是完整系统，数据落在本地 SQLite，不依赖任何中心服务器；
- **没有 AI 也能用**：完整的表单 / 扫码界面开箱即用，AI 只是增强；
- **个性化是数据不是代码**：模块通过 manifest 声明自己提供的字段、工具与流程节点，个性化配置全部存为数据，可导出为迁移包在设备间自由迁移。

## 核心特色

### 🗣️ 自然语言管理仓库

直接对话即可完成出入库、查询库存、盘点等操作：

> 「把刚才那 3 箱 A4 纸放进 2 号库区的 B-05 货位」

### 🤖 AI 是配置代理，不是「改代码的」

AI 永远拿不到 SQL 权限，它的所有操作分两条通道：

| 通道 | 用途 | 保护机制 |
|---|---|---|
| **慢通道（改配置）** | 隐藏字段、启用模块、调整流程 | AI 生成配置补丁 → 校验管线 → **人工确认** → 热应用，全程无需重启 |
| **快通道（改数据）** | 出入库、查询、盘点 | Tool Calling 穿过工具总线，业务规则（库存不为负、状态机合法）是绕不过的墙 |

### 📴 本地优先 + 多节点同步

多节点通过事件账本（oplog）同步，局域网 / VPN 组网内自动保持一致：

- **局域网**：在「设置 → 设备」页把自己的局域网地址给另一台设备（可直接扫二维码），对方「添加节点」即可，配对关系保存在服务端，重启不丢；
- **跨互联网**：用 Tailscale / WireGuard 等 VPN 组网后走同一套局域网协议。

### 🖥️ 一套前端，多种形态

Tauri 桌面应用（约 46MB，内嵌 Node.js 运行时，无需安装环境）、浏览器访问本地服务，数据统一落在本地 SQLite。

## 功能一览

| 模块 | 说明 |
|---|---|
| 库存 / SKU / 往来单位 | 核心仓储能力 |
| 出库单 / 拣货 | 状态机驱动的流程引擎 |
| 盘点 | 库存核对 |
| 保质期预警 | 模块化扩展示例 |
| AI 对话 / 智能体 / 记忆 | 内置可配置的 AI 工作台 |
| 多节点同步 | oplog 事件账本，局域网/VPN 组网直连 |

## 快速开始（开发）

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

配置 AI：复制 `.env.example` 为 `.env`，填入模型信息。支持两类 Provider：

```ini
# 云 API（OpenAI 兼容，如智谱）
ONE_AI_KIND=openai-compatible
ONE_AI_MODEL=glm-4
ONE_AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ONE_AI_API_KEY=你的key

# 或本地 Ollama（无需 key）
ONE_AI_KIND=ollama
ONE_AI_MODEL=qwen3:8b
```

不配置 AI 时系统照常运行，仅 AI 入口关闭（`/api/chat` 返回 503）。

## 下载使用（免开发环境）

到 [Releases](../../releases) 页下载 Windows 版，二选一：

- `OneWMS-<版本>-setup-win-x64.exe`：双击安装（推荐）
- `OneWMS-<版本>-portable-win-x64.zip`：解压后双击 `OneWMS.exe` 即用，不改注册表

数据落在 `data/`（SQLite + JSON），自动备份在 `data/backups/`——默认每天一份、保留最近 7 份，含 AI 配置；设置页可随时手动备份 / 恢复。

## 技术栈

TypeScript 单语言全栈 + Tauri（Rust 壳），npm workspaces monorepo：

| 包 | 职责 |
|---|---|
| `@one/core`（[packages/core](packages/core)） | 内核：oplog 事件账本、字段注册表、工具总线、Profile 配置管线、模块系统、同步与迁移 |
| `@one/wms`（[packages/wms](packages/wms)） | 仓储业务模块（以内核插件形式存在） |
| `@one/ai` + `@one/memory`（[packages/ai](packages/ai)、[packages/memory](packages/memory)） | Vercel AI SDK，云 API 与本地 Ollama 无缝切换；对话记忆固化 |
| `@one/server`（[packages/server](packages/server)） | Node.js HTTP + WebSocket |
| `@one/app`（[packages/app](packages/app)） | React + JSON Schema 动态表单 |
| `packages/desktop` | Tauri 桌面壳与打包脚本 |

单节点内部结构：

```
┌─────────────── 单节点应用（离线可用）───────────────┐
│  自然语言对话          表单/扫码界面（无 AI 也能用）  │
│      ↓                        ↓                     │
│  AI 编排层（意图→工具调用 · 需求→配置 DSL）           │
│      ↓                        ↓                     │
│  应用内核（模块注册表 | 流程引擎 | 工具总线）          │
│      ↓                                              │
│  可插拔领域模块（库存核心 | 批次 | 保质期 | 拣货 | …） │
│      ↓                                              │
│  SQLite（动态字段 JSON 列 + Oplog）                  │
│                         配置包 Profile（可导出迁移）  │
└─────────────────────────────────────────────────────┘
        ↓
  同步引擎（Oplog 交换 + 配置版本同步）
        ↓
  多节点网络（局域网直连 | VPN 组网）
```

## 打包桌面应用

本机打包（产物输出到 `dist/`）：

```powershell
npm run package:desktop          # 全量：安装包 + 便携版
npm run package:desktop:fast     # 仅便携版（跳过 NSIS，快）
```

产物：

- `dist/OneWMS-<版本>-portable-win-x64.zip` —— 便携版，解压即用
- `dist/OneWMS-<版本>-setup-win-x64.exe` —— NSIS 安装包
- `dist/latest.json` —— 自动更新清单（有签名私钥时生成）

## 发布新版

把根 [package.json](package.json)、[packages/desktop/src-tauri/tauri.conf.json](packages/desktop/src-tauri/tauri.conf.json) 与 [packages/desktop/src-tauri/Cargo.toml](packages/desktop/src-tauri/Cargo.toml) 的 `version` 改成同一个新版本（漏改会被构建脚本的版本一致性断言拦下），提交后：

```powershell
git tag v0.2.0
git push --tags
```

GitHub Actions（[.github/workflows/release.yml](.github/workflows/release.yml)）会自动构建安装包 + 便携版 + `latest.json` + 校验和并发布到 Release 页；push / PR 另有 [ci.yml](.github/workflows/ci.yml) 跑类型检查与全量单测。

## 更多文档

- [DESIGN.md](docs/DESIGN.md)：系统设计蓝图（架构、配置 DSL、AI 权限模型、同步机制）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：内核代码架构与依赖规则
