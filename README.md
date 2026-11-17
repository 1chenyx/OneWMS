# OneWMS · AI 驱动的个性化仓库管理系统

中文 | [English](README.en.md)

> 下载一个应用，用自然语言告诉 AI 你的仓储需求，AI 逐步把字段、流程、功能模块组装到位——形成一个完全属于你的 WMS。

![OneWMS AI 对话：一句话查低库存，AI 自动调用工具并汇总回答](docs/images/ai-chat-inventory.gif)

## 这是什么

一个**本地优先（Local-first）**的仓库管理系统。它看起来是一个标准的 WMS 应用——看板、作业、档案、智能助手、系统五大功能区——但内核完全不同：

- **离线即完整软件**：每个节点都是完整系统，数据落在本地 SQLite，不依赖任何中心服务器；
- **没有 AI 也能用**：完整的表单 / 扫码界面开箱即用，AI 只是增强；
- **用对话查库管库**：在「智能助手」里说一句「帮忙查一下库存」，AI 自己决定调哪些工具、按 SKU 汇总返回结果（总量、批次、库位占用、预警建议），出入库、盘点同样一句话完成；
- **个性化是数据不是代码**：模块通过 manifest 声明自己提供的字段、工具与流程节点，个性化配置全部存为数据，可导出为迁移包在设备间自由迁移。

## 核心特色

### 🗣️ 自然语言管理仓库

对话即操作。AI 走 Tool Calling 穿过工具总线，每一次查询 / 写库都是真实业务调用，不是拼 SQL：

> 「帮忙查一下库存，哪些商品低于安全库存了？」
> 「把刚才那 3 箱 A4 纸放进 2 号库区的 B-05 货位」
> 「给 OUT-20261117-0001 组个波次开始拣货」

![AI 对话查库存：展示工具调用过程与汇总回答](docs/images/15-chat-inventory.png)

### 🤖 AI 是配置代理，不是「改代码的」

AI 永远拿不到 SQL 权限，它的所有操作分两条通道：

| 通道 | 用途 | 保护机制 |
|---|---|---|
| **慢通道（改配置）** | 隐藏字段、启用模块、调整流程 | AI 生成配置补丁 → 校验管线 → **人工确认弹窗** → 热应用，全程无需重启 |
| **快通道（改数据）** | 出入库、查询、盘点 | Tool Calling 穿过工具总线，业务规则（库存不为负、状态机合法）是绕不过的墙 |

改配置的请求会弹出确认窗，写明「要改成什么样、有什么影响」，拍板权始终在人手里：

![慢通道：AI 提出配置变更，人工确认后热应用](docs/images/16-ai-propose.png)

### 📴 本地优先 + 多节点同步

多节点通过事件账本（oplog）同步，局域网 / VPN 组网内自动保持一致：

- **局域网**：在「设置 → 设备」页把自己的局域网地址给另一台设备（可直接扫二维码），对方「添加节点」即可，配对关系保存在服务端，重启不丢；
- **跨互联网**：用 Tailscale / WireGuard 等 VPN 组网后走同一套局域网协议。

![设置页：连接方式、本节点信息与已配对设备](docs/images/12-settings.png)

### 🧩 模块可插拔，能力按需开

21 个内置模块（上架、质检、波次、拣货、复核、打包、装车、序列号、托盘、补货、报损、效期……）各自声明字段 / 工具 / 流程节点，启用即生效、停用即收回，导航与表单随之变化：

![模块页：内置模块清单与启停开关](docs/images/11-modules.png)

### 🖥️ 一套前端，多种形态

Tauri 桌面应用（约 46MB，内嵌 Node.js 运行时，无需安装环境）、浏览器访问本地服务，数据统一落在本地 SQLite。

## 界面速览

| 运营看板：库存 / 作业 / 进出 / 异常四块一屏 | 作业台：以流程待办为入口 |
|---|---|
| ![运营看板](docs/images/01-dashboard.png) | ![作业台](docs/images/14-workbench.png) |

| 库存：余量 / 冻结 / 预占 / 批次一目了然 | 效期看板：过期 / 紧急 / 预警分级 |
|---|---|
| ![库存](docs/images/02-inventory.png) | ![效期看板](docs/images/08-expiry.png) |

| 入库单：状态机驱动的收货流程 | 出库单：从创建到发运 |
|---|---|
| ![入库单](docs/images/03-inbound.png) | ![出库单](docs/images/04-outbound.png) |

| 波次：多单合并拣货 | 拣货单：按位拣货回执 |
|---|---|
| ![波次](docs/images/05-wave.png) | ![拣货单](docs/images/06-picking.png) |

| 盘点：明盘 / 盲盘与差异处理 | SKU 档案：动态字段由配置决定 |
|---|---|
| ![盘点](docs/images/07-stocktake.png) | ![SKU 管理](docs/images/09-skus.png) |

| 库位管理：库区 → 库位树 | 对接：外部系统绑定 |
|---|---|
| ![库位管理](docs/images/10-locations.png) | ![对接](docs/images/13-integrations.png) |

## 功能一览

| 功能区 | 页面 |
|---|---|
| 看板 | 运营看板、效期看板、报表 |
| 作业 | 作业台、入库单、质检、上架、出库单、波次、拣货单、复核、打包、装车、库存、序列号、托盘、盘点、调拨单、报损单 |
| 档案 | SKU 管理、库位管理、往来单位、条码标签 |
| 智能助手 | AI 对话、助手管理、AI 记忆、AI 模型 |
| 系统 | 流程、规则、模块、对接、设置 |

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

到 [Releases](https://github.com/1chenyx/OneWMS/releases) 页下载 Windows 版，二选一：

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

GitHub Actions（`.github/workflows/release.yml`）会自动构建安装包 + 便携版 + `latest.json` + 校验和并发布到 Release 页；push / PR 另有 `ci.yml` 跑类型检查与全量单测。

## 更多文档

- [DESIGN.md](docs/DESIGN.md)：系统设计蓝图（架构、配置 DSL、AI 权限模型、同步机制）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：内核代码架构与依赖规则
