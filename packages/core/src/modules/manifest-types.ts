/**
 * 模块清单（ModuleManifest）的纯类型（DESIGN.md §6.1 的 v1 子集，裁剪见表 ARCHITECTURE.md「模块系统」）。
 *
 * 本文件是基础层：只有类型、词表与版本常量，无运行时逻辑、无 IO。
 * entity / workflowId / 事件名对内核是不透明键（领域隔离铁律）。
 */
import type { FieldSharing } from '../registry/key-naming.js';
import type { ProfileFieldType, WorkflowEffect } from '../profile/profile-types.js';
import type { ParameterSchema } from '../bus/schema-validator.js';

/** 内核版本（与 packages/core/package.json 的 version 保持同步——手写纪律，minCoreVersion 的比较基准） */
export const CORE_VERSION = '0.1.0';

/** 能力词表（§6.3 capabilities 沙箱的 v1 形态：声明 + 安装校验 + 审计；运行时供给是 v2 WASM 接缝） */
export const MODULE_CAPABILITIES = [
  'db.read',
  'db.write',
  'events.subscribe',
  'events.publish',
  'tools.register',
  'jobs.register',
] as const;

export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number];

/**
 * 声明式模块的实体 id 命名空间前缀（B.1）。
 *
 * 为什么用点分前缀而不是放宽内置正则：内置实体 id 受 RECORD_ID_RE（不含点号）约束，
 * 所以 `dyn.` 开头的 id 结构上不可能与任何内置实体撞名——两条命名规则各自独立演进，
 * 互不污染。完整形态 `dyn.{moduleId}.{recordId}`，校验见 manifest-validate.ts。
 */
export const DYN_RECORD_PREFIX = 'dyn.';

/**
 * 声明式模块的页面 id 命名空间前缀（B.6）。
 *
 * 与 `dyn.` 同一个理由：前端内置页面 key 是裸单词（skus/inventory/…），
 * 所以 `ui.` 开头的 key 结构上不可能撞上任何一个内置页面。
 * 完整形态 `ui.{moduleId}.{pageId}`，校验见 manifest-validate.ts。
 */
export const UI_PAGE_PREFIX = 'ui.';

/**
 * 页面种类白名单（B.6）。
 *
 * 只有 `record-list`：一种「服务端描述、前端通用组件渲染」的页面形态。
 * 白名单而不是自由字符串——前端拿到未知 kind 只能整页兜底，等于白配；
 * 新增形态要同时在 core 词表与 app 渲染器各加一处，两侧都编译期可见。
 */
export const UI_PAGE_KINDS = ['record-list'] as const;

export type UiPageKind = (typeof UI_PAGE_KINDS)[number];

/** manifest 字段分区：provides 声明（§7.1：不存在则创建并成为 owner） */
export interface ManifestFieldProvide {
  entity: string;
  key: string;
  label: string;
  type: ProfileFieldType;
  /** 缺省 shared；private 自动加模块前缀消撞名（§7.2） */
  sharing?: FieldSharing;
  description?: string;
}

/** manifest 字段分区：requires 声明（§7.1：依赖既有字段 + 期望类型，安装期冲突检测执行点） */
export interface ManifestFieldRequire {
  entity: string;
  key: string;
  sharing?: FieldSharing;
  expectType?: ProfileFieldType;
}

/**
 * 固定列的一列。不是扩展字段，不能用 profile.propose 增删。
 *
 * type / queryable 是 B.1 为声明式模块新增的可选字段：
 *  - 内置模块的固定列由真实建表语句定义，列类型是代码事实，写在这里只会造成两份真相
 *    → 内置 manifest 不声明（缺省即「由代码决定」）；
 *  - 声明式模块没有建表语句，列类型必须靠 manifest 说清（存 JSON、校验入参、拼装 AI 描述）；
 *  - queryable=true 的列才会在 dyn_index 落索引行（B.2）——索引表按行存储，
 *    不加这个开关就等于「每个字段都建一条索引」，写入放大且没人查。
 */
