/**
 * 模块清单（ModuleManifest）的纯类型（DESIGN.md §6.1 的 v1 子集，裁剪见表 ARCHITECTURE.md「模块系统」）。
 *
 * 本文件是基础层：只有类型、词表与版本常量，无运行时逻辑、无 IO。
 * entity / workflowId / 事件名对内核是不透明键（领域隔离铁律）。
 */
import type { FieldSharing } from '../registry/key-naming.js';
import type { ProfileFieldType } from '../profile/profile-types.js';
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

/** manifest 流程分区：贡献（§6.3 模块永不替换流程，只做贡献；同 id 状态冲突安装时拒绝） */
export interface ManifestContribution {
  states: { id: string; label: string }[];
  transitions: { from: string; to: string; when?: string }[];
}

/**
 * 模块清单（DESIGN.md §6.1 全景的 v1 子集）。
 * - signature 恒 null（v1 本地模块无签名，DESIGN §10 冻结决策）；
 * - ui / jobs / entry / rules 不实现（无 v1 消费方，v2 生长点）；
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

  tools?: ManifestTool[];

  events?: {
    /** 事件命名空间 `模块.事件名`（§6.3）；v1 只做声明，不做前缀强校验（无路由消费方） */
    subscribes?: string[];
    publishes?: string[];
  };

  workflows?: {
    /** 基础流程种子（本实现新增）：逐流程守卫——目标流程不存在才装 */
    base?: Record<string, { states: { id: string; label: string }[]; transitions: { from: string; to: string; when?: string }[] }>;
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