export interface ManifestRecordField {
  key: string;
  label: string;
  description?: string;
  /** 列的数据类型（声明式模块必填语义，见上；白名单 = ProfileFieldType） */
  type?: ProfileFieldType;
  /** 是否建索引以支持过滤查询（仅声明式模块的记录存储消费，B.2） */
  queryable?: boolean;
}

/**
 * 业务对象的固定列。
 * profile.field.query 用它回答「某某有哪些字段」。
 * 只从已安装模块收集；id、label、aliases 都能当作 entity 传入。
 */
export interface ManifestRecord {
  /** 稳定 id，如 inventory。查询时大小写不敏感 */
  id: string;
  /** 中文名，如 库存。也可当作 entity 传入 */
  label: string;
  aliases?: string[];
  /** 给模型的说明：这些列能不能配置、和扩展字段怎么区分 */
  note?: string;
  fields: ManifestRecordField[];
}

/** manifest 工具分区：暴露给 AI/界面的操作声明（handler 注册在代码装载期，安装期与总线事实比对） */
export interface ManifestTool {
  /** 命名空间.动词.名词（owner 模块前缀，§6 事件/工具命名空间规则） */
  id: string;
  label: string;
  /** 给 AI 看的描述——质量决定 Tool Calling 准确性（§6.3 决策 1） */
  description: string;
  parameters: ParameterSchema;
  permission: 'read' | 'write';
}

/**
 * manifest 界面分区的一个页面（B.6：SDUI 主链路）。
 *
 * ⚠️ category / icon 是**字符串**而不是词表枚举：core 是领域无关层，
 *    导航大类与图标库都是 `packages/app` 的知识，这里 import 就是反向依赖。
 *    前端按白名单映射（未知 category → 「档案」大类，未知 icon → 默认图标），
 *    所以模块写错顶多是长得不对，不会崩、也不会消失。
 */
export interface ManifestUiPage {
  /** 稳定页面 key，须为 `ui.{moduleId}.{pageId}`（见 UI_PAGE_PREFIX） */
  id: string;
  /** 中文页面名（导航浮窗与页面标题都用它） */
  label: string;
  /** 页面形态（白名单见 UI_PAGE_KINDS） */
  kind: UiPageKind;
  /**
   * kind='record-list' 必填：本页面渲染哪个实体。
   * 必须指向**同一份 manifest 的 records 里已声明**的 id——跨模块指别人的实体，
   * 页面就会在「那个模块被卸载」后指向空气（校验期拒绝，不留运行时惊喜）。
   */
  record?: string;
  /** 归入前端哪个导航大类（前端白名单映射，未知归「档案」） */
  category?: string;
  /** 图标名（前端白名单映射 antd 图标，未知用默认图标） */
  icon?: string;
  /** 给用户的页面说明（导航浮窗副标题） */
  description?: string;
}

/** manifest 界面分区：模块声明「我要哪些页面」，渲染由前端通用组件完成（B.6） */
export interface ManifestUi {
  pages?: ManifestUiPage[];
}

/** 模块声明的一条转移。effect 可选；安装时内核盖上 providedBy */
export interface ManifestWorkflowTransition {
  from: string;
  to: string;
  when?: string;
  effect?: WorkflowEffect;
}

/** manifest 流程分区：贡献（§6.3 模块永不替换流程，只做贡献；同 id 状态冲突安装时拒绝） */
export interface ManifestContribution {
  states: { id: string; label: string }[];
  transitions: ManifestWorkflowTransition[];
}

/**
 * 模块清单（DESIGN.md §6.1 全景的 v1 子集）。
 * - signature 恒 null（v1 本地模块无签名，DESIGN §10 冻结决策）；
 * - jobs / entry / rules 不实现（无 v1 消费方，v2 生长点）；
 * - ui 自 B.6 起实现（SDUI：服务端描述页面，前端通用组件渲染）；
 * - workflows.base 是本实现新增：领域基线流程种子（目标流程不存在才生效）——
 *   「内核基础」由领域包提供（core 领域无关），core.wms 的特权，守卫保证不覆盖既有配置。
 */
export interface ModuleManifest {
  /** 模块 id（命名空间风格，如 'module.expiry' / 'core.wms'；owner 归属与事件命名空间的前缀源） */
  id: string;
  name: string;
  /** 一等公民：AI 组装的匹配逻辑 = 用户自然语言 ↔ description（§6.3） */
  description: string;
  version: string;
  /** 最低内核版本（semver，安装期硬校验） */
  minCoreVersion?: string;
  /** v1 恒 null（占位，§10 冻结决策） */
  signature?: null;
  capabilities: ModuleCapability[];

  /** 择一型冲突的解法（§7.2）：同槽位恰好一个占位者，UI 呈现为切换而非叠加 */
  slot?: { name: string };

  dependencies?: {
    /** 依赖模块 id 清单（安装期必须已装且 enabled；单装模型下循环依赖结构性不可能） */
    modules?: string[];
  };

  fields?: {
    provides?: ManifestFieldProvide[];
    requires?: ManifestFieldRequire[];
  };

  /**
   * 固定列。不是扩展字段，不能用 profile.propose 增删。
   * 用户问「某某有哪些字段」时，profile.field.query 从这里回答。
   *
   * B.1 起声明式模块也能提供 records——但整份 manifest 必须经
   * `dyn.module.register` 提案走人工确认，且实体 id 必须落在
   * `dyn.{moduleId}.{recordId}` 命名空间内（见 DYN_RECORD_PREFIX）。
   * 内置模块用裸 id（如 inventory），两者由 manifest-validate 分别校验。
   */
  records?: ManifestRecord[];

  /**
   * profile.module.query 也能用这些词找到本模块。
   * 中文名 name 本身已经能匹配，这里只放简称。
   */
  aliases?: string[];

  /**
   * 流程 id → 查询别名。不写入 Profile，不能用 patch 改。
   * profile.workflow.query 用它认「入库」「出库」。
   */
  workflowAliases?: Record<string, string[]>;

  tools?: ManifestTool[];

  /**
   * 界面分区（B.6）。页面描述由 GET /api/ui/pages 组装下发（含内联列定义），
   * 前端按 kind 挑通用渲染器——模块不提交代码就能长出可用的管理页。
   */
  ui?: ManifestUi;

  events?: {
    /** 事件命名空间 `模块.事件名`（§6.3）；v1 只做声明，不做前缀强校验（无路由消费方） */
    subscribes?: string[];
    publishes?: string[];
  };

  workflows?: {
    /** 基础流程种子（本实现新增）：逐流程守卫——目标流程不存在才装 */
    base?: Record<string, { states: { id: string; label: string }[]; transitions: ManifestWorkflowTransition[] }>;
    /** 贡献：向既有流程叠加状态与转移（目标流程必须已存在） */
    contributes?: Record<string, ManifestContribution>;
  };

  settings?: {
    /** 参数定义 + 默认值（校验、表单渲染、AI 上下文三用一份 schema，§5.4） */
    schema: ParameterSchema;
  };
}

/** 已安装模块的聚合视图（modules 段状态 + 进程目录 manifest 元数据） */
export interface InstalledModule {
  id: string;
  enabled: boolean;
  version: string;
  settings: Record<string, unknown>;
  /** 进程目录在场的 manifest 元数据（远端同步来的安装记录可能无本地代码——manifest 缺席） */
  manifest?: ModuleManifest;
}

/** 模块生命周期审计事件的 payload 形状（module.installed / module.uninstalled，§8.2 事件目录） */
export interface ModuleLifecyclePayload {
  id: string;
  name?: string;
  version: string;
  capabilities?: ModuleCapability[];
}
